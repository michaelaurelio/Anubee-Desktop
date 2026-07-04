import { describe, it, expect } from 'vitest'
import { sliceToElements, elkLayoutOptions, filterForRow } from '../src/renderer/graph-view'
import type { GraphSlice } from '@shared/graph-shape'
import type { TableRow } from '@shared/table'

const slice: GraphSlice = {
  eventCount: 1,
  truncated: false,
  nodes: [
    { id: 'sys:openat', kind: 'syscall', label: 'openat', module: null, count: 1 },
    { id: 'nat:libexample.so!check', kind: 'native', label: 'check (libexample.so)', module: 'libexample.so', count: 2 },
  ],
  edges: [{ id: 'nat:libexample.so!check=>sys:openat', source: 'nat:libexample.so!check', target: 'sys:openat', count: 3 }],
}

const row = (over: Partial<TableRow> = {}): TableRow => ({
  id: 1, tid: 101, syscall: 'openat', retval: 7, hasJava: true,
  topJava: 'com.example.Sec.check', topNative: 'libexample.so!check+0x10', ...over,
})

describe('sliceToElements', () => {
  it('maps nodes and edges to cytoscape element defs', () => {
    const els = sliceToElements(slice)
    expect(els.nodes).toHaveLength(2)
    expect(els.nodes[0].data).toMatchObject({ id: 'sys:openat', kind: 'syscall', label: 'openat', count: 1 })
    expect(els.edges).toHaveLength(1)
    expect(els.edges[0].data).toMatchObject({ source: 'nat:libexample.so!check', target: 'sys:openat', count: 3 })
  })
})

describe('elkLayoutOptions', () => {
  it('is a layered ELK layout flowing DOWN (java -> native -> syscall)', () => {
    const o = elkLayoutOptions()
    expect(o.name).toBe('elk')
    expect(o.elk.algorithm).toBe('layered')
    expect(o.elk['elk.direction']).toBe('DOWN')
  })
})

describe('filterForRow', () => {
  it('a java-bearing row selects its bridge by java method', () => {
    expect(filterForRow(row())).toEqual({ text: 'com.example.Sec.check', hasJavaStack: true })
  })

  it('a java-less row falls back to syscall + tid', () => {
    expect(filterForRow(row({ hasJava: false, topJava: null, syscall: 'read', tid: 202 })))
      .toEqual({ syscall: 'read', tid: 202 })
  })

  it('ANDs the currently active toolbar filter', () => {
    expect(filterForRow(row(), { library: 'libexample' }))
      .toEqual({ library: 'libexample', text: 'com.example.Sec.check', hasJavaStack: true })
  })
})
