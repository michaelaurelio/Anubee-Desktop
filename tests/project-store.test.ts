import { describe, it, expect } from 'vitest'
import {
  parseSidecar, serializeSidecar, upsertTag, removeTag, tagsByTarget, orphanedTags,
  addDismissed, isDismissed, openSuggestions, type Tag, type RaspCategory,
} from '../src/shared/project-store'
import type { Suggestion } from '../src/shared/rasp-heuristics'

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
    expect(removeTag([a, b], 'nat:libexample.so!check_su', undefined, 'root')).toEqual([b])
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
    steps: [{ syscalls: ['openat'], field: 'string_args', op: 'equals', value: '/x' }], correlate: 'symbol+tid', maxGap: 50 }

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

describe('dismissed suggestions', () => {
  it('addDismissed is idempotent and isDismissed matches (target, category)', async () => {
    const { addDismissed, isDismissed } = await import('@shared/project-store')
    let d = addDismissed([], 'nat:libsentinel.so!chk', 'root')
    d = addDismissed(d, 'nat:libsentinel.so!chk', 'root') // dup
    expect(d).toHaveLength(1)
    expect(isDismissed(d, 'nat:libsentinel.so!chk', 'root')).toBe(true)
    expect(isDismissed(d, 'nat:libsentinel.so!chk', 'debugger')).toBe(false)
  })
  it('serialize -> parse round-trips the dismissed list', async () => {
    const { serializeSidecar, parseSidecar } = await import('@shared/project-store')
    const text = serializeSidecar({ file: 'r.jsonl', ingestedAt: 'now' }, [], [], {}, [{ target: 'nat:x', category: 'hook' }])
    const back = parseSidecar(text)
    expect(back.dismissed).toEqual([{ target: 'nat:x', category: 'hook' }])
  })
})

describe('sidecar schemaVersion', () => {
  it('reads a v1 sidecar and writes v2', () => {
    const v1 = JSON.stringify({
      schemaVersion: 1, run: { file: 'r.jsonl', ingestedAt: 'now' }, tags: [], rules: [], enabledOverrides: {},
    })
    expect(parseSidecar(v1).errors).toEqual([])
    const out = JSON.parse(serializeSidecar({ file: 'r.jsonl', ingestedAt: 'now' }, []))
    expect(out.schemaVersion).toBe(2)
  })
})

describe('tag identity includes category', () => {
  const t = (category: RaspCategory, offset?: string): Tag =>
    ({ target: 'nat:libsentinel.so!chk', offset, category, source: 'manual', createdAt: 'now' })

  it('keeps two categories on the same target and offset', () => {
    const tags = upsertTag(upsertTag([], t('root')), t('hook'))
    expect(tags).toHaveLength(2)
  })
  it('still replaces the same category on the same target and offset', () => {
    const tags = upsertTag(upsertTag([], t('root')), { ...t('root'), note: 'second' })
    expect(tags).toHaveLength(1)
    expect(tags[0].note).toBe('second')
  })
  it('keeps the same category at different offsets', () => {
    const tags = upsertTag(upsertTag([], t('root', '0x88c')), t('root', '0xabc'))
    expect(tags).toHaveLength(2)
  })
  it('removes only the named category', () => {
    const tags = removeTag(upsertTag(upsertTag([], t('root')), t('hook')), 'nat:libsentinel.so!chk', undefined, 'root')
    expect(tags.map(x => x.category)).toEqual(['hook'])
  })
})

describe('dismissal offsets', () => {
  it('a row-level dismissal covers every call site', () => {
    const d = addDismissed([], 'n', 'hook')
    expect(isDismissed(d, 'n', 'hook')).toBe(true)
    expect(isDismissed(d, 'n', 'hook', '0x88c')).toBe(true)
  })
  it('a call-site dismissal covers only that call site', () => {
    const d = addDismissed([], 'n', 'hook', '0x88c')
    expect(isDismissed(d, 'n', 'hook', '0x88c')).toBe(true)
    expect(isDismissed(d, 'n', 'hook', '0xabc')).toBe(false)
    expect(isDismissed(d, 'n', 'hook')).toBe(false)
  })
  it('reads a legacy dismissal with no offset as row-level', () => {
    const back = parseSidecar(JSON.stringify({
      schemaVersion: 1, run: { file: 'r', ingestedAt: 'n' }, tags: [],
      dismissed: [{ target: 'n', category: 'hook' }],
    }))
    expect(isDismissed(back.dismissed, 'n', 'hook', '0x88c')).toBe(true)
  })
})

describe('openSuggestions', () => {
  const sugg = (over: Partial<Suggestion> = {}): Suggestion => ({
    target: 'nat:libsentinel.so!chk', category: 'hook', confidence: 0.9,
    rationale: 'maps scan', occurrences: 3,
    offsets: [{ offset: '0x88c', occurrences: 2 }, { offset: '0xabc', occurrences: 1 }],
    ...over,
  })
  const tag = (over: Partial<Tag> = {}): Tag => ({
    target: 'nat:libsentinel.so!chk', category: 'hook', source: 'heuristic',
    createdAt: '2026-07-06T00:00:00.000Z', ...over,
  })

  it('a confirmed call-site tag removes only that child', () => {
    const [s] = openSuggestions([sugg()], [tag({ offset: '0x88c' })], [])
    expect(s.offsets.map(o => o.offset)).toEqual(['0xabc'])
  })

  it('a call-site dismissal removes only that child', () => {
    const [s] = openSuggestions([sugg()], [], [{ target: sugg().target, category: 'hook', offset: '0x88c' }])
    expect(s.offsets.map(o => o.offset)).toEqual(['0xabc'])
  })

  it('a row-level dismissal still removes the whole row', () => {
    expect(openSuggestions([sugg()], [], [{ target: sugg().target, category: 'hook' }])).toEqual([])
  })

  it('a row with every child actioned still renders as a row', () => {
    const [s] = openSuggestions([sugg()], [tag({ offset: '0x88c' }), tag({ offset: '0xabc' })], [])
    expect(s).toBeDefined()
    expect(s.offsets).toEqual([])
  })

  it('a child whose offset was not actioned still renders', () => {
    const [s] = openSuggestions([sugg()], [tag({ offset: '0x88c' })], [])
    expect(s.offsets.map(o => o.offset)).toContain('0xabc')
  })
})
