import { labelForId, type NodeKind } from './graph-shape'

// The aggregated stack rollup shipped from the store: distinct chains + counts.
// `truncated` reports the SQL row cap (protects IPC); `buildFlame`'s own cap
// reports the tree-node cap (protects rendering).
export interface StackRollup {
  rows: { chain: string[]; count: number }[]
  eventCount: number
  distinctChains: number
  truncated: boolean
}

export type FlameKind = NodeKind | 'root'

export interface FlameNode {
  id: string
  label: string
  kind: FlameKind
  value: number // summed count of every chain passing through this node
  depth: number // 0 = synthetic root
  children: FlameNode[]
}

export interface FlameTree {
  root: FlameNode
  nodeCount: number
  truncated: boolean
}

// Fold distinct chains into a weighted prefix tree under a synthetic root.
// Heaviest chains are inserted first so the optional node `cap` keeps the
// hottest paths, and the result is deterministic regardless of input order.
export function buildFlame(rows: { chain: string[]; count: number }[], cap?: number): FlameTree {
  const root: FlameNode = { id: 'root', label: 'all', kind: 'root', value: 0, depth: 0, children: [] }
  let nodeCount = 1
  let truncated = false

  const ordered = [...rows].sort(
    (a, b) => b.count - a.count || a.chain.join(' ').localeCompare(b.chain.join(' ')),
  )

  for (const { chain, count } of ordered) {
    root.value += count
    let node = root
    for (let d = 0; d < chain.length; d++) {
      const id = chain[d]
      let child = node.children.find(c => c.id === id)
      if (!child) {
        if (cap !== undefined && nodeCount >= cap) { truncated = true; break }
        const { kind, label } = labelForId(id)
        child = { id, label, kind, value: 0, depth: d + 1, children: [] }
        node.children.push(child)
        nodeCount++
      }
      child.value += count
      node = child
    }
  }

  const sortRec = (n: FlameNode): void => {
    n.children.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
    n.children.forEach(sortRec)
  }
  sortRec(root)

  return { root, nodeCount, truncated }
}

export interface FlameRect {
  node: FlameNode
  label: string
  kind: FlameKind
  x: number
  y: number
  w: number
  h: number
  value: number
}

// Icicle layout: `root` spans the full width at the top; each node's children
// partition its width in proportion to their value; y grows with depth. `depth`
// here is relative to the passed root, so re-rooting (zoom) reuses this as-is.
export function layoutFlame(root: FlameNode, width: number, rowHeight: number): FlameRect[] {
  const rects: FlameRect[] = []
  const walk = (n: FlameNode, x: number, w: number, depth: number): void => {
    rects.push({ node: n, label: n.label, kind: n.kind, x, y: depth * rowHeight, w, h: rowHeight, value: n.value })
    let cx = x
    for (const c of n.children) {
      const cw = n.value > 0 ? (w * c.value) / n.value : 0
      walk(c, cx, cw, depth + 1)
      cx += cw
    }
  }
  walk(root, 0, width, 0)
  return rects
}
