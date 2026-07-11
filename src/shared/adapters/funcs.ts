import type { FuncEvent } from '../events'
import { parseFrameSymbol } from '../frame-symbol'
import { labelForId, type GraphNode, type GraphEdge } from '../graph-shape'

// Turns `ares funcs` call/return records into `fn:` nodes with call-nesting
// edges from the immediate native caller. backtrace[0] is the called
// function's own PC (bpf_get_stack captures the user stack starting at the
// uprobe's current PC - see ARES/src/funcs/funcs.bpf.c), so the caller is
// backtrace[1]; that's the same "one frame in" convention chainOf uses for
// syscalls. One edge per call record; a return only bumps its node's count
// (elapsed_ns/retval aren't graph data yet, matched to their call by
// module+symbol - funcs has no span id to pair them more precisely).
export function funcsAdapter(rows: FuncEvent[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  // Every edge endpoint must be a real node in the returned set - the renderer
  // (sliceToElements -> cy.add) throws on an edge whose source/target has no
  // matching node, and a funcs-only run has zero SQL-built native nodes to
  // fall back on.
  const bump = (id: string) => {
    const n = nodes.get(id)
    if (n) n.count++
    else nodes.set(id, { id, ...labelForId(id), count: 1 })
  }

  for (const r of rows) {
    const id = `fn:${r.module}!${r.symbol}`
    bump(id)

    if (r.type !== 'call') continue
    const parentFrame = r.backtrace[1]
    if (!parentFrame) continue
    const p = parseFrameSymbol(parentFrame.symbol)
    if (p.module === null) continue
    const parentKey = p.symbol ? `${p.module}!${p.symbol}` : p.module
    const source = `nat:${parentKey}`
    bump(source)
    const edgeId = `${source}=>${id}`
    const e = edges.get(edgeId)
    if (e) e.count++
    else edges.set(edgeId, { id: edgeId, source, target: id, count: 1 })
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}
