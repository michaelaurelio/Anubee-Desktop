import type { SyscallEvent, FuncEvent } from './events'
import { parseFrameSymbol, type ParsedFrame } from './frame-symbol'

// Trailing ART bytecode offset on a managed frame name (+0x<dexpc>). Dropped
// from java: ids so one method is one node - the managed analogue of the
// offset-strip parseFrameSymbol already does for native frames.
const JAVA_DEXPC = /\+0x[0-9a-fA-F]+$/

export type NodeKind = 'java' | 'native' | 'syscall' | 'func'

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
  if (id.startsWith('fn:')) return { kind: 'func', label: id.slice(3), module: null }
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
    const clean = m.replace(JAVA_DEXPC, '')
    chain.push({ id: `java:${clean}`, kind: 'java', label: clean, module: null })
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

// The hooked function key for a funcs record: "module!symbol". This is what a
// backtrace frame must match to be promoted from a nat: scaffold node to the
// same fn: node as its own call records (graph unification).
export function funcKey(e: FuncEvent): string {
  return `${e.module}!${e.symbol}`
}

// The ordered outermost->function chain for one funcs `call`: reversed
// java_stack (when captured), then reversed backtrace. Each native frame whose
// cleaned "module!symbol" is in `hooked` becomes a fn: node (unify), else nat:.
// Bare-address frames dropped; offsets stripped so call sites collapse. The
// function's own leaf frame (backtrace[0]) is in `hooked` by construction.
export function chainOfFunc(e: FuncEvent, hooked: Set<string>): ChainNode[] {
  const chain: ChainNode[] = []
  for (const m of [...(e.java_stack ?? [])].reverse()) {
    const clean = m.replace(JAVA_DEXPC, '')
    chain.push({ id: `java:${clean}`, kind: 'java', label: clean, module: null })
  }
  for (const f of [...e.backtrace].reverse()) {
    const p = parseFrameSymbol(f.symbol)
    if (p.module === null) continue // bare-address frame
    const key = p.symbol ? `${p.module}!${p.symbol}` : p.module
    if (p.symbol && hooked.has(key)) {
      chain.push({ id: `fn:${key}`, kind: 'func', label: key, module: null })
    } else {
      chain.push({ id: `nat:${key}`, kind: 'native', label: p.symbol ? `${p.symbol} (${p.module})` : p.module, module: p.module })
    }
  }
  return chain
}

// Fold funcs `call` events into nodes + edges with occurrence counts - the
// in-memory oracle the FUNCS_CHAIN_SQL slice must match. The hooked-set is
// derived from the calls themselves (their own module!symbol). Returns only;
// never pass `return` records here (their backtrace is the return site).
export function foldFuncEvents(calls: FuncEvent[], cap?: number): GraphSlice {
  const hooked = new Set(calls.map(funcKey))
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  for (const e of calls) {
    const chain = chainOfFunc(e, hooked)
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i]
      const n = nodes.get(c.id)
      if (n) n.count++
      else nodes.set(c.id, { ...c, count: 1 })
      if (i > 0) {
        const source = chain[i - 1].id
        const id = `${source}=>${c.id}`
        const edge = edges.get(id)
        if (edge) edge.count++
        else edges.set(id, { id, source, target: c.id, count: 1 })
      }
    }
  }
  return capSlice([...nodes.values()], [...edges.values()], calls.length, cap)
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

// Combine node/edge sets from multiple sources (the syscall SQL path + each
// engine adapter, in graph-store.ts's slice()) into one id-deduplicated set,
// summing counts when two sources agree on the same node/edge id. The shared
// nat:/sys:/fn:/... identity grammar is the whole point of cross-engine
// correlation (EPIC B), so two sources naming the same node must combine into
// one GraphNode, not add a second object with the same id - sliceToElements
// -> cy.add() throws on a duplicate node id. Order-independent.
export function mergeGraphs(
  ...sources: { nodes: GraphNode[]; edges: GraphEdge[] }[]
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  for (const s of sources) {
    for (const n of s.nodes) {
      const existing = nodes.get(n.id)
      if (existing) existing.count += n.count
      else nodes.set(n.id, { ...n })
    }
    for (const e of s.edges) {
      const existing = edges.get(e.id)
      if (existing) existing.count += e.count
      else edges.set(e.id, { ...e })
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
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
