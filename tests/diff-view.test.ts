import { describe, it, expect } from 'vitest'
import { presenceColor, filterDiffRows } from '../src/renderer/diff-view'
import type { DiffRow } from '../src/shared/diff'

const row = (over: Partial<DiffRow>): DiffRow => ({
  id: 'sys:openat', kind: 'syscall', label: 'openat', countA: 1, countB: 1, delta: 0, presence: 'both', ...over,
})

describe('diff-view helpers', () => {
  it('colors presence red/green/grey', () => {
    expect(presenceColor('A-only')).toBe('#c0392b')
    expect(presenceColor('B-only')).toBe('#27ae60')
    expect(presenceColor('both')).toBe('#95a5a6')
  })

  it('filters only-in-A', () => {
    const rows = [row({ id: 'x', presence: 'A-only' }), row({ id: 'y', presence: 'both' })]
    expect(filterDiffRows(rows, 'only-in-A', new Set()).map(r => r.id)).toEqual(['x'])
  })

  it('filters tagged rows by target set', () => {
    const rows = [row({ id: 'x' }), row({ id: 'y' })]
    expect(filterDiffRows(rows, 'tagged', new Set(['y'])).map(r => r.id)).toEqual(['y'])
  })

  it('all mode passes everything through', () => {
    const rows = [row({ id: 'x', presence: 'A-only' }), row({ id: 'y' })]
    expect(filterDiffRows(rows, 'all', new Set())).toHaveLength(2)
  })
})
