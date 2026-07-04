import cytoscape from 'cytoscape'
import elk from 'cytoscape-elk'
import { sliceToElements, elkLayoutOptions, filterForRow } from './graph-view'
import { renderTable } from './table'
import { currentFilter, wireFilterControls } from './filter-controls'
import { showNodeInspector } from './inspector'
import type { TableRow } from '@shared/table'

cytoscape.use(elk)

const cy = cytoscape({
  container: document.getElementById('cy'),
  style: [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-size': 10,
        'text-wrap': 'wrap',
        'text-max-width': '200px',
        // Place the label beside the node (not on it) so the edge/arrow never
        // crosses the text; a light backing keeps it legible over edges.
        'text-halign': 'right',
        'text-valign': 'center',
        'text-margin-x': 8,
        'text-background-color': '#ffffff',
        'text-background-opacity': 0.82,
        'text-background-shape': 'roundrectangle',
        'text-background-padding': '2',
        width: 18,
        height: 18,
      },
    },
    { selector: 'node[kind = "java"]', style: { 'background-color': '#27ae60', shape: 'diamond' } },
    { selector: 'node[kind = "native"]', style: { 'background-color': '#2980b9' } },
    { selector: 'node[kind = "syscall"]', style: { 'background-color': '#c0392b', shape: 'round-rectangle' } },
    {
      selector: 'edge',
      style: {
        width: 'mapData(count, 1, 50, 1, 5)',
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'line-color': '#b0b0b0',
        'target-arrow-color': '#b0b0b0',
      },
    },
  ],
})

function status(text: string): void {
  const el = document.getElementById('status')
  if (el) el.textContent = text
}

function showBanner(truncated: boolean): void {
  const b = document.getElementById('banner')
  if (!b) return
  b.style.display = truncated ? 'block' : 'none'
  if (truncated) b.textContent = 'Graph truncated - narrow the filter to see the full slice.'
}

async function refreshTable(): Promise<void> {
  const rows = await window.ares.table(currentFilter(), { limit: 500, offset: 0 })
  renderTable(rows, selectRow)
  status(`${rows.length} rows`)
}

async function selectRow(row: TableRow): Promise<void> {
  const slice = await window.ares.slice(filterForRow(row, currentFilter()))
  const els = sliceToElements(slice)
  cy.elements().remove()
  cy.add(els.nodes)
  cy.add(els.edges)
  const layout = cy.layout(elkLayoutOptions())
  const settled = layout.promiseOn('layoutstop')
  layout.run()
  await settled
  cy.fit(undefined, 48) // frame the slice with padding; consistent zoom per selection
  showBanner(slice.truncated)
}

// Exposed for the screenshot harness / debugging to drive the graph deterministically.
;(window as unknown as { __cy: typeof cy }).__cy = cy

cy.on('tap', 'node', evt => {
  const nodeId = evt.target.id()
  void window.ares.nodeEvents(nodeId, currentFilter()).then(events => showNodeInspector(nodeId, events))
})

window.ares.onProgress(pct => status(`Loading... ${pct}%`))
window.ares.onLoaded(s => {
  status(`Loaded ${s.eventCount} events (${s.errors} parse errors)`)
  void refreshTable()
})
wireFilterControls(refreshTable)
