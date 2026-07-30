import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules, saveRules } from '../src/main/rasp-rules-store'
import type { Rule } from '../src/shared/rasp-heuristics'

const dir = () => mkdtempSync(join(tmpdir(), 'anubee-rules-'))
const rule: Rule = { id: 'u-1', category: 'custom', confidence: 0.5, rationale: 'r', enabled: true, source: 'global',
  steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'foo' }], correlate: 'symbol+tid', maxGap: 50,
  mode: 'ordered', minOccurrences: 1 }

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
  it('reads a v1 file and upgrades its rule to a one-step sequence', () => {
    const d = dir()
    writeFileSync(join(d, 'rasp-rules.json'), JSON.stringify({
      schemaVersion: 1,
      rules: [{ id: 'old', category: 'root', confidence: 0.5, rationale: 'r', enabled: true,
                match: { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' } }],
      enabledOverrides: {},
    }))
    const back = loadRules(d)
    expect(back.rules).toHaveLength(1)
    expect(back.rules[0].steps).toHaveLength(1)
    expect(back.rules[0].correlate).toBe('symbol+tid')
  })

  it('writes schemaVersion 3', () => {
    const d = dir()
    saveRules(d, { rules: [], enabledOverrides: {} })
    expect(JSON.parse(readFileSync(join(d, 'rasp-rules.json'), 'utf8')).schemaVersion).toBe(3)
  })

  it('rejects an unknown future schema version', () => {
    const d = dir()
    writeFileSync(join(d, 'rasp-rules.json'), JSON.stringify({ schemaVersion: 3, rules: [], enabledOverrides: {} }))
    expect(loadRules(d)).toEqual({ rules: [], enabledOverrides: {} })
  })

  it('writes schemaVersion 3 and still reads 1 and 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rasp-v3-'))
    saveRules(dir, { rules: [], enabledOverrides: { 'root-paths': false } })
    const written = JSON.parse(readFileSync(join(dir, 'rasp-rules.json'), 'utf8'))
    expect(written.schemaVersion).toBe(3)

    for (const v of [1, 2, 3]) {
      writeFileSync(join(dir, 'rasp-rules.json'), JSON.stringify({
        schemaVersion: v, rules: [], enabledOverrides: { x: true },
      }))
      expect(loadRules(dir).enabledOverrides).toEqual({ x: true })
    }

    writeFileSync(join(dir, 'rasp-rules.json'), JSON.stringify({
      schemaVersion: 4, rules: [], enabledOverrides: { x: true },
    }))
    expect(loadRules(dir).enabledOverrides).toEqual({})
    rmSync(dir, { recursive: true, force: true })
  })
})
