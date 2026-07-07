import type { SyscallEvent } from './events'
import type { RaspCategory } from './project-store'
import { chainOf } from './graph-shape'

// Rules over syscall events -> suggested RASP tags. Never auto-applied; the
// analyst confirms each. Grounded in real ARES output (see the Phase-2 spec):
// ptrace's request is NOT decoded to a name - it is raw args[0], and
// PTRACE_TRACEME === 0. Path checks read string_args (openat/access path) and
// fd_args (resolved fd path). Kept pure so the rules are unit-testable; the
// candidateWhere() below pushes the same predicates into SQL, sharing
// SUSPICIOUS_PATH_PATTERN with SUSPICIOUS_PATHS so the WHERE and the JS
// predicate cannot drift apart.

export type RuleField = 'string_args' | 'fd_args' | 'sock_addr' | 'args'
export type RuleOp = 'path_matches' | 'equals' | 'arg_hex_eq'
export type RuleSource = 'builtin' | 'global' | 'project'

export interface RuleMatch {
  syscalls: string[]
  field: RuleField
  op: RuleOp
  argIndex?: number
  value: string
}

export interface Rule {
  id: string
  category: RaspCategory
  confidence: number
  rationale: string
  enabled: boolean
  match: RuleMatch
  source: RuleSource
}

export interface RuleScope {
  rules: Rule[]
  enabledOverrides: Record<string, boolean>
}

const CATEGORIES: RaspCategory[] = ['root', 'debugger', 'emulator', 'integrity', 'hook', 'custom']
const FIELDS: RuleField[] = ['string_args', 'fd_args', 'sock_addr', 'args']
const OPS: RuleOp[] = ['path_matches', 'equals', 'arg_hex_eq']
const HEX = /^0x[0-9a-f]+$/i

// Built-in rules expressed in the same schema as user rules. Corrected + extended
// against a real 245,760-event RASP capture (see the session spec): the shipped
// debugger rules under-fired; hook is genuinely detectable; emulator/integrity
// have no syscall signal and ship no rule.
export const BUILTIN_RULES: Rule[] = [
  { id: 'dbg-ptrace-attach', category: 'debugger', confidence: 0.7,
    rationale: 'ptrace(PTRACE_ATTACH) attach-probe - anti-debug self/other attach',
    enabled: true, source: 'builtin',
    match: { syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x10' } },
  { id: 'dbg-ptrace-traceme', category: 'debugger', confidence: 0.9,
    rationale: 'ptrace(PTRACE_TRACEME) - classic anti-debug self-attach',
    enabled: true, source: 'builtin',
    match: { syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x0' } },
  { id: 'dbg-status-open', category: 'debugger', confidence: 0.6,
    rationale: 'open of /proc/self/status - likely TracerPid debugger check',
    enabled: true, source: 'builtin',
    match: { syscalls: ['openat', 'newfstatat'], field: 'string_args', op: 'path_matches', value: '/proc/self/status$' } },
  { id: 'dbg-status-read', category: 'debugger', confidence: 0.6,
    rationale: 'read of /proc/self/status - likely TracerPid debugger check',
    enabled: true, source: 'builtin',
    match: { syscalls: ['read'], field: 'fd_args', op: 'equals', value: '/proc/self/status' } },
  { id: 'hook-maps', category: 'hook', confidence: 0.5,
    rationale: 'read of /proc/self/maps - hook/injection scan (also frida/xposed/integrity); low confidence',
    enabled: true, source: 'builtin',
    match: { syscalls: ['openat', 'newfstatat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' } },
  { id: 'hook-frida-sock', category: 'hook', confidence: 0.9,
    rationale: 'connect to a frida control socket - dynamic-instrumentation probe',
    enabled: true, source: 'builtin',
    match: { syscalls: ['connect'], field: 'sock_addr', op: 'path_matches', value: 'frida' } },
  { id: 'root-paths', category: 'root', confidence: 0.85,
    rationale: 'access of a root-indicator path (su/magisk/busybox/xbin/sbin/adb)',
    enabled: true, source: 'builtin',
    match: { syscalls: ['openat', 'access', 'newfstatat', 'faccessat'], field: 'string_args', op: 'path_matches',
      value: '(^|/)su$|magisk|busybox|/system/xbin|/sbin(/|$)|/data/adb' } },
  { id: 'root-selinux', category: 'root', confidence: 0.8,
    rationale: 'read of /sys/fs/selinux/enforce - SELinux-posture / root tell',
    enabled: true, source: 'builtin',
    match: { syscalls: ['openat', 'newfstatat', 'faccessat'], field: 'string_args', op: 'path_matches', value: '/sys/fs/selinux/enforce$' } },
  { id: 'root-ksu-prctl', category: 'root', confidence: 0.9,
    rationale: 'prctl(0xdeadbeef) - KernelSU magic prctl probe',
    enabled: true, source: 'builtin',
    match: { syscalls: ['prctl'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0xdeadbeef' } },
]

export function validateRule(v: unknown, source: RuleSource): { rule: Rule | null; error: string | null } {
  if (typeof v !== 'object' || v === null) return { rule: null, error: 'not an object' }
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0) return { rule: null, error: 'missing id' }
  if (typeof o.category !== 'string' || !CATEGORIES.includes(o.category as RaspCategory)) return { rule: null, error: `bad category on ${o.id}` }
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1) return { rule: null, error: `confidence out of [0,1] on ${o.id}` }
  if (typeof o.rationale !== 'string') return { rule: null, error: `missing rationale on ${o.id}` }
  const m = o.match as Record<string, unknown> | undefined
  if (typeof m !== 'object' || m === null) return { rule: null, error: `missing match on ${o.id}` }
  if (!Array.isArray(m.syscalls) || m.syscalls.length === 0 || !m.syscalls.every(s => typeof s === 'string')) return { rule: null, error: `bad syscalls on ${o.id}` }
  if (typeof m.field !== 'string' || !FIELDS.includes(m.field as RuleField)) return { rule: null, error: `bad field on ${o.id}` }
  if (typeof m.op !== 'string' || !OPS.includes(m.op as RuleOp)) return { rule: null, error: `bad op on ${o.id}` }
  if (typeof m.value !== 'string') return { rule: null, error: `missing value on ${o.id}` }
  if (m.op === 'arg_hex_eq') {
    if (typeof m.argIndex !== 'number' || m.argIndex < 0 || !Number.isInteger(m.argIndex)) return { rule: null, error: `arg_hex_eq needs argIndex on ${o.id}` }
    if (!HEX.test(m.value)) return { rule: null, error: `arg_hex_eq value must be hex on ${o.id}` }
  }
  if (m.op === 'path_matches') {
    try { new RegExp(m.value) } catch { return { rule: null, error: `bad regex on ${o.id}` } }
  }
  const match: RuleMatch = { syscalls: m.syscalls as string[], field: m.field as RuleField, op: m.op as RuleOp, value: m.value }
  if (typeof m.argIndex === 'number') match.argIndex = m.argIndex
  const rule: Rule = {
    id: o.id, category: o.category as RaspCategory, confidence: o.confidence, rationale: o.rationale,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true, match, source,
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
    map.set(r.id, { ...r, match: { ...r.match } })
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

export const INTERESTING_SYSCALLS = ['ptrace', 'openat', 'access', 'newfstatat', 'faccessat', 'read']

// su / magisk / known root paths, RE2-compatible (shared with the SQL
// candidate filter in candidateWhere so the two can never drift). Case
// sensitivity is applied separately by each consumer (JS flag / SQL flag arg).
export const SUSPICIOUS_PATH_PATTERN = '(^|/)su$|magisk|/system/xbin|/sbin(/|$)'

// su / magisk / known root paths. Case-insensitive.
export const SUSPICIOUS_PATHS = new RegExp(SUSPICIOUS_PATH_PATTERN, 'i')

// Parse a raw syscall arg ("0x0", "0", 16) to a number, or NaN.
function argNum(v: string | undefined): number {
  if (v === undefined) return NaN
  return v.startsWith('0x') || v.startsWith('0X') ? parseInt(v, 16) : Number(v)
}

// The native node id closest to the syscall (backtrace[0], innermost), or the
// syscall node when there is no resolvable native frame. Reuses chainOf so the
// id grammar matches the graph exactly.
function nativeTargetOf(e: SyscallEvent): string {
  const chain = chainOf(e)
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].kind === 'native') return chain[i].id
  }
  return `sys:${e.syscall}`
}

// Push the actual scoring predicates into SQL so only genuine RASP candidates
// are pulled onto the JS heap - `score()` re-checks each one and remains the
// authority, this only narrows what to_json(ev) has to reconstruct. Kept in
// lockstep with score()'s three rules; the path pattern is shared via
// SUSPICIOUS_PATH_PATTERN so the SQL and JS checks cannot drift apart.
export function candidateWhere(): string {
  const pathSyscalls = ['openat', 'access', 'newfstatat', 'faccessat'].map(s => `'${s}'`).join(', ')
  const pattern = SUSPICIOUS_PATH_PATTERN.replace(/'/g, "''")
  return (
    `(syscall = 'ptrace' AND args[1] IN ('0x0', '0'))` +
    ` OR (syscall IN (${pathSyscalls})` +
    ` AND len(list_filter(map_values(string_args), v -> regexp_matches(v, '${pattern}', 'i'))) > 0)` +
    ` OR (syscall = 'read' AND list_contains(map_values(fd_args), '/proc/self/status'))`
  )
}

export function score(e: SyscallEvent): Suggestion[] {
  const out: Suggestion[] = []

  if (e.syscall === 'ptrace' && argNum(e.args[0]) === 0) {
    out.push({ target: `sys:ptrace`, category: 'debugger', confidence: 0.9,
      rationale: 'ptrace(PTRACE_TRACEME) - classic anti-debug self-attach', occurrences: 1 })
  }

  if (['openat', 'access', 'newfstatat', 'faccessat'].includes(e.syscall)) {
    const hit = Object.values(e.string_args).find(v => SUSPICIOUS_PATHS.test(v))
    if (hit) {
      out.push({ target: nativeTargetOf(e), category: 'root', confidence: 0.85,
        rationale: `${e.syscall} on root-indicator path ${hit}`, occurrences: 1 })
    }
  }

  if (e.syscall === 'read') {
    const status = Object.values(e.fd_args).find(v => v === '/proc/self/status')
    if (status) {
      out.push({ target: `sys:read`, category: 'debugger', confidence: 0.6,
        rationale: 'read of /proc/self/status - likely TracerPid debugger check', occurrences: 1 })
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
