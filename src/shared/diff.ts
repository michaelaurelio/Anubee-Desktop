import type { GraphNode, GraphEdge, NodeKind } from './graph-shape'

export type Presence = 'A-only' | 'B-only' | 'both'

export interface DiffRow {
  id: string
  kind: NodeKind
  label: string
  countA: number
  countB: number
  delta: number
  presence: Presence
}

export interface MergedNode extends GraphNode {
  presence: Presence
}

export interface MergedSlice {
  nodes: MergedNode[]
  edges: (GraphEdge & { presence: Presence })[]
  truncated: boolean
}

export function presenceOf(a: number, b: number): Presence {
  if (a > 0 && b === 0) return 'A-only'
  if (a === 0 && b > 0) return 'B-only'
  return 'both'
}
