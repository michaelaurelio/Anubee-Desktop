import { describe, it, expect } from 'vitest'
import { popupState, aggregateBySyscall } from '../src/renderer/offset-popup'
import type { OffsetRow } from '@shared/origins'

const row: OffsetRow = { module: 'libexample.so', offset: '0x10', symbol: 'check_su',
  syscall: 'openat', argsSample: {}, count: 3, sampleEventId: 1 }

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

describe('aggregateBySyscall', () => {
  it('folds distinct offsets of the same syscall into one summed row', () => {
    const rows: OffsetRow[] = [
      { ...row, offset: '0x10', syscall: 'openat', count: 5 },
      { ...row, offset: '0x40', syscall: 'openat', count: 3 },
      { ...row, offset: '0x80', syscall: 'read', count: 9 },
    ]
    expect(aggregateBySyscall(rows)).toEqual([
      { syscall: 'read', count: 9 },
      { syscall: 'openat', count: 8 },
    ])
  })
  it('breaks equal-count ties by syscall name ascending', () => {
    const rows: OffsetRow[] = [
      { ...row, offset: '0x10', syscall: 'read', count: 4 },
      { ...row, offset: '0x40', syscall: 'openat', count: 4 },
    ]
    expect(aggregateBySyscall(rows)).toEqual([
      { syscall: 'openat', count: 4 },
      { syscall: 'read', count: 4 },
    ])
  })
  it('returns an empty array for no rows', () => {
    expect(aggregateBySyscall([])).toEqual([])
  })
})

import { placePopup, type NodeBox } from '../src/renderer/offset-popup'

describe('placePopup', () => {
  const vp = { w: 1000, h: 800 }
  it('sits to the right of the node when it fits', () => {
    const box: NodeBox = { left: 50, top: 200, right: 150, bottom: 240 }
    // right: 150 + 12 = 162. vertical center: 200 + (40 - 300)/2 = 70.
    expect(placePopup(box, 400, 300, vp)).toEqual({ left: 162, top: 70 })
  })
  it('flips to the left when the right would overflow', () => {
    const box: NodeBox = { left: 900, top: 100, right: 980, bottom: 140 }
    // 980 + 12 + 400 = 1392 > 1000 -> flip: 900 - 12 - 400 = 488.
    expect(placePopup(box, 400, 300, vp).left).toBe(488)
  })
  it('clamps the flipped-left edge to 8', () => {
    const box: NodeBox = { left: 100, top: 100, right: 900, bottom: 140 }
    // right overflows; flip 100 - 12 - 400 = -312 -> clamp 8.
    expect(placePopup(box, 400, 300, vp).left).toBe(8)
  })
  it('clamps the vertical position into the viewport', () => {
    const low: NodeBox = { left: 50, top: 700, right: 150, bottom: 740 }
    // center 700 + (40-300)/2 = 570; max top = 800 - 300 - 8 = 492 -> 492.
    expect(placePopup(low, 400, 300, vp).top).toBe(492)
    const high: NodeBox = { left: 50, top: 0, right: 150, bottom: 40 }
    // center 0 + (40-300)/2 = -130 -> clamp 8.
    expect(placePopup(high, 400, 300, vp).top).toBe(8)
  })
})
