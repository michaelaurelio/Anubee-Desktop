import { describe, it, expect } from 'vitest'
import { matchSequences, validateRule, type Rule } from '../src/shared/rasp-heuristics'
import type { SyscallEvent } from '../src/shared/events'

const app = (addr: string) => [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' },
                               { frame: 1, addr, symbol: 'libsentinel.so!scan+0x100' }]

function ev(id: number, path: string, addr = '0x2100', syscall = 'openat'): SyscallEvent {
  return {
    type: 'syscall', id, pid: 100, tid: 100, syscall_nr: 0, syscall,
    args: [], retval: 0, string_args: { '1': path }, fd_args: {}, decoded_args: {},
    backtrace: app(addr),
  } as SyscallEvent
}

function mk(over: Record<string, unknown>): Rule {
  const { rule, error } = validateRule({
    id: 'scan', category: 'hook', confidence: 0.95, rationale: 'r',
    correlate: 'module+tid', maxGap: 5,
    steps: [
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' },
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida' },
    ], ...over,
  }, 'builtin')
  if (!rule) throw new Error(error ?? 'invalid')
  return rule
}

const unordered = mk({ mode: 'unordered' })
const ordered = mk({ mode: 'ordered' })

describe('unordered matching', () => {
  it('matches when the steps arrive in order', () => {
    expect(matchSequences([unordered], [ev(1, '/proc/self/maps'), ev(2, '/data/frida-agent.so')]).hits).toHaveLength(1)
  })

  it('matches when the steps arrive REVERSED - the case ordered mode misses', () => {
    const events = [ev(1, '/data/frida-agent.so'), ev(2, '/proc/self/maps')]
    expect(matchSequences([unordered], events).hits).toHaveLength(1)
    expect(matchSequences([ordered], events).hits).toHaveLength(0)
  })

  it('does not complete from a single event that satisfies two steps', () => {
    // One path matching both step regexes must advance exactly one step, so the
    // partial it opens still needs a second event.
    const both = mk({ mode: 'unordered', steps: [
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida' },
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'agent' },
    ] })
    expect(matchSequences([both], [ev(1, '/data/frida-agent.so')]).hits).toHaveLength(0)
    expect(matchSequences([both], [ev(1, '/data/frida-agent.so'), ev(2, '/data/frida-agent.so')]).hits).toHaveLength(1)
  })

  it('advancing a partial satisfies at most one step, however many the event matches', () => {
    // The same one-event-one-step rule on the ADVANCE path rather than the open
    // path: the partial is already holding step 0 when an event arrives that
    // matches both remaining steps. It may take only one of them, so the rule
    // still needs a third event. Satisfying both would complete a three-step
    // rule from two events.
    const three = mk({ mode: 'unordered', steps: [
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' },
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida' },
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'agent' },
    ] })
    const two = [ev(1, '/proc/self/maps'), ev(2, '/data/frida-agent.so')]
    expect(matchSequences([three], two).hits).toHaveLength(0)
    expect(matchSequences([three], [...two, ev(3, '/data/frida-agent.so')]).hits).toHaveLength(1)
  })

  it('expires on the same window as ordered mode', () => {
    // Padding events bump the correlation stream whether or not they satisfy a
    // step, so they consume the window exactly as they do in ordered mode.
    const pad = (n: number) => Array.from({ length: n }, (_, i) => ev(i + 2, '/data/other.so'))
    const run = (n: number) => [ev(1, '/proc/self/maps'), ...pad(n), ev(n + 2, '/data/frida-agent.so')]
    expect(matchSequences([unordered], run(5)).hits).toHaveLength(1)
    expect(matchSequences([unordered], run(6)).hits).toHaveLength(0)
    expect(matchSequences([ordered], run(5)).hits).toHaveLength(1)
    expect(matchSequences([ordered], run(6)).hits).toHaveLength(0)
  })

  it('anchors on the step the event satisfied, wherever it sits in the rule', () => {
    // The reversed scan anchors on step 1, and the anchor frame is the call site
    // of the event that opened the partial - not of the one that completed it.
    const hits = matchSequences([unordered],
      [ev(1, '/data/frida-agent.so', '0x2100'), ev(2, '/proc/self/maps', '0x2200')]).hits
    expect(hits[0].frame).toEqual({ module: 'libsentinel.so', addr: '0x2100' })
  })

  it('reports one occurrence per completed set, then reopens', () => {
    const events = [ev(1, '/proc/self/maps'), ev(2, '/data/frida-agent.so'),
                    ev(3, '/proc/self/maps'), ev(4, '/data/frida-agent.so')]
    expect(matchSequences([unordered], events).hits).toHaveLength(2)
  })

  it('a three-step unordered rule needs all three', () => {
    const three = mk({ mode: 'unordered', maxGap: 10, steps: [
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' },
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida' },
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/self/fd$' },
    ] })
    expect(matchSequences([three], [ev(1, '/data/frida-agent.so'), ev(2, '/proc/self/fd')]).hits).toHaveLength(0)
    expect(matchSequences([three], [ev(1, '/data/frida-agent.so'), ev(2, '/proc/self/fd'),
                                    ev(3, '/proc/self/maps')]).hits).toHaveLength(1)
  })

  it('a one-step rule emits once per event in either mode', () => {
    // A one-step rule is trivially "all steps satisfied"; the fast path owns it
    // in both modes, so unordered mode must not give it a second route.
    const one = { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida' }
    const events = [ev(1, '/data/frida-agent.so'), ev(2, '/data/frida-agent.so')]
    expect(matchSequences([mk({ mode: 'unordered', steps: [one] })], events).hits).toHaveLength(2)
    expect(matchSequences([mk({ mode: 'ordered', steps: [one] })], events).hits).toHaveLength(2)
  })
})
