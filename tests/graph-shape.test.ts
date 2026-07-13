import { describe, it, expect } from 'vitest'
import { chainOf, foldEvents, labelForId, capSlice, mergeGraphs, nativeNodeId, chainOfFunc, foldFuncEvents, chainOfCfi } from '@shared/graph-shape'
import type { SyscallEvent, FuncEvent, CfiFrame } from '@shared/events'

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

  it('drops the dexpc offset so one managed method is one node', () => {
    const a = chainOf(syscall({ java_stack: ['com.example.Sec.check'] }))
    const b = chainOf(syscall({ java_stack: ['com.example.Sec.check+0x1a'] }))
    expect(a[0].id).toBe('java:com.example.Sec.check')
    expect(b[0].id).toBe('java:com.example.Sec.check')
    expect(b[0].label).toBe('com.example.Sec.check')
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

describe('capSlice', () => {
  const n = (id: string) => ({ id, kind: 'native' as const, label: id, module: null, count: 1 })
  const e = (s: string, t: string) => ({ id: `${s}->${t}`, source: s, target: t, count: 1 })

  it('keeps edges among surviving nodes instead of starving them to zero', () => {
    // 3 nodes + 2 edges, cap 3: all fit, nothing dropped. The old (cap - nodes)
    // budget gave 0 edges here; the fix keeps both and reports not-truncated.
    const s = capSlice([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c')], 10, 3)
    expect(s.nodes.map(x => x.id)).toEqual(['a', 'b', 'c'])
    expect(s.edges.map(x => `${x.source}->${x.target}`).sort()).toEqual(['a->b', 'b->c'])
    expect(s.truncated).toBe(false)
  })

  it('truncates by dropping nodes, keeping only edges among survivors', () => {
    // cap 2 drops node c; edges touching c go too, a->b survives; truncated.
    const s = capSlice([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c'), e('a', 'c')], 10, 2)
    expect(s.nodes.map(x => x.id)).toEqual(['a', 'b'])
    expect(s.edges.map(x => `${x.source}->${x.target}`)).toEqual(['a->b'])
    expect(s.truncated).toBe(true)
  })

  it('flags truncated only when something is actually cut, not on the raw sum', () => {
    // 5 nodes + 1 edge, cap 5: sum 6 > 5, but nothing is dropped -> not truncated.
    const s = capSlice([n('a'), n('b'), n('c'), n('d'), n('e')], [e('a', 'b')], 10, 5)
    expect(s.truncated).toBe(false)
    expect(s.edges).toHaveLength(1)
  })

  it('is not truncated when under the cap', () => {
    const s = capSlice([n('a'), n('b')], [e('a', 'b')], 5, 10)
    expect(s.truncated).toBe(false)
    expect(s.edges).toHaveLength(1)
  })
})

describe('mergeGraphs', () => {
  const n = (id: string, count: number) => ({ id, kind: 'native' as const, label: id, module: null, count })
  const e = (s: string, t: string, count: number) => ({ id: `${s}=>${t}`, source: s, target: t, count })

  it('sums counts when two sources agree on the same node/edge id', () => {
    const a = { nodes: [n('sys:openat', 2)], edges: [e('nat:x', 'sys:openat', 2)] }
    const b = { nodes: [n('sys:openat', 1)], edges: [e('nat:x', 'sys:openat', 1)] }
    const merged = mergeGraphs(a, b)
    expect(merged.nodes).toEqual([{ ...n('sys:openat', 3) }])
    expect(merged.edges).toEqual([{ ...e('nat:x', 'sys:openat', 3) }])
  })

  it('keeps distinct ids from different sources side by side', () => {
    const a = { nodes: [n('fn:a', 1)], edges: [] }
    const b = { nodes: [n('fn:b', 1)], edges: [] }
    const merged = mergeGraphs(a, b)
    expect(merged.nodes.map(x => x.id).sort()).toEqual(['fn:a', 'fn:b'])
  })

  it('mutating the result does not mutate the input sources', () => {
    const a = { nodes: [n('x', 1)], edges: [] }
    const merged = mergeGraphs(a)
    merged.nodes[0].count = 99
    expect(a.nodes[0].count).toBe(1)
  })

  it('returns empty for no sources', () => {
    expect(mergeGraphs()).toEqual({ nodes: [], edges: [] })
  })
})

describe('labelForId', () => {
  it('labels a java id', () => {
    expect(labelForId('java:com.example.app.RootCheck.run')).toEqual({
      kind: 'java', label: 'com.example.app.RootCheck.run', module: null,
    })
  })
  it('labels a syscall id', () => {
    expect(labelForId('sys:openat')).toEqual({ kind: 'syscall', label: 'openat', module: null })
  })
  it('labels a native id with module + symbol', () => {
    expect(labelForId('nat:libexample.so!check_su')).toEqual({
      kind: 'native', label: 'check_su (libexample.so)', module: 'libexample.so',
    })
  })
  it('labels a native id with module only', () => {
    expect(labelForId('nat:libexample.so')).toEqual({
      kind: 'native', label: 'libexample.so', module: 'libexample.so',
    })
  })
  it('labels a func id', () => {
    expect(labelForId('fn:libexample.so!JNI_OnLoad')).toEqual({
      kind: 'func', label: 'libexample.so!JNI_OnLoad', module: null,
    })
  })
})

describe('nativeNodeId', () => {
  it('drops the offset and prefixes nat:', () => {
    expect(nativeNodeId('libexample.so!check_su+0x10')).toBe('nat:libexample.so!check_su')
    expect(nativeNodeId('libexample.so!check_su')).toBe('nat:libexample.so!check_su')
  })
  it('module-only frame keeps just the module', () => {
    expect(nativeNodeId('libc.so+0x8')).toBe('nat:libc.so')
  })
  it('bare address is null', () => {
    expect(nativeNodeId('0x7fabc')).toBeNull()
  })
})

const fcall = (bt: [number, string][]): FuncEvent => ({
  type: 'call', id: 1, pid: 1, tid: 1, module: 'libexample.so', symbol: 'checkRoot',
  entry_addr: '0x0',
  backtrace: bt.map(([frame, symbol]) => ({ frame, addr: '0x0', symbol })),
})

describe('chainOfFunc', () => {
  it('promotes hooked frames to fn: and keeps unhooked frames nat:, outermost first', () => {
    const hooked = new Set(['libexample.so!checkRoot', 'libc.so!getProp'])
    const e = fcall([[0, 'libc.so!getProp'], [1, 'libexample.so!checkRoot+0x8'], [2, 'libandroid.so!Specialize+0x20']])
    // e is a getProp call whose caller is checkRoot, whose caller is Specialize (unhooked).
    e.symbol = 'getProp'
    e.module = 'libc.so'
    expect(chainOfFunc(e, hooked).map(c => c.id)).toEqual([
      'nat:libandroid.so!Specialize',
      'fn:libexample.so!checkRoot',
      'fn:libc.so!getProp',
    ])
  })

  it('drops bare-address frames', () => {
    const hooked = new Set(['libexample.so!checkRoot'])
    const e = fcall([[0, 'libexample.so!checkRoot'], [1, '0x7fffdead']])
    expect(chainOfFunc(e, hooked).map(c => c.id)).toEqual(['fn:libexample.so!checkRoot'])
  })

  it('drops the dexpc offset from managed frames', () => {
    const hooked = new Set(['libexample.so!checkRoot'])
    const e = fcall([[0, 'libexample.so!checkRoot']])
    e.java_stack = ['com.example.Sec.check+0x0']
    expect(chainOfFunc(e, hooked)[0].id).toBe('java:com.example.Sec.check')
  })
})

describe('foldFuncEvents', () => {
  it('counts calls once and builds caller edges', () => {
    const hooked = new Set(['libexample.so!checkRoot'])
    const e = fcall([[0, 'libexample.so!checkRoot'], [1, 'libc.so!__libc_init+0x40']])
    const slice = foldFuncEvents([e, e]) // same call twice
    const cr = slice.nodes.find(n => n.id === 'fn:libexample.so!checkRoot')!
    expect(cr.count).toBe(2) // calls only, no double-count from returns
    expect(slice.edges).toEqual([
      { id: 'nat:libc.so!__libc_init=>fn:libexample.so!checkRoot',
        source: 'nat:libc.so!__libc_init', target: 'fn:libexample.so!checkRoot', count: 2 },
    ])
  })
})

const cfiFrame = (over: Partial<CfiFrame>): CfiFrame =>
  ({ frame: 0, addr: '0x1', symbol: 'libc.so!x+0x1', kind: 'native', ...over })

describe('chainOfCfi', () => {
  it('places the outer-native caller above the managed frames (interleaving)', () => {
    const frames: CfiFrame[] = [
      cfiFrame({ frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8', kind: 'native' }),
      cfiFrame({ frame: 1, addr: '0x3', symbol: 'boot.oat!art_jni_trampoline+0x8c', kind: 'jni-trampoline' }),
      cfiFrame({ frame: 2, addr: '0x4', symbol: 'boot.oat!dalvik.system.ZygoteHooks.postForkChild+0x64', kind: 'managed' }),
      cfiFrame({ frame: 3, addr: '0x6', symbol: 'libandroid_runtime.so!SpecializeCommon+0x69a0', kind: 'native' }),
    ]
    expect(chainOfCfi(frames, 'sys:ioctl').map(n => n.id)).toEqual([
      'nat:libandroid_runtime.so!SpecializeCommon',
      'java:dalvik.system.ZygoteHooks.postForkChild',
      'nat:boot.oat!art_jni_trampoline',
      'nat:libc.so!__ioctl',
      'sys:ioctl',
    ])
  })

  it('names an interp method (addr 0x0) and drops the interp entry machinery', () => {
    const frames: CfiFrame[] = [
      cfiFrame({ frame: 0, addr: '0x6', symbol: 'libart.so!ExecuteSwitchImpl+0x40', kind: 'interp' }),
      cfiFrame({ frame: 1, addr: '0x0', symbol: 'com.android.internal.os.RuntimeInit.main+0x1a', kind: 'interp' }),
    ]
    expect(chainOfCfi(frames, 'sys:read').map(n => n.id)).toEqual([
      'java:com.android.internal.os.RuntimeInit.main',
      'sys:read',
    ])
  })

  it('drops bare-address frames', () => {
    const frames: CfiFrame[] = [cfiFrame({ frame: 0, addr: '0x1', symbol: '0x7fabc [unmapped]', kind: 'native' })]
    expect(chainOfCfi(frames, 'sys:read').map(n => n.id)).toEqual(['sys:read'])
  })

  it('promotes a hooked native frame to fn: and appends no leaf for funcs', () => {
    const frames: CfiFrame[] = [
      cfiFrame({ frame: 0, addr: '0x1', symbol: 'libexample.so!checkRoot+0x4', kind: 'native' }),
      cfiFrame({ frame: 1, addr: '0x2', symbol: 'libandroid.so!Specialize+0x20', kind: 'native' }),
    ]
    const hooked = new Set(['libexample.so!checkRoot'])
    expect(chainOfCfi(frames, null, hooked).map(n => n.id)).toEqual([
      'nat:libandroid.so!Specialize',
      'fn:libexample.so!checkRoot',
    ])
  })
})
