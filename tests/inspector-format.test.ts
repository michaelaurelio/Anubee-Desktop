import { describe, it, expect } from 'vitest'
import { formatEvent, primaryFuncArg, funcDetailSections } from '../src/renderer/inspector'
import type { SyscallEvent, FuncEvent } from '@shared/events'

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

describe('sock_addr rendering', () => {
  const conn: SyscallEvent = {
    type: 'syscall', id: 6, pid: 1, tid: 101, syscall_nr: 203, syscall: 'connect',
    args: ['0x7b'], retval: -111, string_args: {}, fd_args: { '0': 'fd=123' },
    decoded_args: {}, sock_addr: 'unix:@/frida-zymbiote-abc',
    backtrace: [{ frame: 0, addr: '0x1', symbol: 'libc.so!connect+0x8' }],
  }
  it('formatEvent includes sock_addr', () => {
    expect(formatEvent(conn)).toContain('unix:@/frida-zymbiote-abc')
  })
  it('primaryArg falls back to sock_addr before fd', async () => {
    const { primaryArg } = await import('../src/renderer/inspector')
    expect(primaryArg(conn)).toBe('unix:@/frida-zymbiote-abc')
  })
})

const rec: FuncEvent = {
  type: 'call', id: 1, pid: 9, tid: 9, module: 'libexample.so', symbol: 'checkRoot',
  args: ['0xaa'], string_args: { '0': 'ro.debuggable' }, fd_args: {}, sock_args: {},
  backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libexample.so!checkRoot' }, { frame: 1, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }],
  retval: 1, elapsed_ns: 2300, out_args: { '0': 'result' },
}

describe('primaryFuncArg', () => {
  it('prefers string_args, else sock, else fd, else raw args', () => {
    expect(primaryFuncArg(rec)).toBe('ro.debuggable')
    // sock tier: no strings, but a decoded sockaddr present
    expect(primaryFuncArg({ ...rec, string_args: {}, sock_args: { '0': 'AF_INET 10.0.0.1:53' } })).toBe('AF_INET 10.0.0.1:53')
    // fd tier: no strings/sock, but an fd path present
    expect(primaryFuncArg({ ...rec, string_args: {}, sock_args: {}, fd_args: { '0': '/proc/self/status' } })).toBe('/proc/self/status')
    // raw-args fallback when every resolved map is empty
    expect(primaryFuncArg({ ...rec, string_args: {} })).toBe('0xaa')
  })
})

describe('funcDetailSections', () => {
  it('summarizes function/retval/elapsed and groups args + backtrace', () => {
    const secs = funcDetailSections(rec)
    const summary = secs.find(s => s.title === 'Summary')!
    expect(summary.kind).toBe('kv')
    expect((summary as { rows: { k: string; v: string }[] }).rows).toContainEqual({ k: 'function', v: 'libexample.so!checkRoot' })
    expect((summary as { rows: { k: string; v: string }[] }).rows).toContainEqual({ k: 'retval', v: '1' })
    expect((summary as { rows: { k: string; v: string }[] }).rows).toContainEqual({ k: 'elapsed', v: '2300 ns' })
    expect(secs.some(s => s.title === 'Args')).toBe(true)
    const bt = secs.find(s => s.title === 'Backtrace')
    expect(bt?.kind).toBe('stack')
    // frame 0 (libexample.so!checkRoot) is the innermost non-system-lib frame;
    // frame 1 (libc.so) is the system-lib caller.
    if (bt?.kind === 'stack') expect(bt.highlight).toBe(0)
  })
})
