import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules, saveRules } from '../src/main/rasp-rules-store'
import type { Rule } from '../src/shared/rasp-heuristics'

const dir = () => mkdtempSync(join(tmpdir(), 'anubee-rules-'))
const rule: Rule = { id: 'u-1', category: 'custom', confidence: 0.5, rationale: 'r', enabled: true, source: 'global',
  match: { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'foo' } }

describe('rasp-rules-store', () => {
  it('returns an empty scope when the file is absent', () => {
    expect(loadRules(dir())).toEqual({ rules: [], enabledOverrides: {} })
  })
  it('round-trips rules and enabledOverrides', () => {
    const d = dir()
    saveRules(d, { rules: [rule], enabledOverrides: { 'dbg-ptrace-traceme': false } })
    const back = loadRules(d)
    expect(back.rules.map(r => r.id)).toEqual(['u-1'])
    expect(back.rules[0].source).toBe('global')
    expect(back.enabledOverrides).toEqual({ 'dbg-ptrace-traceme': false })
  })
  it('tolerates an unknown schemaVersion by returning empty', () => {
    const d = dir()
    writeFileSync(join(d, 'rasp-rules.json'), JSON.stringify({ schemaVersion: 999, rules: [rule] }))
    expect(loadRules(d)).toEqual({ rules: [], enabledOverrides: {} })
  })
  it('drops a malformed rule but keeps valid ones (tolerant load)', () => {
    const d = dir()
    writeFileSync(join(d, 'rasp-rules.json'), JSON.stringify({ schemaVersion: 1, rules: [rule, { junk: 1 }], enabledOverrides: {} }))
    expect(loadRules(d).rules.map(r => r.id)).toEqual(['u-1'])
  })
  it('tolerates invalid JSON', () => {
    const d = dir()
    writeFileSync(join(d, 'rasp-rules.json'), '{ not json')
    expect(loadRules(d)).toEqual({ rules: [], enabledOverrides: {} })
  })
})
