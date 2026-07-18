import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sidecarPath, loadTags, saveTags, loadSidecarRules, saveSidecarRules } from '../src/main/sidecar'
import { serializeSidecar, type Tag } from '../src/shared/project-store'
import type { Rule } from '@shared/rasp-heuristics'

const tag: Tag = {
  target: 'nat:libexample.so!check_su', category: 'root', source: 'manual',
  createdAt: '2026-07-06T00:00:00.000Z',
}

const RULE: Rule = {
  id: 'proj-1', category: 'root', confidence: 0.8, rationale: 'test',
  enabled: true, source: 'project',
  match: { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'magisk' },
}

describe('sidecar fs', () => {
  it('derives the sidecar path from the run file', () => {
    expect(sidecarPath('/x/run.jsonl')).toBe('/x/run.jsonl.anubee-desktop.json')
  })

  it('reads a legacy .ares-desktop.json sidecar written before the rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anubee-sc-'))
    const run = join(dir, 'run.jsonl'); writeFileSync(run, '')
    writeFileSync(`${run}.ares-desktop.json`,
      serializeSidecar({ file: run, ingestedAt: 'T' }, [tag], [], {}, []))
    expect(loadTags(run)).toEqual({ tags: [tag], errors: [] })
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the new extension and prefers it over a stale legacy sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anubee-sc-'))
    const run = join(dir, 'run.jsonl'); writeFileSync(run, '')
    writeFileSync(`${run}.ares-desktop.json`,
      serializeSidecar({ file: run, ingestedAt: 'T' }, [tag], [], {}, []))
    saveTags(run, 'T', []) // migrate forward: writes .anubee-desktop.json with no tags
    expect(existsSync(`${run}.anubee-desktop.json`)).toBe(true)
    expect(loadTags(run).tags).toEqual([]) // new sidecar wins over the legacy one
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty tags with no error when the sidecar is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ares-'))
    expect(loadTags(join(dir, 'run.jsonl'))).toEqual({ tags: [], errors: [] })
  })

  it('saves then loads tags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ares-'))
    const run = join(dir, 'run.jsonl')
    writeFileSync(run, '')
    saveTags(run, 'T', [tag])
    expect(existsSync(sidecarPath(run))).toBe(true)
    expect(loadTags(run)).toEqual({ tags: [tag], errors: [] })
  })

  it('saveSidecarRules writes rules and preserves existing tags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ares-sidecar-'))
    const run = join(dir, 'run.jsonl')
    writeFileSync(run, '')
    // seed a tag first
    saveTags(run, '2026-07-07T00:00:00Z', [{ target: 'sys:openat', category: 'root', source: 'manual', createdAt: 'T' }])
    // then author a project rule
    saveSidecarRules(run, '2026-07-07T00:00:00Z', [RULE], { 'dbg-ptrace-attach': false })
    expect(loadSidecarRules(run).rules).toEqual([RULE])
    expect(loadSidecarRules(run).enabledOverrides).toEqual({ 'dbg-ptrace-attach': false })
    expect(loadTags(run).tags).toHaveLength(1) // tag survived the rule write
    rmSync(dir, { recursive: true, force: true })
  })
})
