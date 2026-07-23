import { describe, it, expect } from 'vitest'
import { draftFromForm, predicateSummary, upsertRule, deleteRule, setEnabled } from '../src/renderer/rules-view'
import type { Rule, RuleScope } from '@shared/rasp-heuristics'

const R: Rule = {
  id: 'a', category: 'root', confidence: 0.8, rationale: 'r', enabled: true, source: 'global',
  steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' }],
  correlate: 'symbol+tid', maxGap: 50,
}

describe('rules-view helpers', () => {
  it('draftFromForm omits argIndex for non-hex ops', () => {
    const d = draftFromForm({ id: 'a', category: 'root', confidence: 0.8, rationale: 'r', enabled: true,
      syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' })
    expect(d).toEqual({ id: 'a', category: 'root', confidence: 0.8, rationale: 'r', enabled: true,
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' }] })
  })

  it('draftFromForm includes argIndex for arg_hex_eq', () => {
    const d = draftFromForm({ id: 'p', category: 'debugger', confidence: 0.7, rationale: 'r', enabled: true,
      syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x10' })
    expect((d.steps as Record<string, unknown>[])[0].argIndex).toBe(0)
  })

  it('predicateSummary renders path and hex predicates', () => {
    expect(predicateSummary(R.steps[0])).toBe('string_args path_matches /su/')
    expect(predicateSummary({ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x10' }))
      .toBe('args[0] arg_hex_eq 0x10')
  })

  it('upsertRule replaces by id', () => {
    const scope: RuleScope = { rules: [R], enabledOverrides: {} }
    const next = upsertRule(scope, { ...R, confidence: 0.9 })
    expect(next.rules).toHaveLength(1)
    expect(next.rules[0].confidence).toBe(0.9)
    expect(scope.rules[0].confidence).toBe(0.8) // original untouched
  })

  it('deleteRule removes the rule and its override', () => {
    const scope: RuleScope = { rules: [R], enabledOverrides: { a: false } }
    const next = deleteRule(scope, 'a')
    expect(next.rules).toHaveLength(0)
    expect(next.enabledOverrides).toEqual({})
  })

  it('setEnabled writes an override', () => {
    expect(setEnabled({ rules: [], enabledOverrides: {} }, 'dbg-ptrace-attach', false).enabledOverrides)
      .toEqual({ 'dbg-ptrace-attach': false })
  })
})
