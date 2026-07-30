import type { SyscallEvent } from './events'
import type { RaspCategory } from './project-store'
import type { CorrelateKey, Rule, RuleField, RuleStep, RetvalCond, RetvalOp } from './rasp-rules'
import { argNum, hexList } from './rasp-rules'
import type { Frame } from './rasp-attribution'
import { anchorFrame, attributionOf, correlationKey, unattributedId } from './rasp-attribution'
import type { ModulePaths } from './module-origin'

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
  target: string | null // null until emit() resolves it to the synthetic target
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
  // Module basename -> load path, for attribution. An empty map falls back to
  // the basename denylist in module-origin.
  paths?: ModulePaths
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
  private paths: ModulePaths

  constructor(private rules: Rule[], private cap = 10000, opts: SequenceMatcherOptions = {}) {
    this.sweepEvery = Math.max(1, opts.sweepEvery ?? SWEEP_EVERY)
    this.compactAbove = opts.compactAbove ?? COMPACT_ABOVE
    this.paths = opts.paths ?? new Map<string, string>()
  }

  // Sweeps performed so far. Exposed so a test can pin the reclaim work done at
  // a saturated cap without timing anything.
  get sweepCount(): number { return this.sweeps }

  push(e: SyscallEvent): void {
    this.pushes++
    if (this.pushes - this.sweptAt >= this.sweepEvery) this.sweep()
    const keys = new Map<CorrelateKey, string | null>()
    const keyOf = (mode: CorrelateKey): string | null => {
      if (!keys.has(mode)) keys.set(mode, correlationKey(mode, e, this.paths))
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
      if (k === null) {
        // A one-step rule has no sequence to correlate, so it needs no
        // correlation key: it matches and emits on the event alone, and emit()
        // resolves its unattributable target to the synthetic id. Demanding a
        // key here is what used to lose the finding a second time, after
        // attribution had already declined to name a platform frame. A
        // one-step rule therefore ignores its correlate mode entirely for
        // firing purposes. A multi-step rule genuinely must correlate its
        // steps, so with nothing to key on it can neither open nor advance a partial.
        if (r.steps.length > 1) continue
        this.emitSingle(r, e)
        continue
      }
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
      if (r.steps.length === 1) { this.emitSingle(r, e); continue }
      if (!matchOne(r.steps[0], e)) continue
      // An event whose app-owned caller cannot be recovered is still a real
      // detection, so it is never dropped here: emit() resolves the null target
      // to the rule's synthetic `rasp:unattributed:<category>` id.
      const a = attributionOf(e, this.paths)
      const target = a.kind === 'unattributed' ? null : a.id
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
        target, frame: anchorFrame(e, this.paths), pid: e.pid,
      }
      const open = this.partials.get(pk) ?? []
      open.push(p)
      this.partials.set(pk, open)
      this.ages.push(p)
    }
  }

  // A one-step rule is an immediate match: no correlation, no partial, no gap.
  // Both the keyed and the unkeyed path route here so the two cannot drift.
  private emitSingle(r: Rule, e: SyscallEvent): void {
    if (!matchOne(r.steps[0], e)) return
    const a = attributionOf(e, this.paths)
    this.emit(r, a.kind === 'unattributed' ? null : a.id, anchorFrame(e, this.paths), e.pid)
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

  // The single place a null target is resolved, so RawHit.target is always an
  // id: the rule's category is only known here, not where the event was matched.
  private emit(r: Rule, target: string | null, frame: Frame | null, pid: number): void {
    this.hits.push({
      ruleId: r.id, target: target ?? unattributedId(r.category), frame, pid,
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
  rules: Rule[], events: Iterable<SyscallEvent>, cap?: number, opts: SequenceMatcherOptions = {},
): { hits: RawHit[]; dropped: number } {
  const m = new SequenceMatcher(rules, cap, opts)
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

// The SQL twin of retvalOk's operator switch. A NULL retval fails every DuckDB
// comparison outright (SQL three-valued logic), matching retvalOk's null check
// with no extra IS NOT NULL guard needed.
const RETVAL_SQL: Record<RetvalOp, string> = { eq: '=', ne: '<>', lt: '<', ge: '>=' }

function clauseOf(m: RuleStep): string {
  const inSys = `syscall IN (${m.syscalls.map(s => `'${sqlLit(s)}'`).join(', ')})`
  const rv = m.retval ? ` AND retval ${RETVAL_SQL[m.retval.op]} ${m.retval.value}` : ''
  const v = sqlLit(m.value)
  const f = m.field
  let pred: string
  if (m.op === 'arg_hex_eq' || m.op === 'arg_hex_in') {
    const idx = (m.argIndex ?? 0) + 1 // DuckDB list is 1-indexed
    const items = m.op === 'arg_hex_eq' ? [m.value] : hexList(m.value)
    // Emit both spellings: the tracer renders an arg as hex or decimal.
    const lits = items.flatMap(x => [`'${sqlLit(x)}'`, `'${sqlLit(String(argNum(x)))}'`])
    pred = `args[${idx}] IN (${lits.join(', ')})`
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
  } else { // string_args and decoded_args are both MAP(VARCHAR,VARCHAR)
    pred = m.op === 'equals'
      ? `list_contains(map_values(${f}), '${v}')`
      : `len(list_filter(map_values(${f}), x -> regexp_matches(x, '${v}', 'i'))) > 0`
  }
  return `(${inSys} AND ${pred}${rv})`
}

// Path checks read string_args (an openat/access path argument) and fd_args (the
// path the tracer resolved behind a file descriptor).
function valuesOf(field: RuleField, e: SyscallEvent): string[] {
  switch (field) {
    case 'string_args': return Object.values(e.string_args)
    case 'fd_args': return Object.values(e.fd_args)
      .map(normalizeFdValue)
      .filter((v): v is string => v !== null)
    case 'args': return e.args
    case 'sock_addr': return e.sock_addr != null ? [e.sock_addr] : []
    case 'decoded_args': return Object.values(e.decoded_args)
  }
}

// A step's retval condition. Null retval (an enter-only record) never satisfies
// one, so a retval-conditioned rule under-reports on snapshot-mode captures.
function retvalOk(c: RetvalCond | undefined, retval: number | null): boolean {
  if (c === undefined) return true
  if (retval === null) return false
  switch (c.op) {
    case 'eq': return retval === c.value
    case 'ne': return retval !== c.value
    case 'lt': return retval < c.value
    case 'ge': return retval >= c.value
  }
}

// A step matches only within the syscalls it is scoped to - the JS twin of
// clauseOf's `syscall IN (...) AND pred`. Gated here rather than at each call
// site so every consumer of matchOne (SequenceMatcher) inherits it.
function matchOne(m: RuleStep, e: SyscallEvent): boolean {
  if (!m.syscalls.includes(e.syscall)) return false
  if (!retvalOk(m.retval, e.retval)) return false
  if (m.op === 'arg_hex_eq') {
    const a = e.args[m.argIndex ?? 0]
    return a !== undefined && argNum(a) === argNum(m.value)
  }
  if (m.op === 'arg_hex_in') {
    const a = e.args[m.argIndex ?? 0]
    if (a === undefined) return false
    const got = argNum(a)
    return hexList(m.value).some(x => argNum(x) === got)
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
