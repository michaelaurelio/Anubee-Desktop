import cytoscape from 'cytoscape'
import { sliceToElements, filterForRow } from './graph-view'
import { runElkLayout } from './elk-layout'
import { renderTable } from './table'
import { currentFilter, wireFilterControls } from './filter-controls'
import { showNodeInspector } from './inspector'
import { badgeText, renderTagEditor } from './tag-view'
import { renderSuggestions } from './suggestions-view'
import { renderOrphans } from './orphans-view'
import { upsertTag, removeTag, tagsByTarget, orphanedTags, type Tag } from '@shared/project-store'
import type { TableRow } from '@shared/table'
import { renderDiffTable, mergedToElements, filterDiffRows, type DiffMode } from './diff-view'

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
    { selector: 'node[presence = "A-only"]', style: { 'background-color': '#c0392b' } },
    { selector: 'node[presence = "B-only"]', style: { 'background-color': '#27ae60' } },
    { selector: 'node[presence = "both"]', style: { 'background-color': '#95a5a6' } },
    { selector: 'edge[presence = "A-only"]', style: { 'line-color': '#c0392b', 'target-arrow-color': '#c0392b' } },
    { selector: 'edge[presence = "B-only"]', style: { 'line-color': '#27ae60', 'target-arrow-color': '#27ae60' } },
  ],
})

let activeRunId: number | undefined
let tags: Tag[] = []
let runB: number | undefined
let diffMode: DiffMode = 'all'

async function refreshTags(): Promise<void> {
  const rid = activeRunId
  if (rid === undefined) return
  const r = await window.ares.loadTags(rid)
  if (activeRunId === rid) tags = r.tags
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

async function refreshOrphans(): Promise<void> {
  const host = document.getElementById('orphans')
  if (!host || activeRunId === undefined) return
  const targets = [...new Set(tags.map(t => t.target))]
  const orphanSet = new Set(targets.length ? await window.ares.orphans(activeRunId, targets) : [])
  const drop = async (target: string, off?: string) => {
    tags = removeTag(tags, target, off)
    await persistTags()
    void refreshTable()
    redrawBadges()
    void refreshOrphans()
  }
  renderOrphans(host, orphanedTags(tags, orphanSet), drop, async () => {
    for (const o of orphanedTags(tags, orphanSet)) tags = removeTag(tags, o.target, o.offset)
    await persistTags()
    void refreshTable()
    redrawBadges()
    void refreshOrphans()
  })
}

async function selectRow(row: TableRow): Promise<void> {
  const slice = await window.ares.slice(filterForRow(row, currentFilter()), undefined, activeRunId)
  const els = sliceToElements(slice)
  cy.elements().remove()
  cy.add(els.nodes)
  cy.add(els.edges)
  await runElkLayout(cy)
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

async function refreshDiff(): Promise<void> {
  const host = document.getElementById('diff-table')
  if (!host || activeRunId === undefined || runB === undefined) return
  const rows = await window.ares.diffTable(activeRunId, runB, currentFilter(), 1000)
  const taggedIds = new Set(tags.map(t => t.target))
  renderDiffTable(host, filterDiffRows(rows, diffMode, taggedIds),
    id => badgeText(tagsByTarget(tags, id)),
    async id => {
      const merged = await window.ares.diffSlice(activeRunId!, runB!, id, currentFilter())
      const els = mergedToElements(merged)
      cy.elements().remove()
      cy.add(els.nodes)
      cy.add(els.edges)
      await runElkLayout(cy)
      cy.fit(undefined, 48)
    })
}

function wireDiff(): void {
  document.getElementById('load-run-b')?.addEventListener('click', async () => {
    const runA = activeRunId
    const summary = await window.ares.openFile()
    if (summary) {
      runB = summary.runId
      activeRunId = runA
      await refreshTags()
      void refreshDiff()
    }
  })
  document.getElementById('diff-mode')?.addEventListener('change', e => {
    diffMode = (e.target as HTMLSelectElement).value as DiffMode
    void refreshDiff()
  })
}

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
    void refreshOrphans()
  })
})
wireFilterControls(refreshTable)
wireExport()
wireDiff()
