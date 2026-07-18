// Backtrace-accurate highlight for the aggregated slice. The lit set comes from
// the main-process co-occurrence query (highlightSets), which reuses the exact
// per-event chain SQL the graph was folded from - so it is a faithful subset of
// the rendered nodes/edges, never a topological over-reach through a shared
// native node (JNI trampoline). This module only stamps the classes.
import type { Core } from 'cytoscape'
import type { HighlightSets } from '@shared/graph-shape'

export function applyHighlight(cy: Core, sets: HighlightSets): void {
  const lit = new Set<string>([...sets.nodes, ...sets.edges])
  cy.elements().removeClass('highlighted dimmed')
  cy.elements().forEach(el => { el.addClass(lit.has(el.id()) ? 'highlighted' : 'dimmed') })
}

export function clearHighlight(cy: Core): void {
  cy.elements().removeClass('highlighted dimmed')
}
