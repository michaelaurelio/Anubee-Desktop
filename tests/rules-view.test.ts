import { describe, it, expect } from 'vitest'
import { draftFromForm, predicateSummary, sequenceSummary, upsertRule, deleteRule, setEnabled } from '../src/renderer/rules-view'
import { validateRule } from '@shared/rasp-heuristics'
import type { Rule, RuleScope } from '@shared/rasp-heuristics'

const R: Rule = {
  id: 'a', category: 'root', confidence: 0.8, rationale: 'r', enabled: true, source: 'global',
  steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' }],
  correlate: 'symbol+tid', maxGap: 50,
}

describe('rules-view helpers', () => {
  it('draftFromForm omits argIndex for non-hex ops', () => {
    const d = draftFromForm({ id: 'a', category: 'root', confidence: 0.8, rationale: 'r', enabled: true,
      correlate: 'symbol+tid', maxGap: 50,
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' }] })
    expect(d).toEqual({ id: 'a', category: 'root', confidence: 0.8, rationale: 'r', enabled: true,
      correlate: 'symbol+tid', maxGap: 50,
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' }] })
  })

  it('draftFromForm includes argIndex for arg_hex_eq', () => {
    const d = draftFromForm({ id: 'p', category: 'debugger', confidence: 0.7, rationale: 'r', enabled: true,
      correlate: 'symbol+tid', maxGap: 50,
      steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x10' }] })
    expect((d.steps as Record<string, unknown>[])[0].argIndex).toBe(0)
  })

  it('builds a multi-step draft the validator accepts', () => {
    const draft = draftFromForm({
      id: 'seq', category: 'hook', confidence: 0.9, rationale: 'r', enabled: true,
      correlate: 'module+tid', maxGap: 10,
      steps: [
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' },
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida' },
      ],
    })
    const { rule, error } = validateRule(draft, 'project')
    expect(error).toBeNull()
    expect(rule!.steps).toHaveLength(2)
    expect(rule!.correlate).toBe('module+tid')
    expect(rule!.maxGap).toBe(10)
  })

  it('summarises a sequence as its steps joined by an arrow', () => {
    expect(sequenceSummary({
      id: 'x', category: 'hook', confidence: 0.9, rationale: 'r', enabled: true, source: 'project',
      correlate: 'module+tid', maxGap: 10,
      steps: [
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'maps' },
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida' },
      ],
    })).toBe('string_args path_matches /maps/ → string_args path_matches /frida/')
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
