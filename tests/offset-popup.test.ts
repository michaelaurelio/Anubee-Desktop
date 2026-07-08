import { describe, it, expect } from 'vitest'
import { popupState, eventForOffset } from '../src/renderer/offset-popup'
import type { OffsetRow } from '@shared/origins'
import type { SyscallEvent } from '@shared/events'

const row: OffsetRow = { module: 'libexample.so', offset: '0x10', symbol: 'check_su',
  reaches: ['openat'], argsSample: {}, count: 3, sampleEventId: 1 }

const ev = (id: number): SyscallEvent => ({
  type: 'syscall', id, pid: 1, tid: 1, syscall_nr: 1, syscall: 'openat',
  args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, backtrace: [],
})

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

describe('eventForOffset', () => {
  it('resolves the row sample event by id', () => {
    const events = [ev(1), ev(2), ev(3)]
    const r = { ...row, sampleEventId: 2 }
    expect(eventForOffset(events, r)?.id).toBe(2)
  })
  it('falls back to the first event when the sample is absent', () => {
    const events = [ev(5), ev(6)]
    const r = { ...row, sampleEventId: 999 }
    expect(eventForOffset(events, r)?.id).toBe(5)
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
