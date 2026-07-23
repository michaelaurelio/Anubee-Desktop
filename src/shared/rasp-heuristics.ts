import type { SyscallEvent } from './events'
import type { RaspCategory } from './project-store'
import { chainOf } from './graph-shape'
import { parseFrameSymbol } from './frame-symbol'

// Rules over syscall events -> suggested RASP tags. Never auto-applied; the
// analyst confirms each. Grounded in real Anubee output (see the Phase-2 spec):
// ptrace's request is NOT decoded to a name - it is raw args[0], and
// PTRACE_TRACEME === 0. Path checks read string_args (openat/access path) and
// fd_args (resolved fd path). Kept pure so the rules are unit-testable.

export type RuleField = 'string_args' | 'fd_args' | 'sock_addr' | 'args'
export type RuleOp = 'path_matches' | 'equals' | 'arg_hex_eq'
export type RuleSource = 'builtin' | 'global' | 'project'

export type CorrelateKey = 'symbol' | 'symbol+tid' | 'module' | 'module+tid' | 'java'

export interface RuleStep {
  syscalls: string[]
  field: RuleField
  op: RuleOp
  argIndex?: number
  value: string
}

// Retained name so existing renderer imports keep compiling; a step and a
// legacy match are the same shape.
export type RuleMatch = RuleStep

export interface Rule {
  id: string
  category: RaspCategory
  confidence: number
  rationale: string
  enabled: boolean
  steps: RuleStep[]      // >= 1; a length-1 rule is today's single-event predicate
  correlate: CorrelateKey
  // Rule-relevant events (events matching some rule step, i.e. what the DuckDB
  // prefilter admits) sharing this correlation key, allowed between consecutive
  // steps. See the SequenceMatcher comment.
  maxGap: number
  source: RuleSource
}

export const DEFAULT_CORRELATE: CorrelateKey = 'symbol+tid'
export const DEFAULT_MAX_GAP = 50
const CORRELATES: CorrelateKey[] = ['symbol', 'symbol+tid', 'module', 'module+tid', 'java']

export interface RuleScope {
  rules: Rule[]
  enabledOverrides: Record<string, boolean>
}

const CATEGORIES: RaspCategory[] = ['root', 'debugger', 'emulator', 'integrity', 'hook', 'custom']
const FIELDS: RuleField[] = ['string_args', 'fd_args', 'sock_addr', 'args']
const OPS: RuleOp[] = ['path_matches', 'equals', 'arg_hex_eq']
const HEX = /^0x[0-9a-f]+$/i
// Constructs valid in a JS RegExp but unsupported by DuckDB's RE2 engine
// (lookahead/lookbehind/backreference). A path_matches value using one would pass
// JS validation and work in scoreWith, but make compileWhere emit SQL that DuckDB
// rejects at runtime - reject it at authoring time so the two compilers stay in lockstep.
const RE2_INCOMPATIBLE = /\(\?<?[=!]|\\[1-9]/

// Built-in rules expressed in the same schema as user rules. Corrected + extended
// against a real 245,760-event RASP capture (see the session spec): the shipped
// debugger rules under-fired; hook is genuinely detectable; emulator/integrity
// have no syscall signal and ship no rule.
export const BUILTIN_RULES: Rule[] = [
  { id: 'dbg-ptrace-attach', category: 'debugger', confidence: 0.7,
    rationale: 'ptrace(PTRACE_ATTACH) attach-probe - anti-debug self/other attach',
    enabled: true, source: 'builtin', correlate: 'symbol+tid', maxGap: 50,
    steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x10' }] },
  { id: 'dbg-ptrace-traceme', category: 'debugger', confidence: 0.9,
    rationale: 'ptrace(PTRACE_TRACEME) - classic anti-debug self-attach',
    enabled: true, source: 'builtin', correlate: 'symbol+tid', maxGap: 50,
    steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x0' }] },
  { id: 'dbg-status-open', category: 'debugger', confidence: 0.6,
    rationale: 'open of /proc/self/status - likely TracerPid debugger check',
    enabled: true, source: 'builtin', correlate: 'symbol+tid', maxGap: 50,
    steps: [{ syscalls: ['openat', 'newfstatat'], field: 'string_args', op: 'path_matches', value: '/proc/self/status$' }] },
  { id: 'dbg-status-read', category: 'debugger', confidence: 0.6,
    rationale: 'read of /proc/self/status - likely TracerPid debugger check',
    enabled: true, source: 'builtin', correlate: 'symbol+tid', maxGap: 50,
    steps: [{ syscalls: ['read'], field: 'fd_args', op: 'equals', value: '/proc/self/status' }] },
  { id: 'hook-maps', category: 'hook', confidence: 0.5,
    rationale: 'read of /proc/self/maps - hook/injection scan (also frida/xposed/integrity); low confidence',
    enabled: true, source: 'builtin', correlate: 'symbol+tid', maxGap: 50,
    steps: [{ syscalls: ['openat', 'newfstatat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' }] },
  { id: 'hook-frida-sock', category: 'hook', confidence: 0.9,
    rationale: 'connect to a frida control socket - dynamic-instrumentation probe',
    enabled: true, source: 'builtin', correlate: 'symbol+tid', maxGap: 50,
    steps: [{ syscalls: ['connect'], field: 'sock_addr', op: 'path_matches', value: 'frida' }] },
  { id: 'root-paths', category: 'root', confidence: 0.85,
    rationale: 'access of a root-indicator path (su/magisk/busybox/xbin/sbin/adb)',
    enabled: true, source: 'builtin', correlate: 'symbol+tid', maxGap: 50,
    steps: [{ syscalls: ['openat', 'access', 'newfstatat', 'faccessat'], field: 'string_args', op: 'path_matches',
      value: '(^|/)su$|magisk|busybox|/system/xbin|/sbin(/|$)|/data/adb' }] },
  { id: 'root-selinux', category: 'root', confidence: 0.8,
    rationale: 'read of /sys/fs/selinux/enforce - SELinux-posture / root tell',
    enabled: true, source: 'builtin', correlate: 'symbol+tid', maxGap: 50,
    steps: [{ syscalls: ['openat', 'newfstatat', 'faccessat'], field: 'string_args', op: 'path_matches', value: '/sys/fs/selinux/enforce$' }] },
  { id: 'root-ksu-prctl', category: 'root', confidence: 0.9,
    rationale: 'prctl(0xdeadbeef) - KernelSU magic prctl probe',
    enabled: true, source: 'builtin', correlate: 'symbol+tid', maxGap: 50,
    steps: [{ syscalls: ['prctl'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0xdeadbeef' }] },
]

function validateStep(v: unknown, id: string): { step: RuleStep | null; error: string | null } {
  if (typeof v !== 'object' || v === null) return { step: null, error: `bad step on ${id}` }
  const m = v as Record<string, unknown>
  if (!Array.isArray(m.syscalls) || m.syscalls.length === 0 || !m.syscalls.every(s => typeof s === 'string'))
    return { step: null, error: `bad syscalls on ${id}` }
  if (typeof m.field !== 'string' || !FIELDS.includes(m.field as RuleField)) return { step: null, error: `bad field on ${id}` }
  if (typeof m.op !== 'string' || !OPS.includes(m.op as RuleOp)) return { step: null, error: `bad op on ${id}` }
  if (typeof m.value !== 'string') return { step: null, error: `missing value on ${id}` }
  if (m.op === 'arg_hex_eq') {
    if (typeof m.argIndex !== 'number' || m.argIndex < 0 || !Number.isInteger(m.argIndex))
      return { step: null, error: `arg_hex_eq needs argIndex on ${id}` }
    if (!HEX.test(m.value)) return { step: null, error: `arg_hex_eq value must be hex on ${id}` }
  }
  if (m.op === 'path_matches') {
    try { new RegExp(m.value) } catch { return { step: null, error: `bad regex on ${id}` } }
    if (RE2_INCOMPATIBLE.test(m.value))
      return { step: null, error: `regex uses an RE2-incompatible construct (lookaround/backreference) on ${id}` }
  }
  const value = m.op === 'arg_hex_eq' ? '0x' + argNum(m.value as string).toString(16) : (m.value as string)
  const step: RuleStep = { syscalls: m.syscalls as string[], field: m.field as RuleField, op: m.op as RuleOp, value }
  if (typeof m.argIndex === 'number') step.argIndex = m.argIndex
  return { step, error: null }
}

export function validateRule(v: unknown, source: RuleSource): { rule: Rule | null; error: string | null } {
  if (typeof v !== 'object' || v === null) return { rule: null, error: 'not an object' }
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0) return { rule: null, error: 'missing id' }
  if (typeof o.category !== 'string' || !CATEGORIES.includes(o.category as RaspCategory)) return { rule: null, error: `bad category on ${o.id}` }
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1) return { rule: null, error: `confidence out of [0,1] on ${o.id}` }
  if (typeof o.rationale !== 'string') return { rule: null, error: `missing rationale on ${o.id}` }

  // Schema v1 stored a single `match`; read it as a one-step sequence.
  const raw = Array.isArray(o.steps) ? o.steps : (o.match !== undefined ? [o.match] : null)
  if (raw === null) return { rule: null, error: `missing steps on ${o.id}` }
  if (raw.length === 0) return { rule: null, error: `steps must not be empty on ${o.id}` }
  const steps: RuleStep[] = []
  for (const entry of raw) {
    const { step, error } = validateStep(entry, o.id)
    if (!step) return { rule: null, error }
    steps.push(step)
  }

  const correlate = o.correlate === undefined ? DEFAULT_CORRELATE : o.correlate
  if (typeof correlate !== 'string' || !CORRELATES.includes(correlate as CorrelateKey))
    return { rule: null, error: `bad correlate on ${o.id}` }
  const maxGap = o.maxGap === undefined ? DEFAULT_MAX_GAP : o.maxGap
  if (typeof maxGap !== 'number' || !Number.isInteger(maxGap) || maxGap < 1)
    return { rule: null, error: `maxGap must be a positive integer on ${o.id}` }

  const rule: Rule = {
    id: o.id, category: o.category as RaspCategory, confidence: o.confidence, rationale: o.rationale,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    steps, correlate: correlate as CorrelateKey, maxGap, source,
  }
  return { rule, error: null }
}

export function coerceRules(arr: unknown[], source: RuleSource): { rules: Rule[]; errors: string[] } {
  const rules: Rule[] = []
  const errors: string[] = []
  arr.forEach((entry, i) => {
    const { rule, error } = validateRule(entry, source)
    if (rule) rules.push(rule)
    else errors.push(`rule[${i}]: ${error}`)
  })
  return { rules, errors }
}

// Merge across scopes. Later scope wins on id collision (project > global >
// builtin) for both the rule body and the enabled flag; a scope's
// enabledOverrides flips any id (including a built-in), and a later scope's
// override beats an earlier one - so project can re-enable what global disabled.
// Deterministic order: builtins first, then first-seen global, then project.
export function resolveRules(builtin: Rule[], global: RuleScope, project: RuleScope): Rule[] {
  const map = new Map<string, Rule>()
  const order: string[] = []
  const put = (r: Rule) => {
    if (!map.has(r.id)) order.push(r.id)
    map.set(r.id, { ...r, steps: r.steps.map(s => ({ ...s })) })
  }
  const applyOverrides = (ov: Record<string, boolean>) => {
    for (const [id, en] of Object.entries(ov)) {
      const cur = map.get(id)
      if (cur) map.set(id, { ...cur, enabled: en })
    }
  }
  builtin.forEach(put)
  global.rules.forEach(put)
  applyOverrides(global.enabledOverrides)
  project.rules.forEach(put)
  applyOverrides(project.enabledOverrides)
  return order.map(id => map.get(id)!)
}

export interface Suggestion {
  target: string
  category: RaspCategory
  confidence: number
  rationale: string
  occurrences: number
}

// Parse a raw syscall arg ("0x0", "0", 16) to a number, or NaN.
function argNum(v: string | undefined): number {
  if (v === undefined) return NaN
  return v.startsWith('0x') || v.startsWith('0X') ? parseInt(v, 16) : Number(v)
}

// Native modules that belong to the platform, not the traced app: bionic, the
// ART/managed runtime, and the logging/base/framework core. A RASP check almost
// always runs in the app's own (often obfuscated) library and reaches a syscall
// *through* these, so they are the wrong thing to tag. Matched by basename.
const SYSTEM_NATIVE = new Set<string>([
  // bionic
  'libc.so', 'libm.so', 'libdl.so', 'libc++.so', 'libc++_shared.so', 'libstdc++.so',
  'linker64', 'linker',
  // ART / managed runtime
  'libart.so', 'libartbase.so', 'libartpalette.so', 'libart-compiler.so',
  'libopenjdk.so', 'libopenjdkjvm.so', 'libopenjdkjvmti.so', 'libjavacore.so',
  'libnativehelper.so', 'libnativeloader.so', 'libnativebridge.so',
  'libdexfile.so', 'libprofile.so', 'libsigchain.so',
  // logging / base / framework core
  'liblog.so', 'libbase.so', 'libcutils.so', 'libutils.so', 'libbinder.so',
  'libandroid_runtime.so', 'libandroidicu.so',
])

// A frame that can never be the app's own RASP code: a platform lib, or a
// synthetic/non-file region ([anon], [vdso], [JIT], [stack], ...).
function isSystemNative(module: string | null): boolean {
  if (module === null) return true
  if (module.startsWith('[')) return true
  return SYSTEM_NATIVE.has(module)
}

// The node id of the RASP block behind the syscall: the innermost native frame
// that is NOT a platform lib (the app's own code that called into libc). A stack
// that never leaves platform code is not app RASP code, so it yields no target -
// falling back to the libc wrapper used to suggest libart.so as a hook check.
// A managed-code check with no custom native lib falls back to its innermost
// java frame. Reuses chainOf so the id grammar matches the graph exactly.
function targetOf(e: SyscallEvent): string | null {
  const chain = chainOf(e)
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]
    if (c.kind === 'native' && !isSystemNative(c.module)) return c.id
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].kind === 'java') return chain[i].id
  }
  return null
}

export interface Frame { module: string; addr: string }

export interface RawHit {
  ruleId: string
  target: string
  frame: Frame | null   // the anchor (step 0) call site; null when it has no module
  pid: number
  category: RaspCategory
  confidence: number
  rationale: string
}

// The anchor frame for a hit: the innermost non-platform native frame's raw
// address and module. Null when the event is attributed to a java frame, which
// has no load address to make module-relative.
function anchorFrame(e: SyscallEvent): Frame | null {
  for (const f of e.backtrace) {
    const p = parseFrameSymbol(f.symbol)
    if (p.module === null || isSystemNative(p.module)) continue
    return { module: p.module, addr: f.addr }
  }
  return null
}

// The correlation key for one event under one mode, or null when the event has
// no origin of that kind (it then participates in no sequence for that rule).
function correlationKey(mode: CorrelateKey, e: SyscallEvent): string | null {
  if (mode === 'java') {
    const chain = chainOf(e)
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].kind === 'java') return chain[i].id
    return null
  }
  let base: string | null
  if (mode === 'module' || mode === 'module+tid') {
    // A module key needs a non-platform native frame; there is no module to key
    // on for a java-attributed event.
    const f = anchorFrame(e)
    if (f === null) return null
    base = `mod:${f.module}`
  } else {
    // symbol / symbol+tid key on the graph target, which falls back to the
    // innermost java frame when the app has no custom native lib in the stack.
    base = targetOf(e)
  }
  if (base === null) return null
  return mode.endsWith('+tid') ? `${base}#${e.tid}` : base
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
// prefilter admits only candidate rows), and unrelated work cannot dilute a
// window because it either matches no step or keys differently.
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
// Only genuine RASP candidates are pulled off DuckDB onto the JS heap; scoreWith
// re-checks each and remains the scoring authority. An empty list matches
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
// site so every consumer (scoreWith, SequenceMatcher) inherits it.
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

// The scoring authority. One suggestion per rule whose syscall + predicate match;
// target is the nearest native frame (targetOf), rationale verbatim.
export function scoreWith(rules: Rule[], e: SyscallEvent): Suggestion[] {
  const target = targetOf(e)
  if (target === null) return []
  const out: Suggestion[] = []
  for (const r of rules) {
    if (matchOne(r.steps[0], e)) {
      out.push({ target, category: r.category, confidence: r.confidence, rationale: r.rationale, occurrences: 1 })
    }
  }
  return out
}

export function aggregate(suggestions: Suggestion[]): Suggestion[] {
  const byTarget = new Map<string, Suggestion>()
  for (const s of suggestions) {
    const cur = byTarget.get(s.target)
    if (!cur) {
      byTarget.set(s.target, { ...s })
    } else {
      cur.occurrences += s.occurrences
      if (s.confidence > cur.confidence) {
        cur.confidence = s.confidence
        cur.category = s.category
      }
      if (!cur.rationale.includes(s.rationale)) cur.rationale += `; ${s.rationale}`
    }
  }
  return [...byTarget.values()]
}
