import { describe, it, expect } from 'vitest'
import { popupState } from '../src/renderer/offset-popup'
import type { OffsetRow } from '@shared/origins'

const row: OffsetRow = { module: 'libexample.so', offset: '0x10', symbol: 'check_su',
  reaches: ['openat'], argsSample: {}, count: 3 }

describe('popupState', () => {
  it('reports empty when there are no rows', () => {
    expect(popupState([])).toEqual({ kind: 'empty', rows: [] })
  })
  it('reports rows otherwise, including an [unmapped] row', () => {
    const unmapped: OffsetRow = { ...row, offset: '[unmapped]' }
    const s = popupState([row, unmapped])
    expect(s.kind).toBe('rows')
    expect(s.rows).toHaveLength(2)
  })
})
