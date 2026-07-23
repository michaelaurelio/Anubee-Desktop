import cytoscape from 'cytoscape'
import { themeColors, categoryColors, parseTheme, serializeTheme, type Theme } from './theme'
import { wirePanels } from './panels'
import { sliceToElements, filterForRow } from './graph-view'
import { runElkLayout } from './elk-layout'
import { renderTable } from './table'
import { serializeLayout, parseLayout, columnCatalogue, engineColumnKeys, engineDefaultColumns, type ColumnLayout, type ColumnKey } from './columns'
import { applyWidths, nextWidth } from './column-resize'
import { currentFilter, wireFilterControls, setTagResolver } from './filter-controls'
import { resolveTagTargets } from '@shared/tag-targets'
import { showNodeInspector, showRecordDetail, showFuncsNodeInspector, showFuncsRecordDetail, type InspectorPage } from './inspector'
import { badgeText, renderTagEditor } from './tag-view'
import { applyHighlight, clearHighlight } from './graph-highlight'
import { showOffsetPopup, closeOffsetPopup, type NodeBox } from './offset-popup'
import { showNodeMenu, closeNodeMenu, showTagPopup, closeTagPopup } from './node-menu'
import { renderSuggestions } from './suggestions-view'
import { renderOrphans } from './orphans-view'
import { renderRules } from './rules-view'
import { raspNodeStates } from './rasp-node-state'
import { upsertTag, removeTag, tagsByTarget, orphanedTags, isDismissed, addDismissed, type Tag, type Dismissed, type RaspCategory } from '@shared/project-store'
import type { TableRow } from '@shared/table'
import { nativeNodeId } from '@shared/graph-shape'
import { renderDiffTable, mergedToElements, filterDiffRows, type DiffMode } from './diff-view'
import { renderFlame } from './flame-view'
import { buildFlame } from '@shared/flame-shape'
import { GRAPH_SLICE_CAP, FLAME_CHAIN_CAP, FLAME_NODE_CAP } from '@shared/caps'
import type { GraphSlice } from '@shared/graph-shape'
import type { Filter } from '@shared/filter'
import {
  renderCapabilityForm, renderEngineSegments, specsDirRow, applySpecChoices,
  applyFieldErrors, renderDot, appendConsoleLine, appendConsoleLines, CONSOLE_LINE_CAP,
} from './capture-view'
import { renderArgvPreview } from './argv-preview'
import { coverageChipText } from './coverage-chip'
import { captureFooter, renderCaptureFooter, setFooterCounters, type PreflightState } from './capture-footer'
import {
  resetPreflightPane, appendPreflightCheck, markPreflightStale, preflightSummary,
} from './capture-preflight-view'
import {
  CAPABILITIES, capById, validateInputs, fieldErrors, capNeedsSpec, composeRunArg,
  type CapValues, type Capability,
} from '@shared/tracer-caps'
import { showModal, closeModal, isModalOpen } from './modal'
import { initLoadingUi, ingest, graph, errorToast } from './loading-ui'
import { renderLogModal } from './log-view'
import { logAppend } from './log-store'
import { runLogged } from './run-logged'
import { makeEpoch } from './selection-epoch'
import type { SyscallEvent, FuncEvent } from '@shared/events'
import { createLibView, type LibViewApi } from './native-lib-view'

let theme: Theme = parseTheme(localStorage.getItem('anubee.theme'))
document.documentElement.setAttribute('data-theme', theme)
const tc = themeColors(theme)

const cy = cytoscape({
  container: document.getElementById('cy'),
  autoungrabify: true, // uniform boxes are not draggable; pan/zoom still work
  style: [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-size': 10,
        'text-wrap': 'wrap',
        'text-max-width': '150px',
        'text-halign': 'center',
        'text-valign': 'center',
        color: tc.labelText,
        shape: 'round-rectangle',
        width: 'label',
        height: 'label',
        padding: '8px',
        'background-color': tc.labelBacking,
        'border-width': 2,
        'border-color': tc.native, // default; per-kind rules below override
      },
    },
    { selector: 'node[kind = "java"]', style: { 'border-color': tc.java } },
    { selector: 'node[kind = "native"]', style: { 'border-color': tc.native } },
    { selector: 'node[kind = "syscall"]', style: { 'border-color': tc.syscall } },
    { selector: 'node[kind = "func"]', style: { 'border-color': tc.func } },
    // Badge border marks a tagged node; scoped to non-native so it doesn't
    // double-mark native nodes, which use the RASP category accent instead.
    { selector: 'node[badge][kind != "native"]', style: { 'border-width': 3, 'border-color': '#8e44ad' } },
    {
      selector: 'edge',
      style: {
        width: 'data(w)',
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 1.2,
        'line-color': tc.edge,
        'target-arrow-color': tc.edge,
      },
    },
    { selector: 'node[presence = "A-only"]', style: { 'background-color': '#c0392b' } },
    { selector: 'node[presence = "B-only"]', style: { 'background-color': '#27ae60' } },
    { selector: 'node[presence = "both"]', style: { 'background-color': '#9a928a' } },
    { selector: 'edge[presence = "A-only"]', style: { 'line-color': '#c0392b', 'target-arrow-color': '#c0392b' } },
    { selector: 'edge[presence = "B-only"]', style: { 'line-color': '#27ae60', 'target-arrow-color': '#27ae60' } },
    { selector: '.dimmed', style: { 'opacity': 0.12 } },
    // Off-path (dimmed) edges carry no arrowhead and go hair-thin: a de-emphasized
    // edge should recede, and its triangle arrowhead - which scales with edge width
    // and the (high) zoom of a small subgraph - was rendering as a large grey blob.
    { selector: 'edge.dimmed', style: { 'target-arrow-shape': 'none', 'width': 1 } },
    // Edges read grey by default; the selected node's backtrace chain lights them
    // brightly so a single click clearly connects the chain.
    { selector: 'edge.highlighted', style: {
      'line-color': tc.labelText, 'target-arrow-color': tc.labelText,
      'width': 3.5, 'arrow-scale': 1.3, 'opacity': 1, 'z-index': 10,
    } },
    { selector: 'node.highlighted', style: { 'border-width': 3, 'z-index': 10 } },
  ],
})

// RASP category style rules for native nodes: confirmed = solid category-color
// border (flat body), suggested = dashed category-color border. Built from categoryColors()
// so no hex is hardcoded here; called at init and on theme toggle.
function styleRaspCategories(t: Theme): void {
  const cc = categoryColors(t)
  let s = cy.style()
  for (const [cat, color] of Object.entries(cc)) {
    s = s.selector(`node.native.confirmed.rasp-${cat}`).style({
      'background-color': themeColors(t).labelBacking,
      'border-color': color,
      'border-width': 2,
    })
    s = s.selector(`node.native.suggested.rasp-${cat}`).style({
      'border-color': color,
      'border-style': 'dashed',
      'border-width': 2,
    })
  }
  s.update()
}
styleRaspCategories(theme)

const RASP_CLASSES = ['suggested', 'confirmed', ...Object.keys(categoryColors('dark')).map(c => `rasp-${c}`)].join(' ')

// Fetch current suggestions, fold with confirmed tags, and re-point each native
// node's class to its RASP category+state (Section C: coloring lives on native,
// not the syscall aggregate or java frames).
async function recolorRasp(): Promise<void> {
  if (activeRunId === undefined) return
  const suggestions = (await window.anubee.suggest(activeRunId))
    .filter(s => !isDismissed(dismissed, s.target, s.category))
  const states = raspNodeStates(suggestions, tags)
  cy.nodes().forEach(n => {
    n.removeClass(RASP_CLASSES)
    const st = states.get(n.id())
    if (st && n.data('kind') === 'native') n.addClass(`${st.state} rasp-${st.category}`)
  })
}

let activeRunId: number | undefined
let activeEngine: 'syscall' | 'func' = 'syscall'

// Per-engine column preference key. The legacy `anubee.columns` (syscall-only) is
// read as the syscall fallback so a returning user keeps their saved columns.
function columnsKey(engine: 'syscall' | 'func'): string {
  return `anubee.columns.${engine}`
}
function savedColumns(engine: 'syscall' | 'func'): string | null {
  return localStorage.getItem(columnsKey(engine)) ?? (engine === 'syscall' ? localStorage.getItem('anubee.columns') : null)
}

let tags: Tag[] = []
let dismissed: Dismissed[] = []
let runB: number | undefined
let diffMode: DiffMode = 'all'
let currentView: 'graph' | 'flame' | 'libs' = 'graph'
// Unsaved-project-changes flag: set on any tag/dismiss/rule mutation, cleared
// once Save project completes; drives the save-on-close confirmation.
let dirty = false

async function refreshTags(): Promise<void> {
  const rid = activeRunId
  if (rid === undefined) return
  const [r, dm] = await Promise.all([window.anubee.loadTags(rid), window.anubee.dismissedGet(rid)])
  if (activeRunId === rid) { tags = r.tags; dismissed = dm }
}

async function persistTags(): Promise<void> {
  if (activeRunId === undefined) return
  try {
    await window.anubee.saveTags(activeRunId, tags)
    dirty = true
    logAppend('success', 'tags', 'Tags saved')
  } catch (e) {
    logAppend('error', 'tags', e instanceof Error ? e.message : String(e))
    throw e
  }
}

function redrawBadges(): void {
  cy.nodes().forEach(n => {
    const b = badgeText(tagsByTarget(tags, n.id()))
    if (b) n.data('badge', b)
    else n.removeData('badge')
  })
}

function showTablePanel(visible: boolean): void {
  document.getElementById('table')?.classList.toggle('hidden', !visible)
  document.getElementById('table-resize')?.classList.toggle('hidden', !visible)
  document.getElementById('tab-left')?.classList.toggle('hidden', !visible)
}

function showSide(visible: boolean): void {
  document.getElementById('side')?.classList.toggle('hidden', !visible)
  document.getElementById('side-resize')?.classList.toggle('hidden', !visible)
}

// #banner is a quiet top-right chip shared by the graph-truncation warning
// and the EPIC A coverage health summary - whichever message is passed wins
// (both are simple one-off informational states, not stacked notifications).
// An empty/absent message always hides the chip, regardless of `show`.
function showBanner(show: boolean, message?: string): void {
  const b = document.getElementById('banner')
  if (!b) return
  const text = message ?? ''
  b.style.display = show && text ? 'block' : 'none'
  if (show && text) b.textContent = text
}

// Coverage summary text computed on load; only surfaced once a row is
// selected (renderSlice), so the chip never appears before there's a graph.
let coverageChip = ''

// The master table renders at most one page; a filter matching more than this
// shows "first <PAGE> of <total>" so the hidden remainder is never silent.
const TABLE_PAGE = 500

let tableOffset = 0
let selectedRowId: number | undefined // the row whose detail is open, so re-renders can re-highlight it

const NODE_PAGE = 100 // inspector page size; mirrors TABLE_PAGE for the right panel

let nodeOffset = 0 // records offset into the current node's list
// What refreshNodeInspector needs to re-fetch a page: the tapped node's identity
// and the filter it was tapped under (graphFilter at tap time). Undefined = no node open.
let currentNode: { id: string; kind?: string; cats: string[]; filter: Filter } | undefined
// The filter the on-canvas graph was rendered with (a row's bridge ANDed with the
// toolbar filter). Every graph-scoped follow-up query (node highlight, node detail
// records, offsets) keys off this, not currentFilter(), so it stays strictly tied
// to what is drawn - the graph only re-renders on row selection.
let graphFilter: Filter = {}
const selEpoch = makeEpoch() // guards stale-async paints across row-select / node-tap / canvas-clear
let currentLayout: ColumnLayout = parseLayout(activeEngine, savedColumns(activeEngine))

function renderPager(offset: number, pageLen: number, total: number): void {
  const rng = document.getElementById('pager-range')
  const prev = document.getElementById('pager-prev') as HTMLButtonElement | null
  const next = document.getElementById('pager-next') as HTMLButtonElement | null
  if (rng) rng.textContent = total === 0 ? '0 / 0' : `${offset + 1}–${offset + pageLen} / ${total}`
  if (prev) prev.disabled = offset <= 0
  if (next) next.disabled = offset + TABLE_PAGE >= total
}

function highlightTableRow(id: number): void {
  for (const tr of document.querySelectorAll('#table tr.sel')) tr.classList.remove('sel')
  document.querySelector(`#table tr[data-row-id="${id}"]`)?.classList.add('sel')
}

// The tags cell for a master-table row: the RASP tags on the row's innermost
// native frame (native nodes are where tags live, not the syscall aggregate).
function tableBadgeFor(row: TableRow): string {
  if (!row.topNative) return ''
  const id = nativeNodeId(row.topNative)
  return id ? badgeText(tagsByTarget(tags, id)) : ''
}

async function refreshTable(): Promise<void> {
  const filter = currentFilter()
  const [rows, total] = await Promise.all([
    window.anubee.table(filter, { limit: TABLE_PAGE, offset: tableOffset }, activeRunId),
    window.anubee.count(filter, activeRunId),
  ])
  currentLayout = parseLayout(activeEngine, savedColumns(activeEngine))
  const elapsedMax = rows.reduce((m, r) => Math.max(m, r.elapsed ?? 0), 0)
  renderTable(rows, currentLayout.columns, selectRow, tableBadgeFor, elapsedMax)
  const scroll = document.querySelector<HTMLElement>('#table .table-scroll')
  if (scroll) { applyWidths(scroll, currentLayout.widths); wireColGrips(scroll) }
  if (selectedRowId !== undefined) highlightTableRow(selectedRowId) // survive paging/filter/column re-render
  renderPager(tableOffset, rows.length, total)
}

// Wire drag-resize + double-click-to-autofit on each column's grip. Window-level
// pointermove/up listeners (like panels.ts) so the drag survives leaving the
// grip's small hit area. The last grip is the flex remainder column - not resizable.
function wireColGrips(scroll: HTMLElement): void {
  const grips = [...scroll.querySelectorAll<HTMLElement>('.col-grip')]
  grips.slice(0, -1).forEach(grip => {          // last column is the flex remainder - not resizable
    const key = grip.dataset.col!
    const th = grip.parentElement as HTMLElement
    grip.onpointerdown = (e) => {
      e.preventDefault()
      const startW = th.getBoundingClientRect().width
      const startX = e.clientX
      let moved = false
      const move = (ev: PointerEvent) => {
        moved = true
        const w = nextWidth(startW, ev.clientX - startX)
        for (const el of scroll.querySelectorAll<HTMLElement>(`.col-${key}`)) (el as HTMLElement).style.width = `${w}px`
      }
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        if (!moved) return               // stray click, no drag - don't pin the width
        currentLayout.widths[key] = nextWidth(startW, ev.clientX - startX)
        localStorage.setItem(columnsKey(activeEngine), serializeLayout(currentLayout))
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }
    grip.ondblclick = () => {                    // auto-fit: drop explicit width, let it re-flow
      delete currentLayout.widths[key]
      localStorage.setItem(columnsKey(activeEngine), serializeLayout(currentLayout))
      void refreshTable()
    }
  })
}

// Populate the suggestions list into a given host. A suggestion drops off the
// list once it is confirmed (already a tag of that category) or rejected
// (dismissed) - both persisted, so it never returns.
async function renderSuggestionsInto(host: HTMLElement): Promise<void> {
  if (activeRunId === undefined) return
  const all = await window.anubee.suggest(activeRunId)
  const open = all.filter(s =>
    !isDismissed(dismissed, s.target, s.category) &&
    !tags.some(t => t.target === s.target && t.category === s.category && t.offset === undefined))
  renderSuggestions(host, open,
    async tag => {
      tags = upsertTag(tags, tag)
      await persistTags()
      void refreshTable()
      redrawBadges()
      void recolorRasp()
    },
    async (s, offset) => {
      dismissed = addDismissed(dismissed, s.target, s.category, offset)
      await window.anubee.dismissedSave(activeRunId!, dismissed)
      dirty = true
      void recolorRasp()
    })
  void recolorRasp()
}

// Re-render the Suggestions modal body if it is currently open; a no-op
// otherwise (the modal fetches fresh via renderSuggestionsInto on open).
function refreshSuggestions(): void {
  if (!isModalOpen()) return
  const title = document.querySelector('.modal-head .modal-title')?.textContent
  if (title !== 'Suggestions') return
  const body = document.querySelector('.modal-body') as HTMLElement | null
  if (!body) return
  void renderSuggestionsInto(body)
}

// Open the Suggestions modal from the rail button; render fresh.
document.getElementById('suggest-btn')?.addEventListener('click', () => {
  showModal({
    title: 'Suggestions',
    width: 560,
    render: host => { void renderSuggestionsInto(host) },
  })
})

async function refreshOrphans(): Promise<void> {
  const host = document.getElementById('orphans')
  if (!host || activeRunId === undefined) return
  const targets = [...new Set(tags.map(t => t.target))]
  const orphanSet = new Set(targets.length ? await window.anubee.orphans(activeRunId, targets) : [])
  // Orphan warnings live in the (now selection-gated) side panel; reveal it when
  // there are any, so they aren't silently hidden until a row/node is clicked.
  if (orphanedTags(tags, orphanSet).length) showSide(true)
  const drop = async (target: string, off: string | undefined, cat: RaspCategory) => {
    tags = removeTag(tags, target, off, cat)
    await persistTags()
    void refreshTable()
    redrawBadges()
    void recolorRasp()
    void refreshOrphans()
  }
  renderOrphans(host, orphanedTags(tags, orphanSet), drop, async () => {
    for (const o of orphanedTags(tags, orphanSet)) tags = removeTag(tags, o.target, o.offset, o.category)
    await persistTags()
    void refreshTable()
    redrawBadges()
    void recolorRasp()
    void refreshOrphans()
  })
}

async function refreshFlame(): Promise<void> {
  const host = document.getElementById('flame')
  if (!host || activeRunId === undefined) return
  const rollup = await window.anubee.stackRollup(currentFilter(), FLAME_CHAIN_CAP, activeRunId)
  const tree = buildFlame(rollup.rows, FLAME_NODE_CAP)
  renderFlame(host, tree, rollup.truncated || tree.truncated, theme)
}

function showView(view: 'graph' | 'flame' | 'libs'): void {
  currentView = view
  document.getElementById('cy')?.classList.toggle('hidden', view !== 'graph')
  document.getElementById('flame')?.classList.toggle('active', view === 'flame')
  document.getElementById('flame')?.classList.toggle('hidden', view !== 'flame')
  document.getElementById('libs')?.classList.toggle('hidden', view !== 'libs')
  document.getElementById('cmdbar')?.classList.toggle('hidden', view === 'libs')
  document.getElementById('main')?.classList.toggle('no-cmdbar', view === 'libs')
  showTablePanel(view !== 'libs' && activeRunId !== undefined)
  // "Pick a row" prompt only makes sense with a run loaded and no row picked;
  // without a run the "No run loaded" empty-state owns the canvas (else both paint).
  document.getElementById('graph-empty')?.classList.toggle('hidden', view !== 'graph' || selectedRowId !== undefined || activeRunId === undefined)
  // "No run loaded" must not paint over the Libraries view - it needs no loaded
  // run (Live device capture works without one) and the overlay swallows clicks.
  document.getElementById('empty-state')?.classList.toggle('hidden', view === 'libs' || activeRunId !== undefined)
  if (view === 'flame') void refreshFlame()
  if (view === 'libs') libView.refresh()
  for (const [id, v] of [['tab-graph', 'graph'], ['tab-flame', 'flame'], ['tab-libs', 'libs']] as const) {
    document.getElementById(id)?.classList.toggle('on', currentView === v)
  }
}

// Refresh whichever middle view is active (used by the filter apply action).
function refreshMiddle(): void {
  if (currentView === 'flame') void refreshFlame()
  // graph view refreshes on row selection, not on filter apply
}

// Draws a fetched GraphSlice into the cytoscape canvas. Called by selectRow
// with a table row's filtered slice (funcs and syscall runs both list rows).
async function renderSlice(slice: GraphSlice): Promise<void> {
  const els = sliceToElements(slice)
  cy.elements().remove()
  cy.add(els.nodes)
  cy.add(els.edges)
  await runElkLayout(cy)
  cy.fit(undefined, 48) // frame the slice with padding; consistent zoom per selection
  document.getElementById('graph-empty')?.classList.add('hidden')
  // gate on truncation||coverage: an empty message (no truncation, no coverage
  // text yet) hides the chip regardless of the `show` flag - see showBanner.
  showBanner(slice.truncated || !!coverageChip, slice.truncated
    ? `graph truncated · ${coverageChip}` : coverageChip)
  redrawBadges()
  void recolorRasp()
}

async function selectRow(row: TableRow): Promise<void> {
  const e = selEpoch.bump()
  selectedRowId = row.id
  highlightTableRow(row.id)
  showSide(true)
  graph.begin() // top-bar sweep + overlay spinner; the newest selection owns them
  const host = document.getElementById('inspector')
  try {
    const ev = await window.anubee.eventById(row.id, activeRunId)
    if (!selEpoch.isCurrent(e)) return // a newer selection superseded this row; it owns the loader now
    if (host && ev) {
      if (activeEngine === 'func') showFuncsRecordDetail(host, ev as FuncEvent)
      else showRecordDetail(host, ev as SyscallEvent)
    }

    showView('graph')
    graphFilter = filterForRow(row, currentFilter())
    const slice = await window.anubee.slice(graphFilter, GRAPH_SLICE_CAP, activeRunId)
    if (!selEpoch.isCurrent(e)) return // stale slice; newer selection owns the loader
    await renderSlice(slice)
    graph.end() // this selection's graph is drawn; clear its loader
    const recordSets = await window.anubee.recordChain(row.id, activeRunId)
    if (!selEpoch.isCurrent(e)) return // stale: user left the row during the round-trip
    applyHighlight(cy, recordSets) // light this record's own path; rest of the bridge dims
  } catch (err) {
    // A graph-slice fetch rejected: clear this selection's loader (only if it
    // still owns it) and toast, leaving the prior graph in place. A stale
    // rejection whose selection was superseded must not clear a newer loader.
    if (selEpoch.isCurrent(e)) {
      graph.end()
      errorToast('Graph load failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }
}

// Exposed for the screenshot harness / debugging to drive the graph deterministically.
;(window as unknown as { __cy: typeof cy }).__cy = cy

// The selected node's on-screen box in viewport coordinates, so the offset
// popup can be placed to its right (renderedBoundingBox is canvas-relative;
// add the container's viewport offset).
function nodeBox(node: cytoscape.NodeSingular): NodeBox {
  const bb = node.renderedBoundingBox()
  const rect = cy.container()!.getBoundingClientRect()
  return { left: rect.left + bb.x1, top: rect.top + bb.y1, right: rect.left + bb.x2, bottom: rect.top + bb.y2 }
}

// Fetch and render one page of the open node's records plus the true total, then
// paint the inspector - the right-panel analogue of refreshTable(). `epoch` is the
// selEpoch token captured by the caller (the node tap, or an arrow click that
// bumped it), so a slow page never overwrites a newer selection.
async function refreshNodeInspector(epoch: number): Promise<void> {
  const ctx = currentNode
  if (!ctx) return
  const [records, total] = await Promise.all([
    window.anubee.nodeEvents(ctx.id, ctx.filter, { limit: NODE_PAGE, offset: nodeOffset }, activeRunId),
    window.anubee.nodeEventCount(ctx.id, ctx.filter, activeRunId),
  ])
  if (!selEpoch.isCurrent(epoch)) return // stale: newer selection or page superseded this fetch
  const page: InspectorPage = {
    offset: nodeOffset,
    total,
    onPrev: () => { nodeOffset = Math.max(0, nodeOffset - NODE_PAGE); void refreshNodeInspector(selEpoch.bump()) },
    onNext: () => { nodeOffset += NODE_PAGE; void refreshNodeInspector(selEpoch.bump()) },
  }
  if (activeEngine === 'func') showFuncsNodeInspector(ctx.id, records as FuncEvent[], page, { kind: ctx.kind, cats: ctx.cats })
  else showNodeInspector(ctx.id, records as SyscallEvent[], page, { kind: ctx.kind, cats: ctx.cats })
}

cy.on('tap', 'node', evt => {
  const e = selEpoch.bump()
  const node = evt.target
  const nodeId = node.id()
  void window.anubee.highlightSets(nodeId, graphFilter, activeRunId).then(sets => {
    if (!selEpoch.isCurrent(e)) return // stale: another node selected / deselected mid-round-trip
    applyHighlight(cy, sets)
  })
  showSide(true)
  const nodeKind = node.data('kind') as string | undefined
  const nodeCats = [...new Set(tagsByTarget(tags, nodeId).map(t => t.category))]
  currentNode = { id: nodeId, kind: nodeKind, cats: nodeCats, filter: graphFilter }
  nodeOffset = 0 // a fresh node opens on page 1
  // Native syscall nodes (syscall engine only) also get the read-only offset
  // histogram popup; every other node just clears any stale popup.
  if (activeEngine !== 'func' && nodeKind === 'native') {
    const box = nodeBox(node)
    void window.anubee.nodeOffsets(nodeId, graphFilter, activeRunId).then(rows => {
      if (!selEpoch.isCurrent(e)) return // node deselected / another selected during the round-trip
      showOffsetPopup({ nodeId, rows, anchor: box })
    })
  } else {
    closeOffsetPopup()
  }
  void refreshNodeInspector(e)
})

// Right-click any node -> Copy the identifier, or Add Tag (opens the tag popup).
cy.on('cxttap', 'node', evt => {
  const nodeId = evt.target.id()
  const anchor = { x: evt.originalEvent.clientX, y: evt.originalEvent.clientY }
  showNodeMenu({
    nodeId,
    anchor,
    onCopy: text => void window.anubee.copyToClipboard(text),
    onAddTag: () => showTagPopup({
      nodeId,
      anchor,
      tagHost: h => renderTagEditor(h, nodeId, undefined, tagsByTarget(tags, nodeId),
        async tag => { tags = upsertTag(tags, tag); await persistTags(); void refreshTable(); redrawBadges(); void recolorRasp() },
        async (t, off, cat) => { tags = removeTag(tags, t, off, cat); await persistTags(); void refreshTable(); redrawBadges(); void recolorRasp() }),
    }),
  })
})

cy.on('tap', evt => { if (evt.target === cy) { selEpoch.bump(); clearHighlight(cy); closeOffsetPopup(); closeNodeMenu(); closeTagPopup() } })

function applyGraphTheme(next: Theme): void {
  const c = themeColors(next)
  cy.style()
    .selector('node').style({ color: c.labelText, 'background-color': c.labelBacking, 'border-color': c.native })
    .selector('node[kind = "java"]').style({ 'border-color': c.java })
    .selector('node[kind = "native"]').style({ 'border-color': c.native })
    .selector('node[kind = "syscall"]').style({ 'border-color': c.syscall })
    .selector('node[kind = "func"]').style({ 'border-color': c.func })
    .selector('edge').style({ 'line-color': c.edge, 'target-arrow-color': c.edge })
    .selector('edge.highlighted').style({ 'line-color': c.labelText, 'target-arrow-color': c.labelText, 'width': 3.5, 'arrow-scale': 1.3 })
    .update()
}

// Update theme pill + collapsed mini glyph to reflect current theme
// (dark -> moon, light -> sun on both the knob and the collapsed mini icon).
function updateThemePill(): void {
  const pill = document.querySelector('.theme-pill')
  const knob = document.querySelector('.theme-knob svg use')
  const mini = document.querySelector('.theme-mini use')
  if (pill && knob) {
    if (theme === 'dark') {
      pill.classList.remove('light')
      pill.classList.add('dark')
      knob.setAttribute('href', '#i-moon')
      mini?.setAttribute('href', '#i-moon')
    } else {
      pill.classList.remove('dark')
      pill.classList.add('light')
      knob.setAttribute('href', '#i-sun')
      mini?.setAttribute('href', '#i-sun')
    }
  }
}
updateThemePill() // init from the restored theme

document.getElementById('theme-toggle')?.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('anubee.theme', serializeTheme(theme))
  updateThemePill()
  applyGraphTheme(theme)
  styleRaspCategories(theme)
  if (currentView === 'flame') void refreshFlame()
})

wirePanels(document.body)

const libView: LibViewApi = createLibView(document.getElementById('libs')!, {
  loadedRows: () => window.anubee.libTable(activeRunId),
  startLive: (pkg, glob) => window.anubee.startLive(pkg, glob),
  stopLive: () => window.anubee.stopLive(),
  dumpLib: (pid, base) => window.anubee.dumpLib(pid, base),
  reveal: path => window.anubee.revealArtifact(path),
  exportArtifact: path => void window.anubee.exportArtifact(path),
  preflight: pkg => window.anubee.tracerPreflight(pkg),
  verify: (pid, bases) => window.anubee.verify(pid, bases),
})
window.anubee.onLibMapped(l => libView.applyMapped(l))
window.anubee.onLibUnmapped(l => libView.applyUnmapped(l))
window.anubee.onLibStreamEnd(() => libView.streamEnded())
window.anubee.onLibLine(l => libView.appendLog(l))
window.anubee.onWatchLine(l => libView.appendLog(l))
window.anubee.onWatchArtifacts(a => libView.addArtifacts(a))
window.anubee.onPreflightCheck(c => libView.applyPreflightCheck(c))
window.anubee.onCheckResults((results, atMs) => libView.applyCheck(results, atMs))

async function refreshDiff(): Promise<void> {
  const host = document.getElementById('diff-table')
  if (!host || activeRunId === undefined || runB === undefined) return
  const rows = await window.anubee.diffTable(activeRunId, runB, currentFilter(), 1000)
  const taggedIds = new Set(tags.map(t => t.target))
  const shown = filterDiffRows(rows, diffMode, taggedIds)
  // The diff table renders into the selection-gated side panel; reveal it so a
  // Load-run-B comparison is visible without first clicking a row/node.
  if (shown.length) showSide(true)
  renderDiffTable(host, shown,
    id => badgeText(tagsByTarget(tags, id)),
    async id => {
      const e = selEpoch.bump()
      graphFilter = currentFilter() // the filter this diff slice is drawn with; keep node-tap highlight/details scoped to it
      const merged = await window.anubee.diffSlice(activeRunId!, runB!, id, graphFilter)
      if (!selEpoch.isCurrent(e)) return // superseded by a newer selection; don't repaint the graph
      const els = mergedToElements(merged)
      cy.elements().remove()
      cy.add(els.nodes)
      cy.add(els.edges)
      await runElkLayout(cy)
      cy.fit(undefined, 48)
    })
}

// Builds the post-load Mode filter row (idempotent). Mode is meaningless before a
// run B exists (refreshDiff no-ops without it), so it is only added once B loads.
function addDiffModeField(host: HTMLElement): void {
  if (host.querySelector('#diff-mode')) return
  const field = document.createElement('div'); field.className = 'modal-field'
  const label = document.createElement('label'); label.textContent = 'Mode'
  const sel = document.createElement('select'); sel.id = 'diff-mode'
  for (const [value, text] of [['all', 'all'], ['only-in-A', 'only in A'], ['only-in-B', 'only in B'], ['tagged', 'tagged']] as const) {
    const opt = document.createElement('option'); opt.value = value; opt.textContent = text
    if (value === diffMode) opt.selected = true
    sel.appendChild(opt)
  }
  sel.addEventListener('change', e => {
    diffMode = (e.target as HTMLSelectElement).value as DiffMode
    void refreshDiff()
  })
  field.append(label, sel)
  host.appendChild(field)
}

function wireLoadRunB(host: HTMLElement): void {
  document.getElementById('load-run-b')?.addEventListener('click', async () => {
    // Compare-load: ingests run B without the trace:loaded broadcast, so it never
    // steals activeRunId or repaints the primary panels with B's data.
    const summary = await runLogged('compare', () => window.anubee.openFileForCompare(),
      s => (s ? { level: s.errors > 0 ? 'warn' : 'success', message: `Compare loaded ${s.eventCount} events (${s.errors} parse errors)` } : null))
    if (summary) {
      runB = summary.runId
      addDiffModeField(host) // reveal the Mode filter now that a comparison exists
      await refreshTags()
      void refreshDiff()
    }
  })
}

function wireCapture(): (() => void) | undefined {
  const engineHost = document.getElementById('cap-engine')
  const formHost = document.getElementById('cap-form')
  const argvHost = document.getElementById('cap-argv')
  const pfHost = document.getElementById('cap-preflight-pane')
  const consoleHost = document.getElementById('cap-console')
  const footHost = document.getElementById('cap-foot')
  const specsHost = document.getElementById('cap-specs-host')
  const shell = document.getElementById('capture')
  const binIn = document.getElementById('cfg-binary') as HTMLInputElement | null
  const saveIn = document.getElementById('cap-savepath') as HTMLInputElement | null
  const runArgvHost = document.querySelector<HTMLElement>('#capture-run [data-role="argvRunning"]')
  if (!engineHost || !formHost || !argvHost || !pfHost || !consoleHost || !footHost
      || !specsHost || !shell || !binIn || !runArgvHost) return

  let capId = CAPABILITIES[0].id
  let vals: CapValues = {}
  let specsDir = ''
  let specNames: string[] = []
  let preflight: PreflightState = 'none'
  let running = false
  // True once main reports the run has moved from 'device' to 'finishing'
  // (device process exited, pull+ingest in flight - see run-lifecycle.ts).
  // There is nothing left for Stop to signal at that point; captureFooter
  // drops to a non-interactive busy note instead of offering it.
  let finishing = false
  let stopping = false // Stop clicked, device not yet reported as exited
  let failReason = ''
  let counters = ''
  let lineCount = 0 // tracked independently of consoleHost's (capped) DOM node count
  const preflightEpoch = makeEpoch() // a superseded preflight must not re-enable Start

  const cap = (): Capability => capById(capId)!
  const configValid = (): boolean => validateInputs(cap(), vals).length === 0

  // ---- footer ------------------------------------------------------------
  const paintFooter = (): void => {
    renderCaptureFooter(footHost,
      captureFooter({ configValid: configValid(), preflight, running, finishing, stopping, failReason, counters }),
      onFooterClick)
  }

  // ---- argv preview ------------------------------------------------------
  // The real -o path is timestamped at dispatch, so preview a placeholder
  // rather than inventing a timestamp that will not match the run.
  const paintArgv = (): void => {
    const argv = composeRunArg({ cap: cap(), vals, jsonlPath: '<out>.jsonl' })
    renderArgvPreview(argvHost, argv)
    if (running) renderArgvPreview(runArgvHost, argv)
  }

  // ---- preflight invalidation -------------------------------------------
  // preflight validates the package AND pushes the binary/specs, so any config
  // edit genuinely invalidates it.
  const invalidatePreflight = (reason: string): void => {
    preflightEpoch.bump()
    if (preflight === 'passed' || preflight === 'failed') {
      preflight = 'stale'
      markPreflightStale(pfHost, reason)
    } else if (preflight === 'running') {
      preflight = 'none'
      resetPreflightPane(pfHost)
    }
    failReason = ''
    paintFooter()
  }

  const onFormChange = (v: CapValues): void => {
    vals = v
    invalidatePreflight('arguments changed since the last preflight')
    const { fields, form } = fieldErrors(cap(), vals)
    applyFieldErrors(formHost, fields)
    const formErr = document.getElementById('cap-form-err')
    if (formErr) formErr.textContent = form.join('; ')
    paintArgv()
    paintFooter()
  }

  // ---- host paths --------------------------------------------------------
  const binDot = document.getElementById('cfg-binary-dot')
  const binErr = document.getElementById('cfg-binary-err')
  const refreshBinary = async (): Promise<void> => {
    const r = await window.anubee.tracerCheckPaths(binIn.value, specsDir)
    if (binDot) renderDot(binDot, r.binary)
    if (binErr) binErr.textContent = r.binary.ok ? '' : `Required - ${r.binary.detail}`
  }
  document.getElementById('cfg-binary-browse')?.addEventListener('click', async () => {
    const p = await window.anubee.tracerPickBinary()
    if (p) { binIn.value = p; saveCfg(); void refreshBinary(); invalidatePreflight('binary changed since the last preflight') }
  })
  binIn.addEventListener('input', () => { void refreshBinary(); invalidatePreflight('binary changed since the last preflight') })
  document.getElementById('cap-browse')?.addEventListener('click', async () => {
    const p = await window.anubee.pickSavePath()
    if (p && saveIn) saveIn.value = p
  })

  const refreshSpecsDot = async (): Promise<void> => {
    const dot = specsHost.querySelector<HTMLElement>('[data-role="specsDot"]')
    const err = specsHost.querySelector<HTMLElement>('[data-err="specsDir"]')
    if (!dot && !err) return
    const r = await window.anubee.tracerCheckPaths(binIn.value, specsDir)
    if (dot) renderDot(dot, r.specs)
    if (err) err.textContent = r.specs.ok ? '' : `Required - ${r.specs.detail}`
  }

  const refreshSpecList = async (): Promise<void> => {
    specNames = await window.anubee.tracerListSpecs(specsDir)
    if (typeof vals.spec === 'string' && vals.spec && !specNames.includes(vals.spec)) {
      vals = { ...vals, spec: '' }
    }
    applySpecChoices(formHost, specNames, String(vals.spec ?? ''))
    onFormChange(vals)
  }

  // The specs dir is a host path, so it lives in host setup - rendered only
  // for the engine that takes a probe spec.
  const drawSpecsRow = (): void => {
    specsHost.innerHTML = ''
    if (!capNeedsSpec(cap())) return
    const row = specsDirRow(specsDir)
    specsHost.appendChild(row)
    const dir = row.querySelector<HTMLInputElement>('[data-config="specsDir"]')!
    const onDirChange = async (): Promise<void> => {
      specsDir = dir.value
      saveCfg()
      await refreshSpecsDot()
      await refreshSpecList()
      invalidatePreflight('specs dir changed since the last preflight')
    }
    row.querySelector('[data-role="specsBrowse"]')?.addEventListener('click', async () => {
      const p = await window.anubee.tracerPickSpecsDir()
      if (p) { dir.value = p; await onDirChange() }
    })
    dir.addEventListener('input', () => void onDirChange())
    void refreshSpecsDot()
  }

  // ---- form --------------------------------------------------------------
  const drawAll = (): void => {
    renderEngineSegments(engineHost, CAPABILITIES, capId, id => {
      capId = id
      vals = {}
      drawAll()
      invalidatePreflight('engine changed since the last preflight')
      if (capNeedsSpec(cap())) void refreshSpecList()
    })
    renderCapabilityForm(formHost, cap(), vals, onFormChange, { specNames, specsDir })
    drawSpecsRow()
    paintArgv()
    paintFooter()
  }

  let configLoaded = false
  const saveCfg = (): void => {
    if (!configLoaded) return
    void window.anubee.setTracerConfig({ anubeeBinary: binIn.value, specsDir })
  }
  binIn.addEventListener('change', saveCfg)

  resetPreflightPane(pfHost)
  drawAll()

  void window.anubee.getTracerConfig().then(async cfg => {
    binIn.value = cfg.anubeeBinary
    specsDir = cfg.specsDir
    configLoaded = true
    void refreshBinary()
    drawSpecsRow()
    if (capNeedsSpec(cap())) { await refreshSpecList(); void refreshSpecsDot() }
  })

  // The pane heading is outside capture-preflight-view's DOM, so the count
  // lives here rather than in that module.
  const setPreflightCount = (text: string, allPassed = false): void => {
    const el = document.getElementById('cap-pf-count')
    if (!el) return
    el.textContent = text
    el.classList.toggle('all-passed', allPassed)
  }

  // ---- actions -----------------------------------------------------------
  async function runPreflight(): Promise<void> {
    const token = preflightEpoch.bump()
    saveCfg()
    const pkg = String(vals.pkg ?? '')
    preflight = 'running'; failReason = ''
    // pfHost/etc are non-null past the top-of-function guard; TS does not carry
    // that narrowing into a hoisted `function` declaration like this one.
    resetPreflightPane(pfHost!)
    setPreflightCount('')
    paintFooter()
    try {
      const checks = await window.anubee.tracerPreflight(pkg)
      if (!preflightEpoch.isCurrent(token)) return // superseded by an edit
      for (const c of checks) appendPreflightCheck(pfHost!, c)
      const sum = preflightSummary(checks)
      setPreflightCount(`${sum.passed} / ${sum.total} passed`, !sum.firstFail)
      logAppend(sum.firstFail ? 'warn' : 'success', 'preflight',
        `Preflight: ${sum.total} checks, ${sum.total - sum.passed} failing`)
      preflight = sum.firstFail ? 'failed' : 'passed'
      failReason = sum.firstFail ?? ''
    } catch (err) {
      if (!preflightEpoch.isCurrent(token)) return
      preflight = 'failed'
      failReason = err instanceof Error ? err.message : String(err)
    } finally {
      paintFooter()
    }
  }

  function timeoutSecs(): number | undefined {
    const t = parseInt((document.getElementById('cap-timeout') as HTMLInputElement).value, 10)
    return Number.isFinite(t) && t > 0 ? t : undefined
  }

  async function startCapture(): Promise<void> {
    const errs = validateInputs(cap(), vals)
    if (errs.length) { failReason = errs.join('; '); preflight = 'failed'; paintFooter(); return }
    running = true; finishing = false; stopping = false; counters = ''; lineCount = 0
    shell!.classList.remove('state-config'); shell!.classList.add('state-running')
    setLiveBadge(true)
    consoleHost!.innerHTML = ''
    pendingLines = [] // a previous run's unflushed tail must not bleed into this one
    // Replay the preflight result dimmed so the log reads as one story.
    const rows = [...pfHost!.querySelectorAll('.pf-label')].map(e => e.textContent)
    if (rows.length) {
      appendConsoleLine(consoleHost!, `[preflight] ${rows.join(' · ')} - ${rows.length}/${rows.length} passed`)
      consoleHost!.lastElementChild?.classList.add('preflight-replay')
    }
    paintArgv(); paintFooter()
    try {
      // Completion (success or failure) is reported via the tracer:done
      // broadcast, handled by captureDoneSink below - not by this call
      // resolving. This is deliberate: by the time a real trace finishes, the
      // modal instance that started it may have been closed and replaced by a
      // reattached one, and only the broadcast reaches whichever is live.
      await runLogged('capture',
        () => window.anubee.tracerStart(capId, vals, timeoutSecs(), saveIn?.value || undefined),
        res => ({ level: res.error || res.code !== 0 ? 'error' : 'success',
                  message: res.error ? `Capture ${capId} failed: ${res.error}`
                                      : `Capture ${capId} finished (${res.kind}, code ${res.code})` }))
    } catch (err) {
      // Once a run actually starts, tracer:start always resolves (the result,
      // success or failure, travels via tracer:done instead). The only
      // rejection reachable here is the clobber guard, thrown synchronously
      // before any run starts - so there is no tracer:done coming for it, and
      // this instance must revert its own running state itself.
      appendConsoleLine(consoleHost!, `--- error: ${err instanceof Error ? err.message : String(err)} ---`)
      running = false
      setLiveBadge(false)
      shell!.classList.remove('state-running'); shell!.classList.add('state-config')
      paintFooter()
    }
  }

  // The running badge lives beside the shared modal's title, matching the
  // approved mockup. modal.ts is not modified for this.
  function setLiveBadge(on: boolean): void {
    const title = document.querySelector('.modal-head .modal-title')
    if (!title) return
    title.querySelector('.cap-live-badge')?.remove()
    if (!on) return
    const b = document.createElement('span')
    b.className = 'cap-live-badge'; b.textContent = '● running'
    title.appendChild(b)
  }

  function onFooterClick(id: string): void {
    if (id === 'cap-cancel') { closeModal(); return }
    if (id === 'cap-preflight' || id === 'cap-rerun') { void runPreflight(); return }
    if (id === 'cap-start') { void startCapture(); return }
    // Repaint before awaiting the IPC: signalling the device and waiting for
    // anubee to drain takes seconds, and without an immediate acknowledgement
    // the footer looked frozen and invited a second click.
    if (id === 'cap-stop-open') {
      logAppend('info', 'capture', 'Stop requested')
      stopping = true; paintFooter()
      void window.anubee.tracerStop(false); return
    }
    if (id === 'cap-stop-discard') {
      logAppend('info', 'capture', 'Stop requested (discard)')
      stopping = true; paintFooter()
      void window.anubee.tracerStop(true)
    }
  }

  // ---- live console ------------------------------------------------------
  // An unfiltered syscalls capture emits well over ten thousand lines a second.
  // Touching the DOM once per line - especially reading scrollHeight to follow
  // the tail, which forces a synchronous layout - saturates the main thread, so
  // queued click events never run and the Stop buttons look dead. Buffer here
  // and flush once per animation frame instead: the DOM work per second drops
  // to at most one batch per frame, and the browser gets to service input in
  // between.
  let pendingLines: string[] = []
  let flushHandle: number | undefined

  const flushLines = (): void => {
    flushHandle = undefined
    if (pendingLines.length === 0) return
    const batch = pendingLines
    pendingLines = []
    appendConsoleLines(consoleHost, batch)
    lineCount += batch.length
    counters = `${lineCount} lines`
    // Only the counters text changes, so patch that node directly rather than
    // running paintFooter()'s full teardown and rebuild - see setFooterCounters.
    setFooterCounters(footHost, counters)
  }

  captureLineSink = (lines: readonly string[]): void => {
    for (const line of lines) pendingLines.push(line)
    // requestAnimationFrame stops firing while the window is minimised or
    // occluded, so without a bound the buffer would grow for the whole run.
    // Trimming to the console cap is lossless: appendConsoleLines evicts down
    // to the same cap, so the dropped lines could never have been painted.
    //
    // Only trim once the buffer has grown to twice the cap, not on every
    // arrival. Slicing a 5000-element array per line is O(n) work per line,
    // which made the very stall this batching exists to remove measurably
    // worse. At 2x the slice happens once per CONSOLE_LINE_CAP lines, so the
    // amortised cost is constant and memory stays bounded at 2x the cap.
    if (pendingLines.length > CONSOLE_LINE_CAP * 2) {
      pendingLines = pendingLines.slice(-CONSOLE_LINE_CAP)
    }
    if (flushHandle === undefined) flushHandle = requestAnimationFrame(flushLines)
  }

  // Flush synchronously when a run ends so the tail is on screen before the
  // completion line, and drop any frame still queued against a torn-down modal.
  captureFlush = (): void => {
    if (flushHandle !== undefined) { cancelAnimationFrame(flushHandle); flushHandle = undefined }
    flushLines()
  }

  // ---- run completion (broadcast) -----------------------------------------
  // Fires via tracer:done, dispatched through captureDoneSink to whichever
  // Capture instance is live at that moment - not necessarily the instance
  // whose startCapture() called tracer:start (that instance may have been
  // closed and replaced by a reattached one while the run/pull/ingest were
  // still in flight). On a successful jsonl capture, though, no instance is
  // live by the time this fires: ingestPath's own trace:loaded/trace:estimate
  // broadcasts close the Capture modal (see window.anubee.onLoaded /
  // onEstimate below) before tracer:done arrives, tearing this sink down with
  // it (cleanupCapture). So this finalizes the console line/badge/footer only
  // for the paths where a Capture instance is still open to show them
  // (discard, error, or a pull/ingest that produced no runId) - the graph
  // switch on success is handled unconditionally, outside this sink, by the
  // module-scope onTracerDone handler below, so it runs the same regardless
  // of whether a Capture instance happens to still be open.
  captureDoneSink = (result: { code: number; kind: string; runId?: number; error?: string }): void => {
    // Land any buffered tail before the completion line, so the log reads in
    // order rather than showing "done" above the last few hundred lines.
    captureFlush?.()
    appendConsoleLine(consoleHost,
      result.error ? `--- error: ${result.error} ---` : `--- done (exit ${result.code}, kind ${result.kind}) ---`)
    running = false
    finishing = false
    stopping = false
    setLiveBadge(false)
    shell.classList.remove('state-running'); shell.classList.add('state-config')
    // The run consumed the pushed binary and the launched package; keep the
    // preflight pass so a repeat run does not need another adb round-trip.
    paintFooter()
  }

  // ---- run phase (broadcast) -----------------------------------------------
  // Fired once, when main moves the run from 'device' to 'finishing' (process
  // exited, pull+ingest in flight - see run-lifecycle.ts). Dispatched through
  // captureFinishingSink, mirroring captureDoneSink/captureLineSink, so it
  // reaches whichever Capture instance is live.
  captureFinishingSink = (): void => {
    finishing = true
    paintFooter()
  }

  // A run may still be active from before this modal instance existed - e.g.
  // Escape closed the modal mid-run (modal.ts closes unconditionally; the
  // footer's deliberate lack of Cancel while running does not gate that) and
  // the analyst reopened Capture. Restore the running chrome instead of
  // showing a fresh config form over a live process; the console cannot show
  // lines emitted while closed, so say so rather than looking complete.
  // `closed` guards against this instance being torn down again before the
  // IPC round-trip resolves - without it, setLiveBadge's un-scoped
  // document.querySelector('.modal-head .modal-title') would paint into
  // whatever modal happens to be open by then, not this (by-then-gone) one.
  let closed = false
  void window.anubee.tracerIsRunning().then(({ running: isRunning, argv, phase }) => {
    if (!isRunning || closed) return
    running = true
    finishing = phase === 'finishing'
    shell.classList.remove('state-config'); shell.classList.add('state-running')
    setLiveBadge(true)
    consoleHost.innerHTML = ''
    lineCount = 0
    pendingLines = []
    appendConsoleLine(consoleHost, '[reattached] capture is still running - earlier output is not shown')
    consoleHost.lastElementChild?.classList.add('preflight-replay')
    // This instance never called startCapture(), so capId/vals are still
    // whatever the form defaulted to - paintArgv() would compose a fabricated
    // command from them. Show the real running command from main, or nothing
    // if main did not have one to give.
    if (argv) renderArgvPreview(runArgvHost, argv)
    else runArgvHost.innerHTML = ''
    paintFooter()
  })

  // Closing the modal mid-run must not leave this instance's captureLineSink/
  // captureDoneSink/captureFinishingSink writing into detached nodes, nor let
  // a superseded runPreflight or tracerIsRunning continuation resolve into
  // them - the run itself is untouched and is recovered on reopen by the
  // tracerIsRunning check above.
  return function cleanupCapture(): void {
    closed = true
    // Drop a frame still queued against this instance's now-detached console.
    if (flushHandle !== undefined) { cancelAnimationFrame(flushHandle); flushHandle = undefined }
    pendingLines = []
    captureLineSink = undefined
    captureDoneSink = undefined
    captureFinishingSink = undefined
    captureFlush = undefined
    preflightEpoch.bump()
  }
}

function openCaptureModal(): void {
  // wireCapture returns a per-open cleanup (same pattern as the Activity log
  // modal below): onClose fires on Escape/backdrop/X regardless of capture
  // state, so the sink/epoch cleanup must run then, not only on Cancel.
  let cleanup: (() => void) | undefined
  showModal({
    title: 'Capture',
    width: 860,
    render: host => {
      const tpl = document.getElementById('capture-template') as HTMLTemplateElement | null
      if (tpl) host.appendChild(tpl.content.cloneNode(true))
      cleanup = wireCapture() // binds the cap-* controls now present in the modal
    },
    onClose: () => cleanup?.(),
  })
}

function wireExport(): void {
  const md = document.getElementById('export-md')
  const json = document.getElementById('export-json')
  md?.addEventListener('click', () => {
    if (activeRunId !== undefined) void runLogged('export', () => window.anubee.exportFindings(activeRunId!, 'md'),
      p => (p ? { level: 'success', message: `Exported ${p}` } : null))
  })
  json?.addEventListener('click', () => {
    if (activeRunId !== undefined) void runLogged('export', () => window.anubee.exportFindings(activeRunId!, 'json'),
      p => (p ? { level: 'success', message: `Exported ${p}` } : null))
  })
}

window.anubee.onEstimate(({ fileBytes, throughput }) => {
  // Start of a primary load: close the Open modal now (not only on trace:loaded)
  // so the dialog goes away the instant work starts, and raise the estimated bar.
  closeModal()
  document.getElementById('empty-state')?.classList.add('hidden')
  showTablePanel(true) // reveal the table panel now so the skeleton (inside it) is visible during load
  ingest.begin(fileBytes, throughput)
})
window.anubee.onLoaded(s => {
  closeModal() // any successful load closes the open (run / project / capture) modal that triggered it
  ingest.phase('Building view') // ingest SQL is done; the refresh tail runs under the same bar
  activeRunId = s.runId
  activeEngine = s.kinds.includes('funcs') && !s.kinds.includes('syscall') ? 'func' : 'syscall'
  tableOffset = 0 // a fresh run starts at page 1; a stale offset could land past its row count
  selectedRowId = undefined
  document.getElementById('empty-state')?.classList.add('hidden')
  showTablePanel(true)
  document.getElementById('graph-empty')?.classList.remove('hidden')
  showSide(false) // clear a prior run's open detail; refreshOrphans re-opens it if this run has orphans
  logAppend(s.errors > 0 ? 'warn' : 'success', 'load', `Loaded ${s.eventCount} events (${s.errors} parse errors)`)
  void refreshTags().then(() => {
    void refreshTable()
    refreshMiddle()
    redrawBadges()
    void refreshSuggestions()
    void refreshOrphans()
    libView.refresh() // Libraries tab may be parked on a stale run's rows; no-ops while live
    ingest.end() // fill the bar to 100% and clear; the data is now on screen
  })
  // Coverage health text (not graph data) - stored, not shown, until a row
  // is selected and renderSlice surfaces it via the chip. .catch() so a future
  // shape change degrades to an empty chip instead of an unhandled rejection.
  void window.anubee.coverage(s.runId).then(cov => { coverageChip = coverageChipText(cov) })
    .catch(() => { coverageChip = '' })
})
// Centralized ingest failure: covers all four broadcasting load paths (run-open,
// project-open, capture-ingest, preload auto-load). restoreEmpty only when no
// run is loaded, so a failed re-open does not blank an existing run's table.
window.anubee.onIngestFail(({ message, file }) => {
  ingest.fail(message, file, activeRunId === undefined)
  if (activeRunId === undefined) showTablePanel(false) // failed first load: revert the panel onEstimate opened
})
initLoadingUi()
document.getElementById('tab-graph')?.addEventListener('click', () => showView('graph'))
document.getElementById('tab-flame')?.addEventListener('click', () => showView('flame'))
document.getElementById('tab-libs')?.addEventListener('click', () => showView('libs'))
document.getElementById('rules-btn')?.addEventListener('click', () => {
  showModal({
    title: 'Rules',
    width: 640,
    render: host => { void renderRules(host, activeRunId, () => { dirty = true; logAppend('info', 'rules', 'Rules updated'); void recolorRasp(); void refreshSuggestions() }) },
  })
})
document.getElementById('pager-prev')?.addEventListener('click', () => {
  tableOffset = Math.max(0, tableOffset - TABLE_PAGE)
  void refreshTable()
})
document.getElementById('pager-next')?.addEventListener('click', () => {
  tableOffset += TABLE_PAGE
  void refreshTable()
})
wireFilterControls(() => { tableOffset = 0; void refreshTable(); refreshMiddle() })
setTagResolver(cat => resolveTagTargets(tags, cat))
wireExport()

function openColumnsModal(): void {
  showModal({ title: 'Columns', width: 300, render: host => buildColumnsBody(host) })
}

function buildColumnsBody(host: HTMLElement): void {
  host.innerHTML = ''
  const label = document.createElement('div'); label.className = 'cs-mode-label'; label.textContent = 'call site'
  const seg = document.createElement('div'); seg.className = 'seg cs-mode'
  for (const m of ['stacked', 'split'] as const) {
    const b = document.createElement('button')
    b.className = 'btn' + (currentLayout.callSite === m ? ' on' : '')
    b.textContent = m
    b.onclick = () => {
      currentLayout = { ...currentLayout, callSite: m, columns: engineDefaultColumns(activeEngine, m) }
      localStorage.setItem(columnsKey(activeEngine), serializeLayout(currentLayout))
      void refreshTable()
      buildColumnsBody(host)
    }
    seg.appendChild(b)
  }
  host.append(label, seg)

  const cat = columnCatalogue(activeEngine, currentLayout.callSite)
  const byKey = new Map(cat.map(d => [d.key, d]))
  for (const key of engineColumnKeys(activeEngine, currentLayout.callSite)) {
    const def = byKey.get(key); if (!def) continue
    const row = document.createElement('label')
    row.className = 'col-row' + (def.fixed ? ' fixed' : '')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = currentLayout.columns.includes(def.key)
    cb.disabled = !!def.fixed
    cb.addEventListener('change', () => {
      const set = new Set(currentLayout.columns)
      if (cb.checked) set.add(def.key); else set.delete(def.key)
      set.add('id')
      currentLayout.columns = engineColumnKeys(activeEngine, currentLayout.callSite).filter(k => set.has(k))
      localStorage.setItem(columnsKey(activeEngine), serializeLayout(currentLayout))
      void refreshTable()
    })
    const span = document.createElement('span'); span.textContent = def.label
    row.append(cb, span)
    if (def.fixed) {
      const lock = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      lock.setAttribute('viewBox', '0 0 24 24'); lock.setAttribute('class', 'lock-ic')
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
      use.setAttribute('href', '#i-lock'); lock.appendChild(use); row.append(lock)
    }
    host.appendChild(row)
  }
}
document.getElementById('cols-btn')?.addEventListener('click', openColumnsModal)

function zoomBy(factor: number): void {
  const c = cy.container()
  if (!c) return
  const b = c.getBoundingClientRect()
  cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: b.width / 2, y: b.height / 2 } })
}
document.getElementById('zoom-in')?.addEventListener('click', () => zoomBy(1.2))
document.getElementById('zoom-out')?.addEventListener('click', () => zoomBy(1 / 1.2))
document.getElementById('zoom-fit')?.addEventListener('click', () => cy.fit(undefined, 48))
document.getElementById('side-close')?.addEventListener('click', () => showSide(false))

// Ctrl/Cmd +/- zoom the graph (only in graph view), overriding the browser's
// page zoom. Accepts '=' (unshifted '+'), '+', numpad, and '-'.
window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || currentView !== 'graph') return
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') { e.preventDefault(); zoomBy(1.2) }
  else if (e.key === '-' || e.code === 'NumpadSubtract') { e.preventDefault(); zoomBy(1 / 1.2) }
})

// Builds one full-width icon+label row for the shared .modal-menu layout used by
// the Open / Export / Diff modals. Caller wires .onclick and appends it.
function modalMenuItem(id: string, iconId: string, label: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'modal-menu-item'; b.id = id
  b.innerHTML = `<svg class="ic" viewBox="0 0 24 24"><use href="#${iconId}"/></svg>`
  b.append(label)
  return b
}

document.getElementById('file-open')?.addEventListener('click', () => {
  showModal({ title: 'Open', width: 260, render: host => {
    const menu = document.createElement('div'); menu.className = 'modal-menu'
    const runBtn = modalMenuItem('open-run', 'i-file', 'Open run (JSONL)…')
    // Failure UI is centralized in main's trace:fail -> onIngestFail; runLogged
    // still logs then rethrows, so terminate the promise to avoid an unhandled
    // rejection without double-toasting.
    runBtn.onclick = () => void runLogged('open', () => window.anubee.openFile(), () => null).catch(() => {})
    const projBtn = modalMenuItem('open-project', 'i-package', 'Open project…')
    // Same as the run-open path: failure UI comes from main's trace:fail ->
    // onIngestFail, runLogged logs then rethrows, so terminate the promise.
    projBtn.onclick = () => void runLogged('open-project', () => window.anubee.openProject(), () => null).catch(() => {})
    menu.append(runBtn, projBtn)
    host.appendChild(menu)
  }})
})
document.getElementById('file-capture')?.addEventListener('click', () => openCaptureModal())
document.getElementById('export-btn')?.addEventListener('click', () => {
  showModal({ title: 'Export', width: 260, render: host => {
    const menu = document.createElement('div'); menu.className = 'modal-menu'
    menu.append(
      modalMenuItem('export-md', 'i-file', 'Export Markdown'),
      modalMenuItem('export-json', 'i-braces', 'Export JSON'),
    )
    const saveProj = modalMenuItem('save-project', 'i-package', 'Save project…')
    saveProj.onclick = () => {
      if (activeRunId !== undefined) void runLogged('save-project', () => window.anubee.saveProject(activeRunId!, currentLayout), r => {
        if ('path' in r && r.path) dirty = false
        return null
      })
    }
    menu.appendChild(saveProj)
    host.appendChild(menu)
    wireExport() // re-bind export-md / export-json by id against the fresh rows
  }})
})
document.getElementById('diff-btn')?.addEventListener('click', () => {
  showModal({ title: 'Diff', width: 260, render: host => {
    const menu = document.createElement('div'); menu.className = 'modal-menu'
    const loadB = modalMenuItem('load-run-b', 'i-diff', 'Load run B')
    menu.appendChild(loadB)
    host.appendChild(menu)
    wireLoadRunB(host)
    if (runB !== undefined) addDiffModeField(host) // re-open with B already loaded
  }})
})
document.getElementById('file-log')?.addEventListener('click', () => {
  let cleanup: (() => void) | undefined
  showModal({
    title: 'Activity log',
    width: 720,
    render: h => { cleanup = renderLogModal(h) },
    onClose: () => { cleanup?.(); cleanup = undefined },
  })
})

// Set by wireCapture on each modal open; the tracer:lines subscription is
// registered once, so it dispatches through this rather than re-binding.
// Takes a batch: main coalesces device stdout before it crosses IPC.
let captureLineSink: ((lines: readonly string[]) => void) | undefined

// Set by wireCapture on each modal open, mirroring captureLineSink; the
// tracer:done subscription is registered once, so it dispatches through this
// rather than re-binding, and reaches whichever Capture instance is live even
// when that is a reattach that never called tracer:start itself.
let captureDoneSink: ((result: { code: number; kind: string; runId?: number; error?: string }) => void) | undefined

// Set by wireCapture on each modal open, mirroring captureDoneSink; the
// tracer:phase subscription is registered once, so it dispatches through this.
let captureFinishingSink: (() => void) | undefined
// Forces the live Capture instance to land its buffered console tail now,
// rather than waiting for the next animation frame. Set alongside the sinks
// above and cleared by the same cleanup.
let captureFlush: (() => void) | undefined

// Registered once (not per Capture-modal open) so re-opening Capture doesn't
// stack tracer:line subscriptions; dispatches through captureLineSink to
// whichever cap-console is live.
window.anubee.onTracerLines(lines => {
  // Deliberately NOT mirrored into the activity log. A chatty capture emits
  // over 10k lines a second; each logAppend allocates an entry and, once at
  // LOG_CAP, shifts a 5000-element array - O(n) per line. It also evicted
  // every genuinely useful entry (preflight results, errors, run start/stop)
  // within a second of any real capture. The capture console is where the
  // stream belongs; the activity log records events, and run start and
  // completion are already logged around it.
  captureLineSink?.(lines)
})

// Registered once, mirroring onTracerLine above; dispatches through
// captureDoneSink to whichever Capture instance is live.
//
// The graph-view switch on a successful jsonl capture lives here, not inside
// captureDoneSink: ingest's own trace:loaded/trace:estimate broadcasts close
// the Capture modal (see onLoaded/onEstimate below) before tracer:done
// arrives, tearing captureDoneSink down with it (cleanupCapture) - so on
// exactly the success path this exists for, no Capture instance is left to
// react from inside the sink. This handler is registered once and never torn
// down, so every outcome (discard, error, success) runs through the same
// place and the switch happens regardless of whether a Capture instance
// happens to still be open.
window.anubee.onTracerDone(result => {
  captureDoneSink?.(result)
  if (!result.error && result.kind === 'jsonl' && result.runId !== undefined) showView('graph')
})

// Registered once, mirroring onTracerDone above; dispatches through
// captureFinishingSink to whichever Capture instance is live.
window.anubee.onTracerPhase(() => {
  captureFinishingSink?.()
})

// Ctrl/Cmd+O opens a run (replaces the removed native-menu accelerator).
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault()
    // Failure UI is centralized in main's trace:fail -> onIngestFail; just
    // terminate the promise so a rejected open is not an unhandled rejection.
    void window.anubee.openFile().catch(() => {})
  }
})

document.getElementById('app-quit')?.addEventListener('click', () => window.anubee.requestClose())

// Registered once at startup: main intercepts both the window-X and the Quit
// rail item into the same 'app:confirmClose' signal, so there is exactly one
// place that decides whether unsaved project changes block the close.
window.anubee.onConfirmClose(() => {
  if (!dirty) { window.anubee.respondClose('close'); return }
  let responded = false
  const respond = (a: 'close' | 'cancel') => { if (!responded) { responded = true; window.anubee.respondClose(a) } }
  showModal({
    title: 'Unsaved project changes',
    width: 380,
    onClose: () => respond('cancel'), // X / outside-click = Cancel; no-op if already responded
    render: host => {
      const msg = document.createElement('p')
      msg.textContent = 'Save this project bundle before closing?'
      msg.style.margin = '4px 0 14px'
      const row = document.createElement('div')
      row.style.cssText = 'display:flex; gap:8px; justify-content:flex-end'
      const mk = (label: string, cls: string, fn: () => void) => {
        const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn; return b
      }
      const save = mk('Save', 'btn pri', async () => {
        if (activeRunId === undefined) { respond('close'); closeModal(); return }
        const r = await window.anubee.saveProject(activeRunId, currentLayout)
        if (r && 'path' in r && r.path) { dirty = false; respond('close'); closeModal() }
        // else: the save dialog was canceled - leave this modal open so the user can choose again; do NOT respond or close.
      })
      const dont = mk("Don't Save", 'btn', () => { respond('close'); closeModal() })
      const cancel = mk('Cancel', 'btn', () => { respond('cancel'); closeModal() })
      row.append(save, dont, cancel)
      host.append(msg, row)
    },
  })
})
