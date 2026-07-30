import type { SyscallEvent } from './events'
import type { RaspCategory } from './project-store'
import type { CorrelateKey, Rule, RuleField, RuleStep } from './rasp-rules'
import { argNum } from './rasp-rules'
import type { Frame } from './rasp-attribution'
import { anchorFrame, correlationKey, targetOf } from './rasp-attribution'

export interface ResolvedHit {
  target: string
  category: RaspCategory
  confidence: number
  rationale: string
  offset: string        // module-relative hex, or '[unmapped]'
}

export interface OffsetHit {
  offset: string
  occurrences: number
}

export interface Suggestion {
  target: string
  category: RaspCategory
  confidence: number
  rationale: string
  occurrences: number   // completed sequences
  offsets: OffsetHit[]  // distinct call sites, the expandable children
}

export interface RawHit {
  ruleId: string
  target: string
  frame: Frame | null   // the anchor (step 0) call site; null when it has no module
  pid: number
  category: RaspCategory
  confidence: number
  rationale: string
}

// Composite map keys. NUL cannot occur in a rule id, a correlate mode or a node
// id, so no two distinct pairs can collide (a rule id may contain a space).
const KEY_SEP = '\u0000'
function streamKey(mode: CorrelateKey, key: string): string { return `${mode}${KEY_SEP}${key}` }
function partialKey(ruleId: string, key: string): string { return `${ruleId}${KEY_SEP}${key}` }

interface PartialMatch {
  nextStep: number
  atCount: number       // key-local event count when the previous step matched
  stream: string        // streamKey() of the correlation stream this rides on
  pk: string            // partialKey() of the list holding it
  maxGap: number        // its rule's maxGap, so a sweep needs no rule lookup
  dead: boolean         // already retired; its slot in the age queue is stale
  target: string
  frame: Frame | null
  pid: number
}

// Sweep at most once every this many push() calls so `partials` cannot grow
// without bound on a long run of short-lived correlation keys, while a sweep
// (which is O(live)) still costs amortised O(1) per event.
const SWEEP_EVERY = 4096
// Compact the age queue only once it is longer than this, so the copy it makes
// is paid for by enough opens to stay amortised O(1).
const COMPACT_ABOVE = 4096

export interface SequenceMatcherOptions {
  sweepEvery?: number
  compactAbove?: number
}

// Ordered-sequence matcher over an id-ordered event stream. Stateful so it can be
// driven page by page (the candidate set is never materialised whole), pure in the
// sense that the same ordered input always yields the same output.
//
// Per event, per rule: advance at most one in-flight partial (the oldest), else
// open a new one on step 0. A completed match is consumed, so one anchor reports
// one occurrence no matter how many later events would also satisfy the last step.
//
// Distance is counted in RULE-RELEVANT events: a rule's maxGap is how many events
// that match some rule step and share this correlation key may fall between two
// consecutive steps. That is exactly what the store feeds in (the DuckDB
// prefilter admits only candidate rows). Note "some rule step", not "some step
// of this rule": a correlation stream is bumped once per event for every rule
// sharing that key, so an event matching a DIFFERENT enabled rule's step on the
// same key does consume this rule's window. Which enabled rules the matcher was
// built with therefore affects what a given rule matches.
//
// In-flight partials are capped. At the cap the matcher forgets its oldest
// partial to make room, counting it in `dropped` - never refusing new ones,
// which would go blind for the rest of the run once churning keys (a short-lived
// tid opens a partial and never speaks again) filled the cap. Expired partials
// are reclaimed by the periodic sweep, which is throttled so a saturated cap
// costs O(1) per event rather than O(cap).
export class SequenceMatcher {
  private hits: RawHit[] = []
  private dropped = 0
  private live = 0
  private pushes = 0
  private sweptAt = 0                                   // this.pushes at the last sweep
  private sweeps = 0                                    // sweeps performed, for tests
  private counts = new Map<string, number>()            // stream key -> events seen
  private partials = new Map<string, PartialMatch[]>()  // partial key -> in flight
  private ages: PartialMatch[] = []                     // open order, for eviction
  private agesHead = 0                                  // first not-yet-considered slot
  private sweepEvery: number
  private compactAbove: number

  constructor(private rules: Rule[], private cap = 10000, opts: SequenceMatcherOptions = {}) {
    this.sweepEvery = Math.max(1, opts.sweepEvery ?? SWEEP_EVERY)
    this.compactAbove = opts.compactAbove ?? COMPACT_ABOVE
  }

  // Sweeps performed so far. Exposed so a test can pin the reclaim work done at
  // a saturated cap without timing anything.
  get sweepCount(): number { return this.sweeps }

  push(e: SyscallEvent): void {
    this.pushes++
    if (this.pushes - this.sweptAt >= this.sweepEvery) this.sweep()
    const keys = new Map<CorrelateKey, string | null>()
    const keyOf = (mode: CorrelateKey): string | null => {
      if (!keys.has(mode)) keys.set(mode, correlationKey(mode, e))
      return keys.get(mode)!
    }

    // Bump each distinct correlation stream once for this event, before matching,
    // so gap distance is measured in key-local events.
    const bumped = new Set<string>()
    for (const r of this.rules) {
      const k = keyOf(r.correlate)
      if (k === null) continue
      const ck = streamKey(r.correlate, k)
      if (bumped.has(ck)) continue
      bumped.add(ck)
      this.counts.set(ck, (this.counts.get(ck) ?? 0) + 1)
    }

    for (const r of this.rules) {
      const k = keyOf(r.correlate)
      if (k === null) continue
      const sk = streamKey(r.correlate, k)
      const n = this.counts.get(sk)!
      const pk = partialKey(r.id, k)
      const list = this.partials.get(pk)
      let advanced = false

      if (list && list.length > 0) {
        // `kept` is allocated only once something actually leaves the list; an
        // advance mutates its partial in place, so the array is unchanged and
        // the map entry does not need rewriting. This is the hottest path.
        let kept: PartialMatch[] | null = null
        for (let i = 0; i < list.length; i++) {
          const p = list[i]
          let drop = false
          if (n - p.atCount - 1 > r.maxGap) { this.retire(p); drop = true }   // expired
          else if (!advanced && matchOne(r.steps[p.nextStep], e)) {
            advanced = true
            p.nextStep++
            p.atCount = n
            if (p.nextStep === r.steps.length) {
              this.emit(r, p.target, p.frame, p.pid)
              this.retire(p)
              drop = true
            }
          }
          if (drop) {
            if (kept === null) kept = list.slice(0, i)
            continue
          }
          if (kept !== null) kept.push(p)
        }
        if (kept !== null) {
          if (kept.length === 0) this.partials.delete(pk)
          else this.partials.set(pk, kept)
        }
      }

      if (advanced) continue
      if (!matchOne(r.steps[0], e)) continue
      const target = targetOf(e)
      if (target === null) continue
      if (r.steps.length === 1) { this.emit(r, target, anchorFrame(e), e.pid); continue }
      // Expiry is otherwise lazy (it needs another event on the same rule+key), so
      // a partial on a key that goes silent would hold its slot forever and the
      // cap would become a permanent block. `evictOldest` alone guarantees a free
      // slot in amortised O(1); reclaiming expired partials is the throttled
      // periodic sweep's job, because sweeping here would be O(live) on every
      // event once the cap saturates.
      if (this.live >= this.cap) {
        if (!this.evictOldest()) { this.dropped++; continue }
        this.dropped++
      }
      this.live++
      const p: PartialMatch = {
        nextStep: 1, atCount: n, stream: sk, pk, maxGap: r.maxGap, dead: false,
        target, frame: anchorFrame(e), pid: e.pid,
      }
      const open = this.partials.get(pk) ?? []
      open.push(p)
      this.partials.set(pk, open)
      this.ages.push(p)
    }
  }

  // Remove a partial from the live accounting. Its caller drops it from its list;
  // the age queue only learns about it through `dead`.
  private retire(p: PartialMatch): void {
    p.dead = true
    this.live--
  }

  // Drop every partial whose stream has moved more than maxGap events past it,
  // whether or not that stream still speaks to its rule. Keeps `live` equal to
  // the number of partials actually held, and bounds the map on a long run.
  private sweep(): void {
    this.sweeps++
    this.sweptAt = this.pushes
    for (const [pk, list] of this.partials) {
      const kept = list.filter(p => {
        if ((this.counts.get(p.stream) ?? 0) - p.atCount - 1 <= p.maxGap) return true
        this.retire(p)
        return false
      })
      if (kept.length === 0) this.partials.delete(pk)
      else if (kept.length !== list.length) this.partials.set(pk, kept)
    }
    // Compact the age queue: drop consumed and retired slots. Amortised O(1) per
    // partial opened, since it only runs once the queue is twice the live set.
    if (this.ages.length > this.compactAbove && this.ages.length > this.live * 2) {
      this.ages = this.ages.slice(this.agesHead).filter(p => !p.dead)
      this.agesHead = 0
    }
  }

  // Evict the oldest partial still in flight, so a full cap degrades to
  // forget-the-oldest instead of going blind to every later sequence. Amortised
  // O(1): the queue is scanned forward once, skipping already-retired entries.
  private evictOldest(): boolean {
    while (this.agesHead < this.ages.length) {
      const p = this.ages[this.agesHead++]
      if (p.dead) continue
      const list = this.partials.get(p.pk)
      if (list) {
        const kept = list.filter(x => x !== p)
        if (kept.length === 0) this.partials.delete(p.pk)
        else this.partials.set(p.pk, kept)
      }
      this.retire(p)
      return true
    }
    return false
  }

  private emit(r: Rule, target: string, frame: Frame | null, pid: number): void {
    this.hits.push({
      ruleId: r.id, target, frame, pid,
      category: r.category, confidence: r.confidence, rationale: r.rationale,
    })
  }

  finish(): { hits: RawHit[]; dropped: number } {
    // Copy: a caller polling finish() per page must not see its earlier result
    // mutate as later pushes land.
    return { hits: [...this.hits], dropped: this.dropped }
  }
}

// One-shot wrapper. The store drives SequenceMatcher page by page instead.
export function matchSequences(
  rules: Rule[], events: Iterable<SyscallEvent>, cap?: number,
): { hits: RawHit[]; dropped: number } {
  const m = new SequenceMatcher(rules, cap)
  for (const e of events) m.push(e)
  return m.finish()
}

function sqlLit(s: string): string {
  return s.replace(/'/g, "''")
}

// The tracer renders fd args as 'fd=<n> <path>' (render_fd in
// ../Anubee/src/common/decode.c), 'fd=<n>' when readlink failed, 'AT_FDCWD', or a
// bare negative number. Rules match the path, so unwrap it; an unresolved fd has
// no path and contributes no value rather than matching the literal 'fd=122'.
const FD_WRAPPED = /^fd=\d+ <(.*)>$/
const FD_BARE = /^fd=\d+$/

export function normalizeFdValue(v: string): string | null {
  const m = FD_WRAPPED.exec(v)
  if (m) return m[1]
  if (FD_BARE.test(v)) return null
  return v
}

// Compile the enabled rules to a bounded DuckDB WHERE (OR of per-rule clauses).
// Only genuine RASP candidates are pulled off DuckDB onto the JS heap; SequenceMatcher
// re-checks each and remains the matching authority. An empty list matches
// nothing. Values are single-quote escaped - the safety boundary (no raw SQL).
export function compileWhere(rules: Rule[]): string {
  const clauses = rules.flatMap(r => r.steps).map(clauseOf)
  if (clauses.length === 0) return 'false'
  return clauses.join(' OR ')
}

// The SQL twin of normalizeFdValue: unwrap 'fd=<n> <path>', drop a bare
// 'fd=<n>', pass anything else through. Kept beside the JS version so the two
// compilers cannot drift; the real-DuckDB lockstep test enforces it.
const FD_NORM_SQL =
  "list_filter(list_transform(map_values(fd_args), x -> " +
  "CASE WHEN regexp_matches(x, '^fd=[0-9]+ <.*>$') " +
  "THEN regexp_extract(x, '^fd=[0-9]+ <(.*)>$', 1) " +
  "WHEN regexp_matches(x, '^fd=[0-9]+$') THEN NULL ELSE x END), y -> y IS NOT NULL)"

function clauseOf(m: RuleStep): string {
  const inSys = `syscall IN (${m.syscalls.map(s => `'${sqlLit(s)}'`).join(', ')})`
  const v = sqlLit(m.value)
  const f = m.field
  let pred: string
  if (m.op === 'arg_hex_eq') {
    const idx = (m.argIndex ?? 0) + 1 // DuckDB list is 1-indexed
    const dec = String(argNum(m.value))
    pred = `args[${idx}] IN ('${v}', '${sqlLit(dec)}')`
  } else if (f === 'sock_addr') {
    pred = m.op === 'equals' ? `sock_addr = '${v}'` : `regexp_matches(sock_addr, '${v}', 'i')`
  } else if (f === 'args') {
    pred = m.op === 'equals'
      ? `list_contains(args, '${v}')`
      : `len(list_filter(args, x -> regexp_matches(x, '${v}', 'i'))) > 0`
  } else if (f === 'fd_args') {
    pred = m.op === 'equals'
      ? `list_contains(${FD_NORM_SQL}, '${v}')`
      : `len(list_filter(${FD_NORM_SQL}, x -> regexp_matches(x, '${v}', 'i'))) > 0`
  } else { // string_args is MAP(VARCHAR,VARCHAR)
    pred = m.op === 'equals'
      ? `list_contains(map_values(${f}), '${v}')`
      : `len(list_filter(map_values(${f}), x -> regexp_matches(x, '${v}', 'i'))) > 0`
  }
  return `(${inSys} AND ${pred})`
}

function valuesOf(field: RuleField, e: SyscallEvent): string[] {
  switch (field) {
    case 'string_args': return Object.values(e.string_args)
    case 'fd_args': return Object.values(e.fd_args)
      .map(normalizeFdValue)
      .filter((v): v is string => v !== null)
    case 'args': return e.args
    case 'sock_addr': return e.sock_addr != null ? [e.sock_addr] : []
  }
}

// A step matches only within the syscalls it is scoped to - the JS twin of
// clauseOf's `syscall IN (...) AND pred`. Gated here rather than at each call
// site so every consumer of matchOne (SequenceMatcher) inherits it.
function matchOne(m: RuleStep, e: SyscallEvent): boolean {
  if (!m.syscalls.includes(e.syscall)) return false
  if (m.op === 'arg_hex_eq') {
    const a = e.args[m.argIndex ?? 0]
    return a !== undefined && argNum(a) === argNum(m.value)
  }
  const vals = valuesOf(m.field, e)
  if (m.op === 'equals') return vals.some(v => v === m.value)
  const re = new RegExp(m.value, 'i')
  return vals.some(v => re.test(v))
}

// Fold resolved hits into one row per (target, category). Identity includes the
// category so a library that performs several RASP checks yields one row each,
// instead of collapsing to the highest-confidence one and losing the others.
export function aggregate(hits: ResolvedHit[]): Suggestion[] {
  const rows = new Map<string, Suggestion & { byOffset: Map<string, number> }>()
  for (const h of hits) {
    const key = `${h.target} ${h.category}`
    let row = rows.get(key)
    if (!row) {
      row = {
        target: h.target, category: h.category, confidence: h.confidence,
        rationale: h.rationale, occurrences: 0, offsets: [], byOffset: new Map(),
      }
      rows.set(key, row)
    }
    row.occurrences++
    if (h.confidence > row.confidence) row.confidence = h.confidence
    if (!row.rationale.includes(h.rationale)) row.rationale += `; ${h.rationale}`
    row.byOffset.set(h.offset, (row.byOffset.get(h.offset) ?? 0) + 1)
  }
  return [...rows.values()].map(({ byOffset, ...row }) => ({
    ...row,
    offsets: [...byOffset.entries()].map(([offset, occurrences]) => ({ offset, occurrences })),
  }))
}
