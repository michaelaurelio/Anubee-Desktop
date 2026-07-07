// Fan-in / fan-out highlight for the aggregated slice. Directed java -> native
// -> syscall: a syscall is a sink (light its fan-in), a java node a source
// (light its subtree), a native node both. Pure set logic (cytoscape traversal);
// the class application is a thin wrapper. See spec Phase 1b s3.1.
import type { Core, NodeSingular, Collection } from 'cytoscape'

export function litNeighborhood(node: NodeSingular): Collection {
  const kind = node.data('kind')
  let rel: Collection
  if (kind === 'syscall') rel = node.predecessors()
  else if (kind === 'java') rel = node.successors()
  else rel = node.predecessors().union(node.successors()) // native
  return rel.union(node)
}

export function highlightNeighborhood(cy: Core, node: NodeSingular): void {
  const lit = litNeighborhood(node)
  cy.elements().removeClass('highlighted dimmed')
  lit.addClass('highlighted')
  cy.elements().not(lit).addClass('dimmed')
}

export function clearHighlight(cy: Core): void {
  cy.elements().removeClass('highlighted dimmed')
}
