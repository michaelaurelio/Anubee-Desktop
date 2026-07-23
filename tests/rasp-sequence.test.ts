import { describe, it, expect } from 'vitest'
import { matchSequences, SequenceMatcher, type Rule } from '../src/shared/rasp-heuristics'
import type { SyscallEvent } from '../src/shared/events'

const APP = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' },
             { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!scan+0x100' }]

function ev(id: number, syscall: string, path: string, over: Partial<SyscallEvent> = {}): SyscallEvent {
  return {
    type: 'syscall', id, pid: 100, tid: 100, syscall_nr: 0, syscall,
    args: [], retval: 0, string_args: { '1': path }, fd_args: {}, decoded_args: {},
    backtrace: APP, ...over,
  } as SyscallEvent
}

const seq: Rule = {
  id: 'hook-frida-scan', category: 'hook', confidence: 0.95, rationale: 'maps scan then frida probe',
  enabled: true, source: 'builtin', correlate: 'module+tid', maxGap: 5,
  steps: [
    { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' },
    { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida' },
  ],
}

describe('SequenceMatcher', () => {
  it('matches an in-order pair within the window', () => {
    const { hits } = matchSequences([seq], [ev(1, 'openat', '/proc/self/maps'), ev(2, 'openat', '/data/frida-agent.so')])
    expect(hits).toHaveLength(1)
    expect(hits[0].target).toBe('nat:libsentinel.so!scan')
    expect(hits[0].ruleId).toBe('hook-frida-scan')
  })

  it('does not match out of order', () => {
    const { hits } = matchSequences([seq], [ev(1, 'openat', '/data/frida-agent.so'), ev(2, 'openat', '/proc/self/maps')])
    expect(hits).toEqual([])
  })

  it('expires a partial past maxGap', () => {
    const filler = Array.from({ length: 6 }, (_, i) => ev(10 + i, 'openat', '/data/benign.so'))
    const { hits } = matchSequences([seq], [ev(1, 'openat', '/proc/self/maps'), ...filler, ev(99, 'openat', '/data/frida-agent.so')])
    expect(hits).toEqual([])
  })

  it('does not correlate across correlation keys', () => {
    const other = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' },
                   { frame: 1, addr: '0x9000', symbol: 'libother.so!f+0x4' }]
    const { hits } = matchSequences([seq], [
      ev(1, 'openat', '/proc/self/maps'),
      ev(2, 'openat', '/data/frida-agent.so', { backtrace: other }),
    ])
    expect(hits).toEqual([])
  })

  it('consumes a completed match so one anchor reports once', () => {
    const { hits } = matchSequences([seq], [
      ev(1, 'openat', '/proc/self/maps'),
      ev(2, 'openat', '/data/frida-agent.so'),
      ev(3, 'openat', '/data/frida-gadget.so'),
    ])
    expect(hits).toHaveLength(1)
  })

  it('anchors the hit on the first step frame', () => {
    const late = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' },
                  { frame: 1, addr: '0x2900', symbol: 'libsentinel.so!probe+0x8' }]
    const { hits } = matchSequences([seq], [
      ev(1, 'openat', '/proc/self/maps'),
      ev(2, 'openat', '/data/frida-agent.so', { backtrace: late }),
    ])
    expect(hits[0].frame).toEqual({ module: 'libsentinel.so', addr: '0x2100' })
  })

  it('treats a one-step rule as an immediate match', () => {
    const single: Rule = { ...seq, id: 'one', steps: [seq.steps[0]] }
    const { hits } = matchSequences([single], [ev(1, 'openat', '/proc/self/maps')])
    expect(hits).toHaveLength(1)
  })

  it('correlates by java frame when asked', () => {
    const j: Rule = { ...seq, correlate: 'java' }
    const stack = ['com.example.App.onCreate', 'com.example.Rasp.scan']
    const { hits } = matchSequences([j], [
      ev(1, 'openat', '/proc/self/maps', { java_stack: stack }),
      ev(2, 'openat', '/data/frida-agent.so', { java_stack: stack }),
    ])
    expect(hits).toHaveLength(1)
  })

  it('survives a page boundary when driven incrementally', () => {
    const m = new SequenceMatcher([seq])
    m.push(ev(1, 'openat', '/proc/self/maps'))
    m.push(ev(2, 'openat', '/data/frida-agent.so'))
    expect(m.finish().hits).toHaveLength(1)
  })

  it('reports drops when the partial cap is hit', () => {
    const m = new SequenceMatcher([seq], 2)
    for (let i = 1; i <= 5; i++) {
      m.push(ev(i, 'openat', '/proc/self/maps', { tid: 100 + i }))
    }
    expect(m.finish().dropped).toBeGreaterThan(0)
  })
})
