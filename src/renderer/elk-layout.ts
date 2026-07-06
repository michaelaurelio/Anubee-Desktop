import type { Core } from 'cytoscape'
import ELK from 'elkjs/lib/elk-api.js'
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker'
import { sliceToElkGraph, elkResultToPositions, type ElkLaidOut } from './graph-view'

// elkjs runs its GWT solver in its own worker (the elk-worker build, bundled by
// Vite's ?worker import), so layout runs off the main thread; we only apply the
// resulting positions to cytoscape as a preset layout.
const elk = new ELK({ workerFactory: () => new ElkWorker() })

export async function runElkLayout(cy: Core): Promise<void> {
  const elements = {
    nodes: cy.nodes().map(n => ({ data: { id: n.id(), label: String(n.data('label') ?? '') } })),
    edges: cy.edges().map(e => ({
      data: { id: e.id(), source: String(e.data('source')), target: String(e.data('target')) },
    })),
  }
  const graph = sliceToElkGraph(elements)
  const result = (await elk.layout(graph)) as ElkLaidOut
  const positions = elkResultToPositions(result)
  // Apply the ELK positions as a preset layout. Pass the id->position map
  // directly (cytoscape's NodePositionMap) rather than a function - the preset
  // layout hands a callback the node, not its id string, so a keyed map is the
  // unambiguous form.
  cy.layout({ name: 'preset', positions, fit: false }).run()
}
