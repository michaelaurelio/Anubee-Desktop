// Rule types, validation and cross-scope resolution. Pure and Electron-free so
// the rule contract is unit-testable without a store or a renderer.
import type { RaspCategory } from './project-store'

export type RuleField = 'string_args' | 'fd_args' | 'sock_addr' | 'args' | 'decoded_args'
export type RuleOp = 'path_matches' | 'equals' | 'arg_hex_eq' | 'arg_hex_in' | 'any'
export type RuleSource = 'builtin' | 'global' | 'project'

export type RetvalOp = 'eq' | 'ne' | 'lt' | 'ge'
export interface RetvalCond { op: RetvalOp; value: number }

export type CorrelateKey = 'symbol' | 'symbol+tid' | 'module' | 'module+tid' | 'java'

export type MatchMode = 'ordered' | 'unordered'

export interface RuleStep {
  syscalls: string[]
  field: RuleField
  op: RuleOp
  argIndex?: number
  value: string
  // An AND-modifier on the SAME event, not a field. Modelled as a field it would
  // need a second step, and in unordered mode two steps may be satisfied by two
  // different events - so an open(su) plus any later retval 0 would falsely
  // complete. An event with retval null (enter-only record) never satisfies it.
  retval?: RetvalCond
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
  // 'ordered': steps must match in sequence. 'unordered': all steps must match
  // within the same window on the same correlation key, in any order.
  mode: MatchMode
  // A rule yields a suggestion only after this many COMPLETED matches for one
  // target - N events for a one-step rule, N completed sequences otherwise.
  minOccurrences: number
  source: RuleSource
}

export const DEFAULT_CORRELATE: CorrelateKey = 'symbol+tid'
export const DEFAULT_MAX_GAP = 50
export const DEFAULT_MODE: MatchMode = 'ordered'
export const DEFAULT_MIN_OCCURRENCES = 1
const CORRELATES: CorrelateKey[] = ['symbol', 'symbol+tid', 'module', 'module+tid', 'java']
const MODES: MatchMode[] = ['ordered', 'unordered']

export interface RuleScope {
  rules: Rule[]
  enabledOverrides: Record<string, boolean>
}

const CATEGORIES: RaspCategory[] = ['root', 'debugger', 'emulator', 'integrity', 'hook', 'custom']
const FIELDS: RuleField[] = ['string_args', 'fd_args', 'sock_addr', 'args', 'decoded_args']
const OPS: RuleOp[] = ['path_matches', 'equals', 'arg_hex_eq', 'arg_hex_in', 'any']
const RETVAL_OPS: RetvalOp[] = ['eq', 'ne', 'lt', 'ge']
const HEX = /^0x[0-9a-f]+$/i
// Constructs valid in a JS RegExp but unsupported by DuckDB's RE2 engine
// (lookahead/lookbehind/backreference). A path_matches value using one would pass
// JS validation and work in matchOne, but make compileWhere emit SQL that DuckDB
// rejects at runtime - reject it at authoring time so the two compilers stay in lockstep.
const RE2_INCOMPATIBLE = /\(\?<?[=!]|\\[1-9]/

// Parse a raw syscall arg ("0x0", "0", 16) to a number, or NaN.
export function argNum(v: string | undefined): number {
  if (v === undefined) return NaN
  return v.startsWith('0x') || v.startsWith('0X') ? parseInt(v, 16) : Number(v)
}

// 'arg_hex_in' carries a space-separated hex list. Split identically everywhere.
export function hexList(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean)
}

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
  if (m.op === 'arg_hex_in') {
    if (typeof m.argIndex !== 'number' || m.argIndex < 0 || !Number.isInteger(m.argIndex))
      return { step: null, error: `arg_hex_in needs argIndex on ${id}` }
    const items = hexList(m.value as string)
    if (items.length === 0 || !items.every(x => HEX.test(x)))
      return { step: null, error: `arg_hex_in values must all be hex on ${id}` }
  }
  if (m.op === 'path_matches') {
    try { new RegExp(m.value) } catch { return { step: null, error: `bad regex on ${id}` } }
    if (RE2_INCOMPATIBLE.test(m.value))
      return { step: null, error: `regex uses an RE2-incompatible construct (lookaround/backreference) on ${id}` }
  }
  let retval: RetvalCond | undefined
  if (m.retval !== undefined) {
    if (typeof m.retval !== 'object' || m.retval === null) return { step: null, error: `bad retval on ${id}` }
    const rc = m.retval as Record<string, unknown>
    if (typeof rc.op !== 'string' || !RETVAL_OPS.includes(rc.op as RetvalOp))
      return { step: null, error: `bad retval op on ${id}` }
    if (typeof rc.value !== 'number' || !Number.isFinite(rc.value))
      return { step: null, error: `retval value must be a number on ${id}` }
    retval = { op: rc.op as RetvalOp, value: rc.value }
  }

  const value = m.op === 'arg_hex_eq' ? '0x' + argNum(m.value as string).toString(16) : (m.value as string)
  const step: RuleStep = { syscalls: m.syscalls as string[], field: m.field as RuleField, op: m.op as RuleOp, value }
  if (typeof m.argIndex === 'number') step.argIndex = m.argIndex
  if (retval) step.retval = retval
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
  const mode = o.mode === undefined ? DEFAULT_MODE : o.mode
  if (typeof mode !== 'string' || !MODES.includes(mode as MatchMode))
    return { rule: null, error: `bad mode on ${o.id}` }
  const minOccurrences = o.minOccurrences === undefined ? DEFAULT_MIN_OCCURRENCES : o.minOccurrences
  if (typeof minOccurrences !== 'number' || !Number.isInteger(minOccurrences) || minOccurrences < 1)
    return { rule: null, error: `minOccurrences must be a positive integer on ${o.id}` }

  const rule: Rule = {
    id: o.id, category: o.category as RaspCategory, confidence: o.confidence, rationale: o.rationale,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    steps, correlate: correlate as CorrelateKey, maxGap,
    mode: mode as MatchMode, minOccurrences, source,
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
