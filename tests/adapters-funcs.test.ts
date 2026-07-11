import { describe, it, expect } from 'vitest'
import { funcsAdapter } from '@shared/adapters/funcs'
import type { FuncEvent } from '@shared/events'

const call: FuncEvent = {
  type: 'call',
  pid: 100, tid: 101,
  module: 'libexample.so', symbol: 'JNI_OnLoad',
  entry_addr: '0x1000',
  backtrace: [
    { frame: 0, addr: '0x1000', symbol: 'libexample.so!JNI_OnLoad' },
    { frame: 1, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' },
  ],
}

const ret: FuncEvent = {
  type: 'return',
  pid: 100, tid: 101,
  module: 'libexample.so', symbol: 'JNI_OnLoad',
  entry_addr: '0x1000',
  backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libexample.so!JNI_OnLoad' }],
  retval: 0, elapsed_ns: 1500,
}

describe('funcsAdapter', () => {
  it('builds a func node and a real caller node, with a nesting edge between them', () => {
    const { nodes, edges } = funcsAdapter([call, ret])
    // The caller (nat:libc.so!__libc_init) must be a real node, not just an
    // edge endpoint - cy.add() throws on an edge whose source has no node.
    expect(nodes).toEqual([
      { id: 'fn:libexample.so!JNI_OnLoad', kind: 'func', label: 'libexample.so!JNI_OnLoad', module: null, count: 2 },
      { id: 'nat:libc.so!__libc_init', kind: 'native', label: '__libc_init (libc.so)', module: 'libc.so', count: 1 },
    ])
    expect(edges).toEqual([
      { id: 'nat:libc.so!__libc_init=>fn:libexample.so!JNI_OnLoad',
        source: 'nat:libc.so!__libc_init', target: 'fn:libexample.so!JNI_OnLoad', count: 1 },
    ])
  })

  it('skips the edge (but still counts the node) when the call has no resolvable caller frame', () => {
    const lone: FuncEvent = { ...call, backtrace: [call.backtrace[0]] }
    const { nodes, edges } = funcsAdapter([lone])
    expect(nodes).toHaveLength(1)
    expect(edges).toHaveLength(0)
  })

  it('returns empty for no rows', () => {
    expect(funcsAdapter([])).toEqual({ nodes: [], edges: [] })
  })
})
