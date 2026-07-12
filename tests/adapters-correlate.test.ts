import { describe, it, expect } from 'vitest'
import { correlateAdapter } from '@shared/adapters/correlate'
import type { CorrelateEvent } from '@shared/events'

const rootFunc: CorrelateEvent = {
  type: 'func', span: 1, parent_span: 0, pid: 100, tid: 101, entry_addr: '0x1000', args: [],
}
const childFunc: CorrelateEvent = {
  type: 'func', span: 2, parent_span: 1, pid: 100, tid: 101, entry_addr: '0x2000', args: [],
}
const syscallOnChild: CorrelateEvent = {
  type: 'syscall', span: 2, pid: 100, tid: 101, nr: 56, syscall: 'openat', args: [], decoded: [''],
}
const returnOnChild: CorrelateEvent = {
  type: 'return', span: 2, pid: 100, tid: 101, entry_addr: '0x2000', retval: '0x0', elapsed_ns: 1000,
}

describe('correlateAdapter', () => {
  it('builds func nodes keyed by span, a nesting edge from parent_span, and a func->sys edge from a syscall', () => {
    const { nodes, edges } = correlateAdapter([rootFunc, childFunc, syscallOnChild, returnOnChild])

    const byId = new Map(nodes.map(n => [n.id, n]))
    // Root span: one func-open row -> count 1, no parent edge (parent_span 0).
    expect(byId.get('fn:0x1000')).toEqual({ id: 'fn:0x1000', kind: 'func', label: '0x1000', module: null, count: 1 })
    // Child span: func-open + return -> count 2. A syscall on the same span
    // does not itself bump the func node's count.
    expect(byId.get('fn:0x2000')).toEqual({ id: 'fn:0x2000', kind: 'func', label: '0x2000', module: null, count: 2 })
    expect(byId.get('sys:openat')).toEqual({ id: 'sys:openat', kind: 'syscall', label: 'openat', module: null, count: 1 })
    expect(nodes).toHaveLength(3) // no stray/duplicate nodes

    const edgeIds = new Map(edges.map(e => [e.id, e]))
    expect(edgeIds.get('fn:0x1000=>fn:0x2000')).toMatchObject({ source: 'fn:0x1000', target: 'fn:0x2000', count: 1 })
    expect(edgeIds.get('fn:0x2000=>sys:openat')).toMatchObject({ source: 'fn:0x2000', target: 'sys:openat', count: 1 })
    expect(edges).toHaveLength(2)
  })

  it('resolves parent_span correctly even when the child row precedes the parent row', () => {
    const { nodes, edges } = correlateAdapter([childFunc, rootFunc])
    // The parent's own row still only counts once - referencing it as a
    // parent must not inflate its count.
    const root = nodes.find(n => n.id === 'fn:0x1000')!
    expect(root.count).toBe(1)
    expect(edges).toEqual([
      { id: 'fn:0x1000=>fn:0x2000', source: 'fn:0x1000', target: 'fn:0x2000', count: 1, engine: 'correlate' },
    ])
  })

  it('still surfaces an orphan syscall (no matching func row) as a node, but with no edge', () => {
    const { nodes, edges } = correlateAdapter([syscallOnChild])
    expect(nodes).toHaveLength(1) // sys:openat - no dangling fn: node, since we can't resolve the span
    expect(nodes[0].id).toBe('sys:openat')
    expect(edges).toHaveLength(0)
  })

  it('does not bump a func node for an orphan return (no matching func row)', () => {
    const { nodes, edges } = correlateAdapter([returnOnChild])
    expect(nodes).toHaveLength(0)
    expect(edges).toHaveLength(0)
  })

  it('returns empty for no rows', () => {
    expect(correlateAdapter([])).toEqual({ nodes: [], edges: [] })
  })

  it('EPIC B1: adopts the shared fn:<module>!<symbol> id when symbolByAddr resolves the entry_addr', () => {
    const symbolByAddr = new Map([['0x2000', 'libexample.so!check']])
    const { nodes } = correlateAdapter([rootFunc, childFunc], symbolByAddr)
    const byId = new Map(nodes.map(n => [n.id, n]))
    // Root span's 0x1000 has no entry in the map -> stays addr-keyed.
    expect(byId.get('fn:0x1000')).toBeDefined()
    // Child span's 0x2000 resolves -> adopts the symbol id, unmerged addr id absent.
    expect(byId.get('fn:libexample.so!check')).toEqual({
      id: 'fn:libexample.so!check', kind: 'func', label: 'libexample.so!check', module: null, count: 1,
    })
    expect(byId.get('fn:0x2000')).toBeUndefined()
  })

  it('EPIC B1: without symbolByAddr, correlate func nodes stay addr-keyed (default-path no-regression)', () => {
    const { nodes } = correlateAdapter([rootFunc, childFunc])
    const ids = nodes.map(n => n.id)
    expect(ids).toContain('fn:0x1000')
    expect(ids).toContain('fn:0x2000')
  })
})
