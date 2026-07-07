import { describe, it, expect } from 'vitest'
import {
  parseSidecar, serializeSidecar, upsertTag, removeTag, tagsByTarget, orphanedTags, type Tag,
} from '../src/shared/project-store'

const tag = (over: Partial<Tag> = {}): Tag => ({
  target: 'nat:libexample.so!check_su', category: 'root', source: 'manual',
  createdAt: '2026-07-06T00:00:00.000Z', ...over,
})

describe('project-store', () => {
  it('round-trips a sidecar', () => {
    const text = serializeSidecar({ file: 'run.jsonl', ingestedAt: 'T' }, [tag()])
    const { tags, errors } = parseSidecar(text)
    expect(errors).toEqual([])
    expect(tags).toEqual([tag()])
  })

  it('tolerates corrupt input without throwing', () => {
    const { tags, errors } = parseSidecar('{not json')
    expect(tags).toEqual([])
    expect(errors.length).toBeGreaterThan(0)
  })

  it('drops malformed tag entries but keeps valid ones', () => {
    const text = JSON.stringify({
      schemaVersion: 1, run: { file: 'f', ingestedAt: 'T' },
      tags: [tag(), { target: 'x' /* missing category/source/createdAt */ }],
    })
    const { tags, errors } = parseSidecar(text)
    expect(tags).toEqual([tag()])
    expect(errors.length).toBe(1)
  })

  it('upsert replaces a tag with the same (target, offset) identity', () => {
    const a = tag({ note: 'first' })
    const b = tag({ note: 'second' })
    expect(upsertTag([a], b)).toEqual([b])
  })

  it('upsert keeps tags that differ only by offset', () => {
    const a = tag({ offset: 'libexample.so+0x10' })
    const b = tag({ offset: 'libexample.so+0x20' })
    expect(upsertTag([a], b)).toEqual([a, b])
  })

  it('remove drops the matching (target, offset) tag', () => {
    const a = tag()
    const b = tag({ offset: 'libexample.so+0x10' })
    expect(removeTag([a, b], 'nat:libexample.so!check_su')).toEqual([b])
  })

  it('tagsByTarget returns all tags on a target', () => {
    const a = tag()
    const b = tag({ offset: 'libexample.so+0x10' })
    const c = tag({ target: 'sys:openat' })
    expect(tagsByTarget([a, b, c], 'nat:libexample.so!check_su')).toEqual([a, b])
  })

  it('orphanedTags selects the tags whose target is in the orphan set', () => {
    const live = tag({ target: 'sys:openat' })
    const gone = tag({ target: 'nat:libexample.so!removed' })
    expect(orphanedTags([live, gone], new Set(['nat:libexample.so!removed']))).toEqual([gone])
    expect(orphanedTags([live, gone], new Set())).toEqual([])
  })
})

import { parseSidecar as _parseSidecar, serializeSidecar as _serializeSidecar } from '../src/shared/project-store'
import type { Rule as _Rule } from '../src/shared/rasp-heuristics'

describe('sidecar rules', () => {
  const projRule: _Rule = { id: 'p-1', category: 'custom', confidence: 0.4, rationale: 'proj', enabled: true, source: 'project',
    match: { syscalls: ['openat'], field: 'string_args', op: 'equals', value: '/x' } }

  it('round-trips rules and enabledOverrides through serialize/parse', () => {
    const text = _serializeSidecar({ file: 'run.jsonl', ingestedAt: 'now' }, [], [projRule], { 'root-paths': false })
    const back = _parseSidecar(text)
    expect(back.rules.map(r => r.id)).toEqual(['p-1'])
    expect(back.rules[0].source).toBe('project')
    expect(back.enabledOverrides).toEqual({ 'root-paths': false })
  })

  it('defaults rules/enabledOverrides to empty when the sidecar predates them', () => {
    const back = _parseSidecar(JSON.stringify({ schemaVersion: 1, run: { file: 'r', ingestedAt: 'x' }, tags: [] }))
    expect(back.rules).toEqual([])
    expect(back.enabledOverrides).toEqual({})
  })
})
