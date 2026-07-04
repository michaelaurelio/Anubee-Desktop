import type { GraphSlice } from '@shared/graph-shape'
import type { Filter } from '@shared/filter'
import type { TableRow } from '@shared/table'

// Map an aggregated slice to cytoscape element definitions. Node/edge `data`
// carries just what the stylesheet and inspector need.
export function sliceToElements(slice: GraphSlice): {
  nodes: { data: { id: string; label: string; kind: string; count: number } }[]
  edges: { data: { id: string; source: string; target: string; count: number } }[]
} {
  return {
    nodes: slice.nodes.map(n => ({ data: { id: n.id, label: n.label, kind: n.kind, count: n.count } })),
    edges: slice.edges.map(e => ({ data: { id: e.id, source: e.source, target: e.target, count: e.count } })),
  }
}

// ELK layered layout, flowing DOWN so java -> native -> syscall reads top to
// bottom. Fed to cytoscape-elk (which runs the layout in a Web Worker).
export function elkLayoutOptions() {
  return {
    name: 'elk',
    elk: {
      algorithm: 'layered',
      'elk.direction': 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': 60,
      'elk.spacing.nodeNode': 30,
    },
  }
}

// Build the slice filter for a selected table row (spec decision option (b):
// show the whole call pattern of the row's bridge, not just the one event).
// A java-bearing row selects by its java method; a java-less row falls back to
// syscall + tid. The active toolbar filter is ANDed underneath.
export function filterForRow(row: TableRow, active: Filter = {}): Filter {
  const f: Filter = { ...active }
  if (row.topJava) {
    f.text = row.topJava
    f.hasJavaStack = true
  } else {
    f.syscall = row.syscall
    f.tid = row.tid
  }
  return f
}
