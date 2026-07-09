import type { GraphSlice } from '@shared/graph-shape'
import type { Filter } from '@shared/filter'
import type { TableRow } from '@shared/table'

// Cap the on-canvas node label so a long label can't overrun its ELK-reserved
// box (nodes size to 'label'). Full text stays in the offset popup + inspector.
export function truncateLabel(s: string, max = 22): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

// Map an aggregated slice to cytoscape element definitions. Node/edge `data`
// carries just what the stylesheet and inspector need.
export function sliceToElements(slice: GraphSlice): {
  nodes: { data: { id: string; label: string; kind: string; count: number }; classes: string }[]
  edges: { data: { id: string; source: string; target: string; count: number } }[]
} {
  return {
    // classes mirrors data.kind as a cytoscape class (`.java`/`.native`/`.syscall`)
    // so RASP category selectors can combine `.native.suggested.rasp-<cat>`
    // without a second data-attribute lookup per style rule.
    nodes: slice.nodes.map(n => ({ data: { id: n.id, label: truncateLabel(n.label), kind: n.kind, count: n.count }, classes: n.kind })),
    edges: slice.edges.map(e => ({ data: { id: e.id, source: e.source, target: e.target, count: e.count } })),
  }
}

// ELK layered layout options, flowing DOWN so java -> native -> syscall reads
// top to bottom. Values are strings (ELK's option format). The layout runs in
// a Web Worker (see elk.worker.ts); cytoscape only applies the resulting
// positions as a preset layout.
const ELK_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  // Roomier tiers so edges bend cleanly instead of scattering; network-simplex
  // placement keeps nodes aligned per layer.
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.spacing.nodeNode': '48',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
}

export interface ElkGraph {
  id: 'root'
  layoutOptions: Record<string, string>
  children: { id: string; width: number; height: number }[]
  edges: { id: string; sources: string[]; targets: string[] }[]
}

export interface ElkLaidOut {
  children?: { id: string; x?: number; y?: number; width?: number; height?: number }[]
}

// Approximate a node's rendered width from its label (the dot plus the label to
// its right) so ELK spaces columns without overlap.
function nodeWidth(label: string): number {
  return Math.min(230, Math.max(70, label.length * 6.2 + 26))
}

// Map cytoscape element defs to an ELK graph. Pure; the worker runs the layout.
export function sliceToElkGraph(elements: {
  nodes: { data: { id: string; label: string } }[]
  edges: { data: { id: string; source: string; target: string } }[]
}): ElkGraph {
  return {
    id: 'root',
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children: elements.nodes.map(n => ({ id: n.data.id, width: nodeWidth(n.data.label), height: 34 })),
    edges: elements.edges.map(e => ({ id: e.data.id, sources: [e.data.source], targets: [e.data.target] })),
  }
}

// ELK returns each node's top-left corner; cytoscape's preset layout wants the
// centre. Convert, tolerating missing coordinates.
export function elkResultToPositions(result: ElkLaidOut): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  for (const c of result.children ?? []) {
    out[c.id] = { x: (c.x ?? 0) + (c.width ?? 0) / 2, y: (c.y ?? 0) + (c.height ?? 0) / 2 }
  }
  return out
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
