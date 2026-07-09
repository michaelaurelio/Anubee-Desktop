import { describe, it, expect } from 'vitest'
import { formatEvent } from '../src/renderer/inspector'
import type { SyscallEvent } from '@shared/events'

const e: SyscallEvent = {
  type: 'syscall', id: 5, pid: 1, tid: 101, syscall_nr: 56, syscall: 'openat',
  args: ['0xffffff9c'], retval: 7, string_args: { '1': '/system/bin/su' },
  fd_args: {}, decoded_args: { '2': 'O_RDONLY' },
  java_stack: ['com.example.Sec.check'],
  backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check+0x10' }],
}

describe('formatEvent', () => {
  it('includes syscall, tid, retval, string/decoded args, java and backtrace', () => {
    const s = formatEvent(e)
    expect(s).toContain('openat')
    expect(s).toContain('tid 101')
    expect(s).toContain('retval 7')
    expect(s).toContain('/system/bin/su')
    expect(s).toContain('O_RDONLY')
    expect(s).toContain('com.example.Sec.check')
    expect(s).toContain('libexample.so!check+0x10')
  })

  it('does not crash on an incomplete record (no java_stack)', () => {
    const bare: SyscallEvent = { ...e, java_stack: undefined, string_args: {}, decoded_args: {} }
    const s = formatEvent(bare)
    expect(s).toContain('openat')
    expect(s).toContain('backtrace')
  })
})

describe('primaryArg', () => {
  it('prefers a resolved string arg (path)', async () => {
    const { primaryArg } = await import('../src/renderer/inspector')
    expect(primaryArg(e)).toBe('/system/bin/su')
  })
  it('falls back to the fd path, then decoded, then raw args', async () => {
    const { primaryArg } = await import('../src/renderer/inspector')
    expect(primaryArg({ ...e, string_args: {}, fd_args: { '0': '/proc/self/status' } })).toBe('/proc/self/status')
    expect(primaryArg({ ...e, string_args: {}, fd_args: {}, decoded_args: { '0': 'PR_GET_DUMPABLE' } })).toBe('PR_GET_DUMPABLE')
    expect(primaryArg({ ...e, string_args: {}, fd_args: {}, decoded_args: {}, args: ['0x10', '0x0'] })).toBe('0x10 0x0')
  })
})
