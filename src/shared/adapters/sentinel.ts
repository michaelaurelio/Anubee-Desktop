import type { DetectorEvent } from '../events'
import { parseFrameSymbol } from '../frame-symbol'
import { labelForId, type GraphNode, type GraphEdge } from '../graph-shape'

// Turns SENTINEL RASP check verdicts into `check:<check_id>` nodes, linked to
// the native block that implements the check via a symbol-name match against
// the check's free-form `detail` string. `natNodeIds` are the SQL-built
// `nat:` ids already present in the slice, so they're guaranteed real nodes -
// this adapter never needs to create one, only edges (unlike funcs/correlate,
// whose caller/parent nodes aren't otherwise guaranteed to exist).
// Pure - the live logcat/JSONL importer that synthesizes `type: 'sentinel'`
// on ingest is EPIC E, not built here; this only turns already-typed rows
// into graph content.
export function sentinelAdapter(
  rows: DetectorEvent[],
  natNodeIds: string[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()

  for (const r of rows) {
    const id = `check:${r.check_id}`
    const n = nodes.get(id)
    if (n) n.count++
    else nodes.set(id, { id, ...labelForId(id), count: 1 })

    // Best-effort: `detail` is a free-form string the native check itself sets
    // (e.g. "libc.so+0x3c(BRK)") - it doesn't always carry a resolved symbol,
    // so a miss here is expected, not a bug.
    const match = natNodeIds.find(natId => {
      const p = parseFrameSymbol(natId.slice(4)) // strip 'nat:'
      return p.symbol !== null && r.detail.includes(p.symbol)
    })
    if (!match) continue
    const edgeId = `${match}=>${id}`
    const e = edges.get(edgeId)
    if (e) e.count++
    else edges.set(edgeId, { id: edgeId, source: match, target: id, count: 1 })
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}
