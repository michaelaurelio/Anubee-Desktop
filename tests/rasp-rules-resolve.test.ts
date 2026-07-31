import { describe, it, expect } from 'vitest'
import {
  BUILTIN_RULES, validateRule, coerceRules, coerceOverrides, migrateRuleId, resolveRules, hexList,
  type Rule, type RuleScope,
} from '../src/shared/rasp-heuristics'

const EMPTY: RuleScope = { rules: [], enabledOverrides: {} }

const userRule = (over: Partial<Rule> = {}): Rule => ({
  id: 'u-1', category: 'custom', confidence: 0.5, rationale: 'user rule', enabled: true,
  steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'foo' }],
  correlate: 'symbol+tid', maxGap: 50, mode: 'ordered', minOccurrences: 1,
  source: 'global', ...over,
})

describe('BUILTIN_RULES', () => {
  it('are all valid and have unique ids, all source=builtin', () => {
    const ids = new Set<string>()
    for (const r of BUILTIN_RULES) {
      expect(validateRule(r, 'builtin').rule, `${r.id} must validate`).not.toBeNull()
      expect(r.source).toBe('builtin')
      expect(ids.has(r.id)).toBe(false)
      ids.add(r.id)
    }
    // the corrected/added categories the redesign requires
    const byId = new Map(BUILTIN_RULES.map(r => [r.id, r]))
    expect(hexList(byId.get('dbg-ptrace-selftrace')!.steps[0].value as string)).toContain('0x10')
    expect(byId.get('hook-frida-port')!.steps[0].field).toBe('sock_addr')
    expect(byId.get('root-selinux')).toBeTruthy()
    expect(byId.get('root-ksu-prctl')!.steps[0].op).toBe('arg_hex_eq')
    // the 30-rule library ships both categories (see Task 12)
    expect(BUILTIN_RULES.some(r => r.category === 'emulator')).toBe(true)
    expect(BUILTIN_RULES.some(r => r.category === 'integrity')).toBe(true)
  })
})

describe('validateRule', () => {
  it('rejects an empty id', () => {
    expect(validateRule(userRule({ id: '' }), 'global').rule).toBeNull()
  })
  it('rejects an empty syscalls set', () => {
    expect(validateRule(userRule({ steps: [{ syscalls: [], field: 'args', op: 'equals', value: 'x' }] }), 'global').rule).toBeNull()
  })
  it('rejects confidence out of [0,1]', () => {
    expect(validateRule(userRule({ confidence: 1.5 }), 'global').rule).toBeNull()
  })
  it('rejects arg_hex_eq without argIndex', () => {
    expect(validateRule(userRule({ steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', value: '0x10' }] }), 'global').rule).toBeNull()
  })
  it('rejects arg_hex_eq with a non-hex value', () => {
    expect(validateRule(userRule({ steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: 'nope' }] }), 'global').rule).toBeNull()
  })
  it('rejects a path_matches value that is not a valid regex', () => {
    expect(validateRule(userRule({ steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '(' }] }), 'global').rule).toBeNull()
  })
  it('stamps the source and defaults missing enabled to true', () => {
    const raw = { ...userRule() } as Record<string, unknown>
    delete raw.enabled
    const r = validateRule(raw, 'project').rule
    expect(r).not.toBeNull()
    expect(r!.enabled).toBe(true)
    expect(r!.source).toBe('project')
  })
  it('rejects a path_matches value using an RE2-incompatible lookahead', () => {
    expect(validateRule(userRule({ steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'foo(?=bar)' }] }), 'global').rule).toBeNull()
  })
  it('rejects a path_matches value using a backreference', () => {
    expect(validateRule(userRule({ steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '(a)\\1' }] }), 'global').rule).toBeNull()
  })
  it('accepts a normal path_matches regex (alternation, anchors, char classes)', () => {
    expect(validateRule(userRule({ steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '(^|/)su$|/data/adb' }] }), 'global').rule).not.toBeNull()
  })
  it('canonicalizes an arg_hex_eq value to lowercase minimal hex', () => {
    const upper = validateRule(userRule({ steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0xDEADBEEF' }] }), 'global').rule
    expect(upper!.steps[0].value).toBe('0xdeadbeef')
    const padded = validateRule(userRule({ steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x0010' }] }), 'global').rule
    expect(padded!.steps[0].value).toBe('0x10')
  })
})

describe('coerceRules', () => {
  it('keeps valid rules and collects an error per malformed entry', () => {
    const { rules, errors } = coerceRules([userRule(), { garbage: true }], 'global')
    expect(rules).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })
})

// The schema-v3 rule-library overhaul renamed hook-maps -> hook-maps-open,
// dbg-status-open -> dbg-tracerpid, dbg-ptrace-attach -> dbg-ptrace-selftrace,
// and deleted dbg-status-read and hook-frida-sock outright. A persisted
// enabledOverride on any of those old ids has to survive the upgrade rather
// than silently re-enabling whatever now sits at that id.
describe('migrateRuleId', () => {
  it('maps each renamed id to its replacement', () => {
    expect(migrateRuleId('hook-maps')).toBe('hook-maps-open')
    expect(migrateRuleId('dbg-status-open')).toBe('dbg-tracerpid')
    expect(migrateRuleId('dbg-ptrace-attach')).toBe('dbg-ptrace-selftrace')
  })
  it('maps each deleted id to null', () => {
    expect(migrateRuleId('dbg-status-read')).toBeNull()
    expect(migrateRuleId('hook-frida-sock')).toBeNull()
  })
  it('leaves an unrelated id untouched', () => {
    expect(migrateRuleId('dbg-tracerpid')).toBe('dbg-tracerpid')
  })
})

describe('coerceOverrides', () => {
  it('survives an override on a renamed id, landing on the replacement', () => {
    expect(coerceOverrides({ 'hook-maps': false })).toEqual({ 'hook-maps-open': false })
  })
  it('drops an override on a deleted id without error', () => {
    expect(coerceOverrides({ 'dbg-status-read': false, 'dbg-tracerpid': true })).toEqual({ 'dbg-tracerpid': true })
  })
  it('ignores non-boolean values and non-object input', () => {
    expect(coerceOverrides({ x: 'not a bool' })).toEqual({})
    expect(coerceOverrides(null)).toEqual({})
  })
})

describe('resolveRules', () => {
  it('returns the built-ins unchanged when no user scopes contribute', () => {
    const out = resolveRules(BUILTIN_RULES, EMPTY, EMPTY)
    expect(out.map(r => r.id)).toEqual(BUILTIN_RULES.map(r => r.id))
    expect(out.every(r => r.enabled)).toBe(true)
  })
  it('appends global then project rules, deterministic order', () => {
    const g = userRule({ id: 'g', source: 'global' })
    const p = userRule({ id: 'p', source: 'project' })
    const out = resolveRules(BUILTIN_RULES, { rules: [g], enabledOverrides: {} }, { rules: [p], enabledOverrides: {} })
    const tail = out.slice(-2).map(r => r.id)
    expect(tail).toEqual(['g', 'p'])
  })
  it('project overrides global on id collision (body + source)', () => {
    const g = userRule({ id: 'dup', source: 'global', confidence: 0.3 })
    const p = userRule({ id: 'dup', source: 'project', confidence: 0.9 })
    const out = resolveRules(BUILTIN_RULES, { rules: [g], enabledOverrides: {} }, { rules: [p], enabledOverrides: {} })
    const dup = out.find(r => r.id === 'dup')!
    expect(dup.confidence).toBe(0.9)
    expect(dup.source).toBe('project')
  })
  it('a global enabledOverride can disable a built-in', () => {
    const g: RuleScope = { rules: [], enabledOverrides: { 'dbg-ptrace-traceme': false } }
    const out = resolveRules(BUILTIN_RULES, g, EMPTY)
    expect(out.find(r => r.id === 'dbg-ptrace-traceme')!.enabled).toBe(false)
  })
  it('a project enabledOverride re-enables a globally-disabled built-in (later scope wins)', () => {
    const g: RuleScope = { rules: [], enabledOverrides: { 'dbg-ptrace-traceme': false } }
    const p: RuleScope = { rules: [], enabledOverrides: { 'dbg-ptrace-traceme': true } }
    const out = resolveRules(BUILTIN_RULES, g, p)
    expect(out.find(r => r.id === 'dbg-ptrace-traceme')!.enabled).toBe(true)
  })
})

describe('rule schema v2', () => {
  const step = { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' }

  it('reads a legacy single-predicate rule as a one-step sequence', () => {
    const { rule, error } = validateRule(
      { id: 'legacy', category: 'root', confidence: 0.5, rationale: 'r', match: step }, 'project')
    expect(error).toBeNull()
    expect(rule!.steps).toEqual([{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' }])
    expect(rule!.correlate).toBe('symbol+tid')
    expect(rule!.maxGap).toBe(50)
  })

  it('accepts an explicit multi-step rule', () => {
    const { rule, error } = validateRule({
      id: 'seq', category: 'hook', confidence: 0.9, rationale: 'r',
      steps: [step, { ...step, value: 'frida' }], correlate: 'module+tid', maxGap: 10,
    }, 'project')
    expect(error).toBeNull()
    expect(rule!.steps).toHaveLength(2)
    expect(rule!.correlate).toBe('module+tid')
    expect(rule!.maxGap).toBe(10)
  })

  it('rejects an empty step list', () => {
    const { error } = validateRule(
      { id: 'x', category: 'root', confidence: 0.5, rationale: 'r', steps: [] }, 'project')
    expect(error).toMatch(/steps/)
  })

  it('rejects an unknown correlate mode', () => {
    const { error } = validateRule(
      { id: 'x', category: 'root', confidence: 0.5, rationale: 'r', steps: [step], correlate: 'thread' }, 'project')
    expect(error).toMatch(/correlate/)
  })

  it('rejects a non-positive maxGap', () => {
    const { error } = validateRule(
      { id: 'x', category: 'root', confidence: 0.5, rationale: 'r', steps: [step], maxGap: 0 }, 'project')
    expect(error).toMatch(/maxGap/)
  })

  it('every built-in is a one-step rule, except the multi-step sequences', () => {
    const multiStep: Record<string, number> = { 'hook-frida-scan': 2, 'hook-fd-enum': 2, 'dbg-tracer-fork': 3 }
    for (const r of BUILTIN_RULES) expect(r.steps).toHaveLength(multiStep[r.id] ?? 1)
  })
})

describe('rule schema v3', () => {
  it('defaults mode to ordered and minOccurrences to 1 when absent (v1/v2 rules)', () => {
    const { rule, error } = validateRule({
      id: 'legacy', category: 'root', confidence: 0.5, rationale: 'r',
      match: { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' },
    }, 'global')
    expect(error).toBeNull()
    expect(rule!.mode).toBe('ordered')
    expect(rule!.minOccurrences).toBe(1)
  })

  it('accepts an explicit unordered mode and minOccurrences', () => {
    const { rule } = validateRule({
      id: 'u', category: 'hook', confidence: 0.9, rationale: 'r', mode: 'unordered', minOccurrences: 20,
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'a' }],
    }, 'global')
    expect(rule!.mode).toBe('unordered')
    expect(rule!.minOccurrences).toBe(20)
  })

  it('rejects an unknown mode', () => {
    const { rule, error } = validateRule({
      id: 'bad', category: 'hook', confidence: 0.9, rationale: 'r', mode: 'sideways',
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'a' }],
    }, 'global')
    expect(rule).toBeNull()
    expect(error).toBe('bad mode on bad')
  })

  it('rejects a non-positive or fractional minOccurrences', () => {
    for (const bad of [0, -1, 2.5]) {
      const { rule, error } = validateRule({
        id: 'm', category: 'hook', confidence: 0.9, rationale: 'r', minOccurrences: bad,
        steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'a' }],
      }, 'global')
      expect(rule).toBeNull()
      expect(error).toBe('minOccurrences must be a positive integer on m')
    }
  })

  it('every built-in spec passes validation', () => {
    expect(BUILTIN_RULES.length).toBeGreaterThan(0)
    for (const r of BUILTIN_RULES) {
      expect(r.mode).toBeDefined()
      expect(r.minOccurrences).toBeGreaterThanOrEqual(1)
      expect(r.source).toBe('builtin')
    }
  })
})
