// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { showRecordDetail } from '../src/renderer/inspector'
import type { SyscallEvent } from '@shared/events'

const ev = (over: Partial<SyscallEvent> = {}): SyscallEvent => ({
  type: 'syscall', id: 9, pid: 1, tid: 237, syscall_nr: 48, syscall: 'faccessat',
  args: [], retval: -2, string_args: { '1': '/data/app/base.apk' }, fd_args: {},
  decoded_args: {}, java_stack: [], backtrace: [], ...over,
})

describe('showRecordDetail', () => {
  it('writes a header and the detail cards', () => {
    const host = document.createElement('div')
    showRecordDetail(host, ev())
    expect(host.querySelector('.insp-head')?.textContent).toBe('#9 · faccessat · tid 237')
    expect(host.querySelectorAll('.insp-card').length).toBeGreaterThan(0)
  })
  it('clears prior content on re-render', () => {
    const host = document.createElement('div')
    showRecordDetail(host, ev({ id: 1 }))
    showRecordDetail(host, ev({ id: 2 }))
    expect(host.querySelectorAll('.insp-head').length).toBe(1)
  })
})
