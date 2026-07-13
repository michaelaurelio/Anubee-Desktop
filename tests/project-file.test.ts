import { describe, it, expect } from 'vitest'
import { serializeProject, parseProject, type ProjectBundle } from '../src/shared/project-file'

const bundle: ProjectBundle = {
  formatVersion: 1, savedAt: '2026-07-14T00:00:00Z',
  run: { path: '/runs/x.jsonl', engine: 'syscall', eventCount: 100 },
  tags: [], dismissed: [], ruleOverrides: [],
}
describe('project-file', () => {
  it('round-trips', () => {
    const p = parseProject(serializeProject(bundle))
    expect(p.error).toBeUndefined()
    expect(p.bundle?.run.path).toBe('/runs/x.jsonl')
  })
  it('rejects malformed json', () => {
    const p = parseProject('{not json')
    expect(p.bundle).toBeNull(); expect(p.error).toBeTruthy()
  })
  it('rejects a bundle missing run.path', () => {
    const p = parseProject(JSON.stringify({ formatVersion: 1, run: {} }))
    expect(p.bundle).toBeNull()
  })
  it('rejects an unknown formatVersion', () => {
    const p = parseProject(JSON.stringify({ ...bundle, formatVersion: 99 }))
    expect(p.bundle).toBeNull()
  })
})
