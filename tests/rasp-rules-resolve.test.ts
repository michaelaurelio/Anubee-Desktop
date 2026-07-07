import { describe, it, expect } from 'vitest'
import {
  BUILTIN_RULES, validateRule, coerceRules, resolveRules,
  type Rule, type RuleScope,
} from '../src/shared/rasp-heuristics'

const EMPTY: RuleScope = { rules: [], enabledOverrides: {} }

const userRule = (over: Partial<Rule> = {}): Rule => ({
  id: 'u-1', category: 'custom', confidence: 0.5, rationale: 'user rule', enabled: true,
  match: { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'foo' },
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
    expect(byId.get('dbg-ptrace-attach')!.match.value).toBe('0x10')
    expect(byId.get('hook-frida-sock')!.match.field).toBe('sock_addr')
    expect(byId.get('root-selinux')).toBeTruthy()
    expect(byId.get('root-ksu-prctl')!.match.op).toBe('arg_hex_eq')
    // emulator/integrity ship NO built-in rule (not syscall-detectable)
    expect(BUILTIN_RULES.some(r => r.category === 'emulator')).toBe(false)
    expect(BUILTIN_RULES.some(r => r.category === 'integrity')).toBe(false)
  })
})

describe('validateRule', () => {
  it('rejects an empty id', () => {
    expect(validateRule(userRule({ id: '' }), 'global').rule).toBeNull()
  })
  it('rejects an empty syscalls set', () => {
    expect(validateRule(userRule({ match: { syscalls: [], field: 'args', op: 'equals', value: 'x' } }), 'global').rule).toBeNull()
  })
  it('rejects confidence out of [0,1]', () => {
    expect(validateRule(userRule({ confidence: 1.5 }), 'global').rule).toBeNull()
  })
  it('rejects arg_hex_eq without argIndex', () => {
    expect(validateRule(userRule({ match: { syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', value: '0x10' } }), 'global').rule).toBeNull()
  })
  it('rejects arg_hex_eq with a non-hex value', () => {
    expect(validateRule(userRule({ match: { syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: 'nope' } }), 'global').rule).toBeNull()
  })
  it('rejects a path_matches value that is not a valid regex', () => {
    expect(validateRule(userRule({ match: { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '(' } }), 'global').rule).toBeNull()
  })
  it('stamps the source and defaults missing enabled to true', () => {
    const raw = { ...userRule() } as Record<string, unknown>
    delete raw.enabled
    const r = validateRule(raw, 'project').rule
    expect(r).not.toBeNull()
    expect(r!.enabled).toBe(true)
    expect(r!.source).toBe('project')
  })
})

describe('coerceRules', () => {
  it('keeps valid rules and collects an error per malformed entry', () => {
    const { rules, errors } = coerceRules([userRule(), { garbage: true }], 'global')
    expect(rules).toHaveLength(1)
    expect(errors).toHaveLength(1)
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
