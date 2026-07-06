import { describe, it, expect } from 'vitest'
import { candidateWhere, score, aggregate } from '../src/shared/rasp-heuristics'
import type { SyscallEvent } from '../src/shared/events'

const base: SyscallEvent = {
  type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 0, syscall: 'openat',
  args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {},
  backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }],
}

describe('rasp-heuristics', () => {
  it('flags ptrace(PTRACE_TRACEME) via raw args[0] === 0 as debugger', () => {
    const s = score({ ...base, syscall: 'ptrace', args: ['0x0'], backtrace: [] })
    expect(s).toEqual([{ target: 'sys:ptrace', category: 'debugger',
      confidence: expect.any(Number), rationale: expect.stringContaining('TRACEME'), occurrences: 1 }])
    expect(s[0].confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('does not flag ptrace with a non-zero request', () => {
    expect(score({ ...base, syscall: 'ptrace', args: ['0x10'], backtrace: [] })).toEqual([])
  })

  it('flags an openat on an su path as root, targeting the nearest native frame', () => {
    const s = score({ ...base, syscall: 'openat', string_args: { '1': '/system/bin/su' } })
    expect(s[0]).toMatchObject({ target: 'nat:libexample.so!check_su', category: 'root' })
  })

  it('flags a magisk path as root', () => {
    const s = score({ ...base, syscall: 'access', string_args: { '1': '/sbin/magisk' } })
    expect(s[0].category).toBe('root')
  })

  it('flags a read of /proc/self/status as debugger', () => {
    const s = score({ ...base, syscall: 'read', fd_args: { '0': '/proc/self/status' }, backtrace: [] })
    expect(s[0]).toMatchObject({ target: 'sys:read', category: 'debugger' })
  })

  it('returns nothing for a benign event', () => {
    expect(score({ ...base, syscall: 'openat', string_args: { '1': '/data/app/lib.so' } })).toEqual([])
  })

  it('candidateWhere mentions the interesting syscalls', () => {
    const w = candidateWhere()
    for (const s of ['ptrace', 'openat', 'read']) expect(w).toContain(s)
  })

  it('aggregate collapses to one per target with summed occurrences and max confidence', () => {
    const a = { target: 'sys:ptrace', category: 'debugger' as const, confidence: 0.8, rationale: 'x', occurrences: 1 }
    const b = { target: 'sys:ptrace', category: 'debugger' as const, confidence: 0.9, rationale: 'y', occurrences: 1 }
    const out = aggregate([a, b])
    expect(out).toHaveLength(1)
    expect(out[0].occurrences).toBe(2)
    expect(out[0].confidence).toBe(0.9)
  })
})
