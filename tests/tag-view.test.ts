import { describe, it, expect } from 'vitest'
import { badgeText, newManualTag } from '../src/renderer/tag-view'
import type { Tag } from '../src/shared/project-store'

const tag = (over: Partial<Tag> = {}): Tag => ({
  target: 'sys:openat', category: 'root', source: 'manual',
  createdAt: '2026-07-06T00:00:00.000Z', ...over,
})

describe('tag-view helpers', () => {
  it('badgeText joins distinct categories', () => {
    expect(badgeText([tag(), tag({ category: 'debugger' })])).toBe('[root,debugger]')
  })
  it('badgeText collapses duplicate categories', () => {
    expect(badgeText([tag(), tag({ category: 'root' })])).toBe('[root]')
  })
  it('badgeText is empty with no tags', () => {
    expect(badgeText([])).toBe('')
  })
  it('newManualTag builds a manual tag with the given fields', () => {
    expect(newManualTag('sys:openat', 'root', undefined, 'note', 'T')).toEqual({
      target: 'sys:openat', category: 'root', note: 'note', source: 'manual', createdAt: 'T',
    })
  })
  it('newManualTag omits an empty note and carries an offset', () => {
    expect(newManualTag('nat:libexample.so!check_su', 'debugger', 'libexample.so+0x10', '', 'T')).toEqual({
      target: 'nat:libexample.so!check_su', category: 'debugger',
      offset: 'libexample.so+0x10', source: 'manual', createdAt: 'T',
    })
  })
})
