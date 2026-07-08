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
