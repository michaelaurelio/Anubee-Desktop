import type { CorrelateEvent } from '../events'
import { labelForId, type GraphNode, type GraphEdge } from '../graph-shape'

// Turns `ares correlate` func/syscall/return records into `fn:` nodes (keyed
// by span - correlate's span-open record carries no symbol/module, only
// entry_addr, a known limitation) with func->func nesting edges and
// func->sys: edges for the syscalls each span issued. `sys:` ids use the same
// grammar the syscall SQL path builds, so a correlate run's syscalls line up
// with any syscall-engine data in the same run (the point of EPIC B).
export function correlateAdapter(rows: CorrelateEvent[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const bump = (id: string) => {
    const n = nodes.get(id)
    if (n) n.count++
    else nodes.set(id, { id, ...labelForId(id), count: 1 })
  }
  const addEdge = (source: string, target: string) => {
    const id = `${source}=>${target}`
    const e = edges.get(id)
    if (e) e.count++
    else edges.set(id, { id, source, target, count: 1 })
  }

  // Pass 1: reserve every span's func-node id at count 0 - the span's own
  // 'func' row bumps it to 1 in pass 2 regardless of row order, so a child's
  // parent_span always resolves to a real node even when the parent's own
  // row comes later in the file (and referencing a span as a parent never by
  // itself inflates that parent's count - only its own row does).
  const spanToId = new Map<number, string>()
  for (const r of rows) {
    if (r.type !== 'func') continue
    const id = `fn:${r.entry_addr}` // entry_addr already carries its own "0x" prefix
    spanToId.set(r.span, id)
    if (!nodes.has(id)) nodes.set(id, { id, ...labelForId(id), count: 0 })
  }

  for (const r of rows) {
    if (r.type === 'func') {
      const id = spanToId.get(r.span)!
      bump(id)
      if (r.parent_span === 0) continue // 0 = no open parent (root span)
      const parentId = spanToId.get(r.parent_span)
      if (!parentId) continue
      addEdge(parentId, id)
    } else if (r.type === 'syscall') {
      // The syscall itself is always real, shown even if its span's own
      // 'func' row fell outside this batch - only the edge needs it resolved.
      const sysId = `sys:${r.syscall}`
      bump(sysId)
      const funcId = spanToId.get(r.span)
      if (funcId) addEdge(funcId, sysId)
    } else {
      // 'return': matched to its call by span - only bumps the existing
      // func node's count (elapsed_ns/retval aren't graph data yet), same
      // convention as the funcs adapter.
      const funcId = spanToId.get(r.span)
      if (!funcId) continue
      bump(funcId)
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}
