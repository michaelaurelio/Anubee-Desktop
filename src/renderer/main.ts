import cytoscape from 'cytoscape'
import elk from 'cytoscape-elk'
import { sliceToElements, elkLayoutOptions, filterForRow } from './graph-view'
import { renderTable } from './table'
import { currentFilter, wireFilterControls } from './filter-controls'
import { showNodeInspector } from './inspector'
import { badgeText, renderTagEditor } from './tag-view'
import { renderSuggestions } from './suggestions-view'
import { upsertTag, removeTag, tagsByTarget, type Tag } from '@shared/project-store'
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
    { selector: 'node[badge]', style: { 'border-width': 3, 'border-color': '#8e44ad' } },
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

let activeRunId: number | undefined
let tags: Tag[] = []

async function refreshTags(): Promise<void> {
  if (activeRunId === undefined) return
  const r = await window.ares.loadTags(activeRunId)
  tags = r.tags
}

async function persistTags(): Promise<void> {
  if (activeRunId === undefined) return
  await window.ares.saveTags(activeRunId, tags)
}

function redrawBadges(): void {
  cy.nodes().forEach(n => {
    const b = badgeText(tagsByTarget(tags, n.id()))
    if (b) n.data('badge', b)
    else n.removeData('badge')
  })
}

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
  const rows = await window.ares.table(currentFilter(), { limit: 500, offset: 0 }, activeRunId)
  renderTable(rows, selectRow, row => {
    const ids = [`sys:${row.syscall}`]
    if (row.topJava) ids.push(`java:${row.topJava}`)
    const rowTags = ids.flatMap(id => tagsByTarget(tags, id))
    return badgeText(rowTags)
  })
  status(`${rows.length} rows`)
}

async function refreshSuggestions(): Promise<void> {
  if (activeRunId === undefined) return
  const host = document.getElementById('suggestions')
  if (!host) return
  const suggestions = await window.ares.suggest(activeRunId)
  renderSuggestions(host, suggestions, async tag => {
    tags = upsertTag(tags, tag)
    await persistTags()
    void refreshTable()
    redrawBadges()
  })
}

async function selectRow(row: TableRow): Promise<void> {
  const slice = await window.ares.slice(filterForRow(row, currentFilter()), undefined, activeRunId)
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
  redrawBadges()
}

// Exposed for the screenshot harness / debugging to drive the graph deterministically.
;(window as unknown as { __cy: typeof cy }).__cy = cy

cy.on('tap', 'node', evt => {
  const nodeId = evt.target.id()
  void window.ares.nodeEvents(nodeId, currentFilter(), activeRunId).then(events => {
    showNodeInspector(nodeId, events)
    const host = document.getElementById('inspector')
    if (!host) return
    renderTagEditor(host, nodeId, undefined, tagsByTarget(tags, nodeId),
      async tag => { tags = upsertTag(tags, tag); await persistTags(); void refreshTable(); redrawBadges() },
      async (t, off) => { tags = removeTag(tags, t, off); await persistTags(); void refreshTable(); redrawBadges() })
  })
})

function wireExport(): void {
  const md = document.getElementById('export-md')
  const json = document.getElementById('export-json')
  md?.addEventListener('click', () => {
    if (activeRunId !== undefined) void window.ares.exportFindings(activeRunId, 'md').then(p => p && status(`Exported ${p}`))
  })
  json?.addEventListener('click', () => {
    if (activeRunId !== undefined) void window.ares.exportFindings(activeRunId, 'json').then(p => p && status(`Exported ${p}`))
  })
}

window.ares.onProgress(pct => status(`Loading... ${pct}%`))
window.ares.onLoaded(s => {
  activeRunId = s.runId
  status(`Loaded ${s.eventCount} events (${s.errors} parse errors)`)
  void refreshTags().then(() => {
    void refreshTable()
    redrawBadges()
    void refreshSuggestions()
  })
})
wireFilterControls(refreshTable)
wireExport()
