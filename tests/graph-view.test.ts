import { describe, it, expect } from 'vitest'
import { sliceToElements, sliceToElkGraph, elkResultToPositions, filterForRow, truncateLabel, kindGlyph } from '../src/renderer/graph-view'
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
  id: 1, tid: 101, engine: 'syscall', syscall: 'openat', retval: 7, hasJava: true,
  topJava: 'com.example.Sec.check', topNative: 'libexample.so!check+0x10', arg: '', ...over,
})

describe('sliceToElements', () => {
  it('maps nodes and edges to cytoscape element defs', () => {
    const els = sliceToElements(slice)
    expect(els.nodes).toHaveLength(2)
    expect(els.nodes[0].data).toMatchObject({ id: 'sys:openat', kind: 'syscall', label: '■ openat', count: 1 })
    expect(els.edges).toHaveLength(1)
    expect(els.edges[0].data).toMatchObject({ source: 'nat:libexample.so!check', target: 'sys:openat', count: 3 })
  })
})

describe('sliceToElkGraph', () => {
  it('builds a layered DOWN ELK graph with sized children and one edge per element', () => {
    const g = sliceToElkGraph(sliceToElements(slice))
    expect(g.layoutOptions['elk.algorithm']).toBe('layered')
    expect(g.layoutOptions['elk.direction']).toBe('DOWN')
    expect(g.children.map(c => c.id).sort()).toEqual(['nat:libexample.so!check', 'sys:openat'])
    expect(g.children.every(c => c.width > 0 && c.height > 0)).toBe(true)
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]).toMatchObject({ sources: ['nat:libexample.so!check'], targets: ['sys:openat'] })
  })
})

describe('elkResultToPositions', () => {
  it('converts ELK top-left corners to cytoscape centre positions', () => {
    const pos = elkResultToPositions({ children: [{ id: 'a', x: 10, y: 20, width: 100, height: 24 }] })
    expect(pos.a).toEqual({ x: 60, y: 32 })
  })

  it('tolerates a result with no children', () => {
    expect(elkResultToPositions({})).toEqual({})
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

  it('filterForRow selects a funcs row by module + symbol', () => {
    const row = { id: 1, tid: 1, engine: 'func', syscall: '', retval: null, hasJava: false, topJava: null, topNative: null, arg: '', fn: 'libc.so!getProp', caller: null, elapsed: null } as never
    expect(filterForRow(row)).toEqual({ module: 'libc.so', symbol: 'getProp' })
  })
})

describe('truncateLabel', () => {
  it('leaves a short label unchanged', () => {
    expect(truncateLabel('openat', 22)).toBe('openat')
  })
  it('truncates a long label with an ellipsis at the cap', () => {
    const out = truncateLabel('check_su (libexample.so)', 22)
    expect(out).toBe('check_su (libexample.…')
    expect(out.length).toBe(22)
  })
  it('defaults the cap to 22', () => {
    expect(truncateLabel('x'.repeat(30)).length).toBe(22)
  })
})

describe('kindGlyph', () => {
  it('maps each kind to its legend shape char', () => {
    expect(kindGlyph('java')).toBe('◆')
    expect(kindGlyph('native')).toBe('●')
    expect(kindGlyph('syscall')).toBe('■')
    expect(kindGlyph('func')).toBe('■')
  })
})

describe('sliceToElements glyph', () => {
  it('prefixes the node label with its kind glyph', () => {
    const slice = { nodes: [{ id: 'sys:read', label: 'read', kind: 'syscall', count: 1 }], edges: [] } as any
    expect(sliceToElements(slice).nodes[0].data.label.startsWith('■ ')).toBe(true)
  })
})
