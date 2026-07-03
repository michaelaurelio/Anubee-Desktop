import type { SyscallEvent } from './events'
import { parseFrameSymbol } from './frame-symbol'

export type NodeKind = 'java' | 'native' | 'syscall'

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  module: string | null
  count: number
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  count: number
}

export interface GraphSlice {
  nodes: GraphNode[]
  edges: GraphEdge[]
  eventCount: number
  truncated: boolean
}

// A node in the chain, without the aggregate count (added by foldEvents).
type ChainNode = Omit<GraphNode, 'count'>

// The ordered top->bottom chain for one event:
//   java_stack (outermost first), native backtrace (outermost first), syscall.
// backtrace[0] is innermost (closest to the syscall), so both stacks are
// reversed to read top-to-bottom. Bare-address frames (module null) are skipped.
// Offsets are dropped from native ids so call sites within a function collapse.
export function chainOf(e: SyscallEvent): ChainNode[] {
  const chain: ChainNode[] = []

  for (const m of [...(e.java_stack ?? [])].reverse()) {
    chain.push({ id: `java:${m}`, kind: 'java', label: m, module: null })
  }

  for (const f of [...e.backtrace].reverse()) {
    const p = parseFrameSymbol(f.symbol)
    if (p.module === null) continue
    const key = p.symbol ? `${p.module}!${p.symbol}` : p.module
    const label = p.symbol ? `${p.symbol} (${p.module})` : p.module
    chain.push({ id: `nat:${key}`, kind: 'native', label, module: p.module })
  }

  chain.push({ id: `sys:${e.syscall}`, kind: 'syscall', label: e.syscall, module: null })
  return chain
}

// Aggregate a set of events into nodes + edges with occurrence counts. This is
// the in-memory oracle the DuckDB slice SQL (Task 6b) must match. `cap` flags
// (and trims to) a maximum node+edge count; the renderer shows a truncation
// banner rather than a hairball.
export function foldEvents(events: SyscallEvent[], cap?: number): GraphSlice {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()

  for (const e of events) {
    const chain = chainOf(e)
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i]
      const n = nodes.get(c.id)
      if (n) n.count++
      else nodes.set(c.id, { ...c, count: 1 })

      if (i > 0) {
        const source = chain[i - 1].id
        const target = c.id
        const id = `${source}=>${target}`
        const edge = edges.get(id)
        if (edge) edge.count++
        else edges.set(id, { id, source, target, count: 1 })
      }
    }
  }

  let nodeList = [...nodes.values()]
  let edgeList = [...edges.values()]
  const truncated = cap !== undefined && nodeList.length + edgeList.length > cap
  if (truncated) {
    // Deterministic trim by insertion order — keeps nodes, then edges, up to cap.
    nodeList = nodeList.slice(0, cap)
    edgeList = edgeList.slice(0, Math.max(0, cap - nodeList.length))
  }

  return { nodes: nodeList, edges: edgeList, eventCount: events.length, truncated }
}
