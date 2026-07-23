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

// A one-step rule on the same correlation mode: its events are rule-relevant, so
// they count against a gap, but they never open a partial of their own.
const benign: Rule = {
  id: 'benign-probe', category: 'custom', confidence: 0.1, rationale: 'benign lib open',
  enabled: true, source: 'builtin', correlate: 'module+tid', maxGap: 5,
  steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/data/benign' }],
}

const OTHER = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' },
               { frame: 1, addr: '0x9000', symbol: 'libother.so!f+0x4' }]

// A backtrace with no app frame at all: it has no module key, so no rule with a
// module correlate participates in it and no correlation stream is bumped.
const PLATFORM_ONLY = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' }]

function idsOf(hits: { ruleId: string }[]): string[] {
  return hits.map(h => h.ruleId)
}

// The cap, sweep and age-queue invariants are internal by design, and they are
// exactly what the bookkeeping tests below pin, so read them directly.
function state(m: SequenceMatcher): { live: number; held: number; ages: number; reachable: number } {
  const i = m as unknown as {
    live: number
    ages: { dead: boolean }[]
    agesHead: number
    partials: Map<string, unknown[]>
  }
  let held = 0
  for (const list of i.partials.values()) held += list.length
  return {
    live: i.live,
    held,
    ages: i.ages.length,
    reachable: i.ages.slice(i.agesHead).filter(p => !p.dead).length,
  }
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
    // The filler matches the benign rule's step, so these are the rule-relevant
    // events maxGap counts - exactly what the store's prefilter would feed in.
    const filler = Array.from({ length: 6 }, (_, i) => ev(10 + i, 'openat', '/data/benign.so'))
    const { hits } = matchSequences([seq, benign], [
      ev(1, 'openat', '/proc/self/maps'), ...filler, ev(99, 'openat', '/data/frida-agent.so'),
    ])
    expect(idsOf(hits).filter(id => id === 'hook-frida-scan')).toEqual([])
    expect(idsOf(hits).filter(id => id === 'benign-probe')).toHaveLength(6)
  })

  it('admits exactly maxGap rule-relevant events between two steps', () => {
    // maxGap is the count of rule-relevant events allowed BETWEEN the steps, so
    // maxGap = 5 must still match with five of them in the way.
    const filler = Array.from({ length: 5 }, (_, i) => ev(10 + i, 'openat', '/data/benign.so'))
    const { hits } = matchSequences([seq, benign], [
      ev(1, 'openat', '/proc/self/maps'), ...filler, ev(99, 'openat', '/data/frida-agent.so'),
    ])
    expect(idsOf(hits).filter(id => id === 'hook-frida-scan')).toHaveLength(1)
  })

  it('expires at maxGap + 1 rule-relevant events between two steps', () => {
    const filler = Array.from({ length: 6 }, (_, i) => ev(10 + i, 'openat', '/data/benign.so'))
    const { hits } = matchSequences([seq, benign], [
      ev(1, 'openat', '/proc/self/maps'), ...filler, ev(99, 'openat', '/data/frida-agent.so'),
    ])
    expect(idsOf(hits).filter(id => id === 'hook-frida-scan')).toEqual([])
  })

  it('the sweep keeps a partial with exactly maxGap events still to come', () => {
    // Sweeping on every push, with the stream six events past the anchor: five
    // of them sit between the anchor and whatever arrives next, which is exactly
    // maxGap, so the sweep must not retire it. The final event carries no module
    // key, so it sweeps without touching the stream.
    const m = new SequenceMatcher([seq, benign], 10, { sweepEvery: 1 })
    m.push(ev(1, 'openat', '/proc/self/maps'))
    for (let i = 0; i < 6; i++) m.push(ev(10 + i, 'openat', '/data/benign.so'))
    m.push(ev(50, 'openat', '/data/benign.so', { backtrace: PLATFORM_ONLY }))
    expect(m.sweepCount).toBe(8)
    expect(state(m).live).toBe(1)
  })

  it('measures the gap key-locally, so filler on another key does not expire it', () => {
    const filler = Array.from({ length: 6 }, (_, i) => ev(10 + i, 'openat', '/data/benign.so', { backtrace: OTHER }))
    const { hits } = matchSequences([seq, benign], [
      ev(1, 'openat', '/proc/self/maps'), ...filler, ev(99, 'openat', '/data/frida-agent.so'),
    ])
    expect(idsOf(hits).filter(id => id === 'hook-frida-scan')).toHaveLength(1)
  })

  it('bumps a shared stream once per event, not once per rule', () => {
    // Three rules share correlate mode and key. With maxGap 5 and 4 filler
    // events the pair still matches; a per-rule bump would triple the distance
    // and expire both partials.
    const twin: Rule = { ...seq, id: 'hook-frida-scan-2' }
    const filler = Array.from({ length: 4 }, (_, i) => ev(10 + i, 'openat', '/data/benign.so'))
    const { hits } = matchSequences([seq, twin, benign], [
      ev(1, 'openat', '/proc/self/maps'), ...filler, ev(99, 'openat', '/data/frida-agent.so'),
    ])
    expect(idsOf(hits).filter(id => id.startsWith('hook-frida-scan'))).toEqual(['hook-frida-scan', 'hook-frida-scan-2'])
  })

  it('advances a rule at most once per event, so a step cannot match itself forward', () => {
    const same: Rule = { ...seq, id: 'self', steps: [seq.steps[0], seq.steps[0]] }
    const one = matchSequences([same], [ev(1, 'openat', '/proc/self/maps')])
    expect(one.hits).toEqual([])
    const two = matchSequences([same], [ev(1, 'openat', '/proc/self/maps'), ev(2, 'openat', '/proc/self/maps')])
    expect(two.hits).toHaveLength(1)
  })

  it('does not correlate across correlation keys', () => {
    const { hits } = matchSequences([seq], [
      ev(1, 'openat', '/proc/self/maps'),
      ev(2, 'openat', '/data/frida-agent.so', { backtrace: OTHER }),
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
    expect(hits).toHaveLength(1)
    expect(hits[0].frame).toEqual({ module: 'libsentinel.so', addr: '0x2100' })
  })

  it('treats a one-step rule as an immediate match', () => {
    const single: Rule = { ...seq, id: 'one', steps: [seq.steps[0]] }
    const { hits } = matchSequences([single], [ev(1, 'openat', '/proc/self/maps')])
    expect(hits).toHaveLength(1)
  })

  it('correlates by java frame when asked', () => {
    const j: Rule = { ...seq, correlate: 'java' }
    // java_stack is innermost-first, as the tracer emits it.
    const stack = ['com.example.Rasp.scan', 'com.example.App.onCreate']
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

  it('does not hand out its internal hit list', () => {
    const m = new SequenceMatcher([seq])
    m.push(ev(1, 'openat', '/proc/self/maps'))
    m.push(ev(2, 'openat', '/data/frida-agent.so'))
    const early = m.finish().hits
    m.push(ev(3, 'openat', '/proc/self/maps'))
    m.push(ev(4, 'openat', '/data/frida-agent.so'))
    expect(early).toHaveLength(1)
  })

  it('reports drops when the partial cap is hit', () => {
    const m = new SequenceMatcher([seq], 2)
    for (let i = 1; i <= 5; i++) {
      m.push(ev(i, 'openat', '/proc/self/maps', { tid: 100 + i }))
    }
    expect(m.finish().dropped).toBe(3)
  })

  it('does not sweep on every push once the cap is saturated', () => {
    // Reclaiming at the cap is O(live) and evicting is O(1), so a saturated cap
    // must not pay a sweep per event - it was quadratic in the cap before.
    const m = new SequenceMatcher([seq], 4, { sweepEvery: 1000, compactAbove: 1000 })
    for (let i = 1; i <= 500; i++) {
      m.push(ev(i, 'openat', '/proc/self/maps', { tid: 1000 + i }))
    }
    expect(m.sweepCount).toBe(0)
    const s = state(m)
    expect(s.live).toBe(4)
    expect(s.held).toBe(4)
    expect(m.finish().dropped).toBe(496)
  })

  it('compacts the age queue without losing a live partial', () => {
    const m = new SequenceMatcher([seq], 4, { sweepEvery: 10, compactAbove: 8 })
    for (let i = 1; i <= 120; i++) {
      m.push(ev(i, 'openat', '/proc/self/maps', { tid: 1000 + i }))
    }
    expect(m.sweepCount).toBe(12)
    const s = state(m)
    expect(s.live).toBe(4)
    expect(s.held).toBe(4)          // live is exactly what the map holds
    expect(s.reachable).toBe(4)     // every live partial is still evictable
    expect(s.ages).toBeLessThanOrEqual(20)  // compacted, not one slot per push
    expect(m.finish().dropped).toBe(116)
  })

  it('keeps matching on other keys once the cap has been hit', () => {
    // Each tid opens a partial and never speaks again. A cap that only refused
    // new partials would go blind here for the rest of the run.
    const m = new SequenceMatcher([seq], 3)
    for (let i = 1; i <= 200; i++) {
      m.push(ev(i, 'openat', '/proc/self/maps', { tid: 1000 + i }))
    }
    m.push(ev(900, 'openat', '/proc/self/maps', { tid: 900 }))
    m.push(ev(901, 'openat', '/data/frida-agent.so', { tid: 900 }))
    const { hits } = m.finish()
    expect(hits).toHaveLength(1)
    expect(hits[0].ruleId).toBe('hook-frida-scan')
  })
})

describe('one-step rules', () => {
  const single: Rule = {
    id: 'maps', category: 'hook', confidence: 0.5, rationale: 'maps read',
    enabled: true, source: 'builtin', correlate: 'symbol+tid', maxGap: 50,
    steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' }],
  }

  it('matches a scoped syscall', () => {
    const e = ev(1, 'openat', '/proc/self/maps')
    expect(matchSequences([single], [e]).hits).toHaveLength(1)
  })

  it('does not match a syscall outside the step scope', () => {
    const e = ev(1, 'read', '/proc/self/maps')
    expect(matchSequences([single], [e]).hits).toEqual([])
  })

  it('matches a java-attributed event with a platform-only backtrace', () => {
    const e = ev(1, 'openat', '/proc/self/maps', {
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' },
                  { frame: 1, addr: '0x1100', symbol: 'libart.so!JniInvoke+0x20' }],
      java_stack: ['com.example.Rasp.scan', 'com.example.App.onCreate'],
    })
    const { hits } = matchSequences([single], [e])
    expect(hits).toHaveLength(1)
    expect(hits[0].target).toBe('java:com.example.Rasp.scan')
  })
})
