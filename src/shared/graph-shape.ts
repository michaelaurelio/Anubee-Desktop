import type { SyscallEvent } from './events'
import { parseFrameSymbol, type ParsedFrame } from './frame-symbol'

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

// Reconstruct a node's kind/label/module from its id. The SQL owns identity +
// counts; labelling lives here so the graph, the flame view, and the legend can
// never drift. Native ids go through the shared parseFrameSymbol.
export function labelForId(id: string): { kind: NodeKind; label: string; module: string | null } {
  if (id.startsWith('java:')) return { kind: 'java', label: id.slice(5), module: null }
  if (id.startsWith('sys:')) return { kind: 'syscall', label: id.slice(4), module: null }
  const rest = id.slice(4) // 'nat:'
  const p = parseFrameSymbol(rest)
  const label = p.symbol ? `${p.symbol} (${p.module})` : (p.module ?? rest)
  return { kind: 'native', label, module: p.module }
}

// A node in the chain, without the aggregate count (added by foldEvents).
type ChainNode = Omit<GraphNode, 'count'>

// The native node id for an already-parsed frame (offset dropped), or null for a
// bare-address frame. Single source of the `nat:` id format so the graph and the
// master-table tag lookup can never build divergent ids.
function nativeIdOf(p: ParsedFrame): string | null {
  return p.module === null ? null : `nat:${p.symbol ? `${p.module}!${p.symbol}` : p.module}`
}

// The native node id for a raw backtrace `symbol` (offset dropped), or null for a
// bare-address frame. Shared so the master-table tag lookup builds the exact same
// id chainOf does.
export function nativeNodeId(symbol: string): string | null {
  return nativeIdOf(parseFrameSymbol(symbol))
}

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
    const id = nativeIdOf(p)
    if (id === null || p.module === null) continue
    const label = p.symbol ? `${p.symbol} (${p.module})` : p.module
    chain.push({ id, kind: 'native', label, module: p.module })
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

  return capSlice([...nodes.values()], [...edges.values()], events.length, cap)
}

// Assemble a GraphSlice, flagging (and trimming to) a max node/edge count.
// Shared by foldEvents (the oracle) and the DuckDB slice so both truncate the
// same way: keep up to `cap` nodes, then the edges among the surviving nodes
// (up to `cap`), so a node-heavy slice still renders its edges. `truncated`
// reflects whether anything was actually dropped, not the raw node+edge sum.
export function capSlice(
  nodes: GraphNode[],
  edges: GraphEdge[],
  eventCount: number,
  cap?: number,
): GraphSlice {
  if (cap === undefined) return { nodes, edges, eventCount, truncated: false }
  const ns = nodes.slice(0, cap)
  const keep = new Set(ns.map(n => n.id))
  // Keep only edges whose endpoints both survive (no dangling edges into dropped
  // nodes), capped independently so a node-heavy slice still renders its edges
  // instead of the old node-first budget starving them to zero.
  const kept = edges.filter(e => keep.has(e.source) && keep.has(e.target))
  const es = kept.slice(0, cap)
  const truncated = ns.length < nodes.length || es.length < kept.length
  return { nodes: ns, edges: es, eventCount, truncated }
}
