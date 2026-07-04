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
    { selector: 'node', style: { label: 'data(label)', 'font-size': 9, 'text-wrap': 'wrap', 'text-max-width': '140px', width: 16, height: 16 } },
    { selector: 'node[kind = "java"]', style: { 'background-color': '#27ae60', shape: 'diamond' } },
    { selector: 'node[kind = "native"]', style: { 'background-color': '#2980b9' } },
    { selector: 'node[kind = "syscall"]', style: { 'background-color': '#c0392b', shape: 'round-rectangle' } },
    { selector: 'edge', style: { width: 'mapData(count, 1, 50, 1, 6)', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': '#999', 'target-arrow-color': '#999' } },
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
  await cy.layout(elkLayoutOptions()).run()
  showBanner(slice.truncated)
}

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
