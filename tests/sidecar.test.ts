import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sidecarPath, loadTags, saveTags } from '../src/main/sidecar'
import type { Tag } from '../src/shared/project-store'

const tag: Tag = {
  target: 'nat:libexample.so!check_su', category: 'root', source: 'manual',
  createdAt: '2026-07-06T00:00:00.000Z',
}

describe('sidecar fs', () => {
  it('derives the sidecar path from the run file', () => {
    expect(sidecarPath('/x/run.jsonl')).toBe('/x/run.jsonl.ares-desktop.json')
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
})
