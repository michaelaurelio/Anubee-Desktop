import { describe, it, expect } from 'vitest'
import { chainOf, foldEvents } from '@shared/graph-shape'
import type { SyscallEvent } from '@shared/events'

function syscall(over: Partial<SyscallEvent> = {}): SyscallEvent {
  return {
    type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat',
    args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {},
    java_stack: ['com.example.Sec.check'],
    backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check+0x10' }],
    ...over,
  }
}

describe('chainOf', () => {
  it('orders java -> native -> syscall, top to bottom', () => {
    const ids = chainOf(syscall()).map(n => n.id)
    expect(ids).toEqual([
      'java:com.example.Sec.check',
      'nat:libexample.so!check',
      'sys:openat',
    ])
  })

  it('drops the offset so call sites within a function collapse', () => {
    const a = chainOf(syscall({ backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check+0x10' }] }))
    const b = chainOf(syscall({ backtrace: [{ frame: 0, addr: '0x2', symbol: 'libexample.so!check+0x99' }] }))
    expect(a[1].id).toBe(b[1].id)
    expect(a[1].id).toBe('nat:libexample.so!check')
  })

  it('uses nat:<module> when no symbol is known', () => {
    const ids = chainOf(syscall({ backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so+0x2a0' }] })).map(n => n.id)
    expect(ids).toContain('nat:libexample.so')
  })

  it('skips bare-address frames but keeps the rest of the chain', () => {
    const ids = chainOf(syscall({
      backtrace: [
        { frame: 0, addr: '0x1', symbol: '0x7fabc [unmapped]' },
        { frame: 1, addr: '0x2', symbol: 'libexample.so!check+0x4' },
      ],
    })).map(n => n.id)
    expect(ids).toContain('nat:libexample.so!check')
    expect(ids.some(i => i.startsWith('nat:0x'))).toBe(false)
  })
})

describe('foldEvents', () => {
  it('builds the aggregated nodes + edges of one chain', () => {
    const s = foldEvents([syscall()])
    const ids = s.nodes.map(n => n.id).sort()
    expect(ids).toEqual([
      'java:com.example.Sec.check',
      'nat:libexample.so!check',
      'sys:openat',
    ])
    const pairs = s.edges.map(e => `${e.source}->${e.target}`).sort()
    expect(pairs).toEqual([
      'java:com.example.Sec.check->nat:libexample.so!check',
      'nat:libexample.so!check->sys:openat',
    ])
    expect(s.eventCount).toBe(1)
    expect(s.truncated).toBe(false)
  })

  it('merges repeated events into occurrence counts', () => {
    const s = foldEvents([syscall({ id: 1 }), syscall({ id: 2 })])
    const edge = s.edges.find(e => e.source === 'nat:libexample.so!check' && e.target === 'sys:openat')!
    expect(edge.count).toBe(2)
    expect(s.nodes.find(n => n.id === 'sys:openat')!.count).toBe(2)
    expect(s.eventCount).toBe(2)
  })

  it('flags truncated when node+edge count exceeds the cap', () => {
    const s = foldEvents([syscall()], 2) // 3 nodes + 2 edges > 2
    expect(s.truncated).toBe(true)
  })
})
