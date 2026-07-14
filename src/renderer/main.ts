import cytoscape from 'cytoscape'
import { themeColors, categoryColors, parseTheme, serializeTheme, type Theme } from './theme'
import { wirePanels } from './panels'
import { sliceToElements, filterForRow } from './graph-view'
import { runElkLayout } from './elk-layout'
import { renderTable } from './table'
import { serializeLayout, parseLayout, columnCatalogue, engineColumnKeys, type ColumnLayout, type ColumnKey } from './columns'
import { applyWidths, nextWidth } from './column-resize'
import { currentFilter, wireFilterControls } from './filter-controls'
import { showNodeInspector, showRecordDetail, showFuncsNodeInspector, showFuncsRecordDetail } from './inspector'
import { badgeText, renderTagEditor } from './tag-view'
import { highlightNeighborhood, clearHighlight } from './graph-highlight'
import { showOffsetPopup, closeOffsetPopup, eventForOffset, type NodeBox } from './offset-popup'
import { showNodeMenu, closeNodeMenu, showTagPopup, closeTagPopup } from './node-menu'
import { renderSuggestions } from './suggestions-view'
import { renderOrphans } from './orphans-view'
import { renderRules } from './rules-view'
import { raspNodeStates } from './rasp-node-state'
import { upsertTag, removeTag, tagsByTarget, orphanedTags, isDismissed, addDismissed, type Tag, type Dismissed } from '@shared/project-store'
import type { TableRow } from '@shared/table'
import { nativeNodeId } from '@shared/graph-shape'
import { renderDiffTable, mergedToElements, filterDiffRows, type DiffMode } from './diff-view'
import { renderFlame } from './flame-view'
import { buildFlame } from '@shared/flame-shape'
import { GRAPH_SLICE_CAP, FLAME_CHAIN_CAP, FLAME_NODE_CAP } from '@shared/caps'
import type { GraphSlice } from '@shared/graph-shape'
import { renderCapabilityForm, appendConsoleLine, applyFieldErrors, renderDot, applySpecChoices } from './capture-view'
import { CAPABILITIES, capById, validateInputs, isSafeToken, fieldErrors, capNeedsSpec, type CapValues, type Capability } from '@shared/tracer-caps'
import { showModal, closeModal, isModalOpen } from './modal'
import { renderLogModal } from './log-view'
import { logAppend } from './log-store'
import { runLogged } from './run-logged'
import { makeEpoch } from './selection-epoch'
import type { SyscallEvent, FuncEvent } from '@shared/events'
import { createLibView, type LibViewApi } from './native-lib-view'

let theme: Theme = parseTheme(localStorage.getItem('ares.theme'))
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
    { selector: 'node[presence = "both"]', style: { 'background-color': '#95a5a6' } },
    { selector: 'edge[presence = "A-only"]', style: { 'line-color': '#c0392b', 'target-arrow-color': '#c0392b' } },
    { selector: 'edge[presence = "B-only"]', style: { 'line-color': '#27ae60', 'target-arrow-color': '#27ae60' } },
    { selector: '.dimmed', style: { 'opacity': 0.12 } },
    // Off-path (dimmed) edges carry no arrowhead and go hair-thin: a de-emphasized
    // edge should recede, and its triangle arrowhead - which scales with edge width
    // and the (high) zoom of a small subgraph - was rendering as a large grey blob.
    { selector: 'edge.dimmed', style: { 'target-arrow-shape': 'none', 'width': 1 } },
    // Edges read grey by default; the selected node's fan-in/out lights them
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
  const suggestions = (await window.ares.suggest(activeRunId))
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

// Per-engine column preference key. The legacy `ares.columns` (syscall-only) is
// read as the syscall fallback so a returning user keeps their saved columns.
function columnsKey(engine: 'syscall' | 'func'): string {
  return `ares.columns.${engine}`
}
function savedColumns(engine: 'syscall' | 'func'): string | null {
  return localStorage.getItem(columnsKey(engine)) ?? (engine === 'syscall' ? localStorage.getItem('ares.columns') : null)
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
  const [r, dm] = await Promise.all([window.ares.loadTags(rid), window.ares.dismissedGet(rid)])
  if (activeRunId === rid) { tags = r.tags; dismissed = dm }
}

async function persistTags(): Promise<void> {
  if (activeRunId === undefined) return
  try {
    await window.ares.saveTags(activeRunId, tags)
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
    window.ares.table(filter, { limit: TABLE_PAGE, offset: tableOffset }, activeRunId),
    window.ares.count(filter, activeRunId),
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
  const all = await window.ares.suggest(activeRunId)
  const open = all.filter(s =>
    !isDismissed(dismissed, s.target, s.category) &&
    !tags.some(t => t.target === s.target && t.category === s.category))
  renderSuggestions(host, open,
    async tag => {
      tags = upsertTag(tags, tag)
      await persistTags()
      void refreshTable()
      redrawBadges()
      void recolorRasp()
    },
    async s => {
      dismissed = addDismissed(dismissed, s.target, s.category)
      await window.ares.dismissedSave(activeRunId!, dismissed)
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
  const orphanSet = new Set(targets.length ? await window.ares.orphans(activeRunId, targets) : [])
  // Orphan warnings live in the (now selection-gated) side panel; reveal it when
  // there are any, so they aren't silently hidden until a row/node is clicked.
  if (orphanedTags(tags, orphanSet).length) showSide(true)
  const drop = async (target: string, off?: string) => {
    tags = removeTag(tags, target, off)
    await persistTags()
    void refreshTable()
    redrawBadges()
    void recolorRasp()
    void refreshOrphans()
  }
  renderOrphans(host, orphanedTags(tags, orphanSet), drop, async () => {
    for (const o of orphanedTags(tags, orphanSet)) tags = removeTag(tags, o.target, o.offset)
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
  const rollup = await window.ares.stackRollup(currentFilter(), FLAME_CHAIN_CAP, activeRunId)
  const tree = buildFlame(rollup.rows, FLAME_NODE_CAP)
  renderFlame(host, tree, rollup.truncated || tree.truncated, theme)
}

function showView(view: 'graph' | 'flame' | 'libs'): void {
  currentView = view
  document.getElementById('cy')?.classList.toggle('hidden', view !== 'graph')
  document.getElementById('flame')?.classList.toggle('active', view === 'flame')
  document.getElementById('flame')?.classList.toggle('hidden', view !== 'flame')
  document.getElementById('libs')?.classList.toggle('hidden', view !== 'libs')
  showTablePanel(view !== 'libs' && activeRunId !== undefined)
  document.getElementById('graph-empty')?.classList.toggle('hidden', view !== 'graph' || selectedRowId !== undefined)
  if (view === 'flame') void refreshFlame()
  if (view === 'libs') libView.setSource('loaded')
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
  const host = document.getElementById('inspector')
  const ev = await window.ares.eventById(row.id, activeRunId)
  if (!selEpoch.isCurrent(e)) return // a newer selection superseded this row; drop the stale detail
  if (host && ev) {
    if (activeEngine === 'func') showFuncsRecordDetail(host, ev as FuncEvent)
    else showRecordDetail(host, ev as SyscallEvent)
  }

  showView('graph')
  const slice = await window.ares.slice(filterForRow(row, currentFilter()), GRAPH_SLICE_CAP, activeRunId)
  if (!selEpoch.isCurrent(e)) return // stale slice; do not repaint the graph for a row the user left
  await renderSlice(slice)
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

cy.on('tap', 'node', evt => {
  const e = selEpoch.bump()
  const node = evt.target
  const nodeId = node.id()
  highlightNeighborhood(cy, node)
  showSide(true)
  const nodeKind = node.data('kind') as string | undefined
  const nodeCats = [...new Set(tagsByTarget(tags, nodeId).map(t => t.category))]
  if (activeEngine === 'func') {
    closeOffsetPopup()
    void window.ares.nodeEvents(nodeId, currentFilter(), activeRunId).then(records => {
      if (!selEpoch.isCurrent(e)) return // stale inspector repaint
      showFuncsNodeInspector(nodeId, records as FuncEvent[], { kind: nodeKind, cats: nodeCats })
    })
    return
  }
  if (nodeKind === 'native') {
    const box = nodeBox(node)
    void Promise.all([
      window.ares.nodeOffsets(nodeId, currentFilter(), activeRunId),
      window.ares.nodeEvents(nodeId, currentFilter(), activeRunId),
    ]).then(([rows, rawEvents]) => {
      if (!selEpoch.isCurrent(e)) return // node deselected / another selected during the round-trip
      const events = rawEvents as SyscallEvent[]
      showNodeInspector(nodeId, events, { kind: nodeKind, cats: nodeCats })
      showOffsetPopup({ nodeId, rows, anchor: box, eventForOffset: (row) => eventForOffset(events, row) })
    })
  } else {
    closeOffsetPopup()
    void window.ares.nodeEvents(nodeId, currentFilter(), activeRunId).then(rawEvents => {
      if (!selEpoch.isCurrent(e)) return // stale inspector repaint
      const events = rawEvents as SyscallEvent[]
      showNodeInspector(nodeId, events, { kind: nodeKind, cats: nodeCats })
    })
  }
})

// Right-click any node -> Copy the identifier, or Add Tag (opens the tag popup).
cy.on('cxttap', 'node', evt => {
  const nodeId = evt.target.id()
  const anchor = { x: evt.originalEvent.clientX, y: evt.originalEvent.clientY }
  showNodeMenu({
    nodeId,
    anchor,
    onCopy: text => void window.ares.copyToClipboard(text),
    onAddTag: () => showTagPopup({
      nodeId,
      anchor,
      tagHost: h => renderTagEditor(h, nodeId, undefined, tagsByTarget(tags, nodeId),
        async tag => { tags = upsertTag(tags, tag); await persistTags(); void refreshTable(); redrawBadges(); void recolorRasp() },
        async (t, off) => { tags = removeTag(tags, t, off); await persistTags(); void refreshTable(); redrawBadges(); void recolorRasp() }),
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
  localStorage.setItem('ares.theme', serializeTheme(theme))
  updateThemePill()
  applyGraphTheme(theme)
  styleRaspCategories(theme)
  if (currentView === 'flame') void refreshFlame()
})

wirePanels(document.body)

const libView: LibViewApi = createLibView(document.getElementById('libs')!, {
  loadedRows: () => window.ares.libTable(activeRunId),
  startLive: pkg => window.ares.startLive(pkg),
  stopLive: () => window.ares.stopLive(),
  dumpLib: (pid, pattern) => window.ares.dumpLib(pid, pattern),
  reveal: path => window.ares.revealArtifact(path),
  exportArtifact: path => void window.ares.exportArtifact(path),
})
window.ares.onLibMapped(l => libView.applyMapped(l))
window.ares.onLibUnmapped(l => libView.applyUnmapped(l))
window.ares.onLibStreamEnd(() => libView.streamEnded())

async function refreshDiff(): Promise<void> {
  const host = document.getElementById('diff-table')
  if (!host || activeRunId === undefined || runB === undefined) return
  const rows = await window.ares.diffTable(activeRunId, runB, currentFilter(), 1000)
  const taggedIds = new Set(tags.map(t => t.target))
  const shown = filterDiffRows(rows, diffMode, taggedIds)
  // The diff table renders into the selection-gated side panel; reveal it so a
  // Load-run-B comparison is visible without first clicking a row/node.
  if (shown.length) showSide(true)
  renderDiffTable(host, shown,
    id => badgeText(tagsByTarget(tags, id)),
    async id => {
      const e = selEpoch.bump()
      const merged = await window.ares.diffSlice(activeRunId!, runB!, id, currentFilter())
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
    const summary = await runLogged('compare', () => window.ares.openFileForCompare(),
      s => (s ? { level: s.errors > 0 ? 'warn' : 'success', message: `Compare loaded ${s.eventCount} events (${s.errors} parse errors)` } : null))
    if (summary) {
      runB = summary.runId
      addDiffModeField(host) // reveal the Mode filter now that a comparison exists
      await refreshTags()
      void refreshDiff()
    }
  })
}

function wireCapture(): void {
  const sel = document.getElementById('cap-select') as HTMLSelectElement | null
  const formHost = document.getElementById('cap-form')
  const statusHost = document.getElementById('cap-preflight-status')
  const consoleHost = document.getElementById('cap-console')
  const startBtn = document.getElementById('cap-start') as HTMLButtonElement | null
  const stopBtn = document.getElementById('cap-stop') as HTMLButtonElement | null
  const binIn = document.getElementById('cfg-binary') as HTMLInputElement | null
  const saveIn = document.getElementById('cap-savepath') as HTMLInputElement | null
  if (!sel || !formHost || !statusHost || !consoleHost || !startBtn || !stopBtn || !binIn) return

  document.getElementById('cap-browse')?.addEventListener('click', async () => {
    const p = await window.ares.pickSavePath()
    if (p && saveIn) saveIn.value = p
  })

  const binDot = document.getElementById('cfg-binary-dot')
  const binErr = document.getElementById('cfg-binary-err')

  let specsDir = ''            // persisted host specs dir; rendered in-form for spec engines
  let specNames: string[] = [] // discovered .spec basenames for the current specsDir

  const refreshBinary = async (): Promise<void> => {
    const r = await window.ares.tracerCheckPaths(binIn.value, specsDir)
    if (binDot) renderDot(binDot, r.binary)
    if (binErr) binErr.textContent = r.binary.ok ? '' : `Required - ${r.binary.detail}`
  }

  document.getElementById('cfg-binary-browse')?.addEventListener('click', async () => {
    const p = await window.ares.tracerPickBinary()
    if (p) { binIn.value = p; saveCfg(); void refreshBinary() }
  })
  binIn.addEventListener('input', () => void refreshBinary())

  let vals: CapValues = {}
  let preflightOk = false
  const preflightEpoch = makeEpoch() // guards a stale preflight run from re-enabling Start for edited/invalidated inputs

  for (const c of CAPABILITIES) {
    const opt = document.createElement('option')
    opt.value = c.id; opt.textContent = c.engine
    sel.appendChild(opt)
  }

  // A prior preflight validated a specific package; any capability switch or
  // input edit invalidates it, so re-gate Start until preflight is re-run.
  const invalidatePreflight = (): void => {
    preflightEpoch.bump()
    preflightOk = false
    startBtn.disabled = true
    statusHost.innerHTML = ''
  }
  const onFormChange = (cap: Capability, v: CapValues): void => {
    vals = v
    invalidatePreflight()
    const { fields, form } = fieldErrors(cap, vals)
    applyFieldErrors(formHost, fields)
    const formErr = document.getElementById('cap-form-err')
    if (formErr) formErr.textContent = form.join('; ')
  }

  // Repaint the in-form specs-dir dot + error from a host-path check.
  const refreshSpecsDot = async (): Promise<void> => {
    const dot = formHost.querySelector<HTMLElement>('[data-role="specsDot"]')
    const err = formHost.querySelector<HTMLElement>('[data-err="specsDir"]')
    if (!dot && !err) return
    const r = await window.ares.tracerCheckPaths(binIn.value, specsDir)
    if (dot) renderDot(dot, r.specs)
    if (err) err.textContent = r.specs.ok ? '' : `Required - ${r.specs.detail}`
  }

  // Reload the .spec list for the current specsDir and repopulate the select in
  // place; drop a now-invalid selection and re-run the field-error pass.
  const refreshSpecList = async (cap: Capability): Promise<void> => {
    specNames = await window.ares.tracerListSpecs(specsDir)
    if (typeof vals.spec === 'string' && vals.spec && !specNames.includes(vals.spec)) {
      vals = { ...vals, spec: '' }
    }
    applySpecChoices(formHost, specNames, String(vals.spec ?? ''))
    const { fields, form } = fieldErrors(cap, vals)
    applyFieldErrors(formHost, fields)
    const formErr = document.getElementById('cap-form-err')
    if (formErr) formErr.textContent = form.join('; ')
  }

  // Bind the specs-dir config row that renderCapabilityForm emits for spec engines.
  const bindSpecsRow = (cap: Capability): void => {
    const dir = formHost.querySelector<HTMLInputElement>('[data-config="specsDir"]')
    if (!dir) return
    const onDirChange = async (): Promise<void> => {
      specsDir = dir.value
      saveCfg()
      await refreshSpecsDot()
      await refreshSpecList(cap)
      invalidatePreflight()
    }
    formHost.querySelector('[data-role="specsBrowse"]')?.addEventListener('click', async () => {
      const p = await window.ares.tracerPickSpecsDir()
      if (p) { dir.value = p; await onDirChange() }
    })
    dir.addEventListener('input', () => void onDirChange())
    void refreshSpecsDot()
  }

  const drawForm = (): void => {
    vals = {}
    const cap = capById(sel.value)!
    const opts = capNeedsSpec(cap) ? { specNames, specsDir } : {}
    renderCapabilityForm(formHost, cap, vals, v => onFormChange(cap, v), opts)
    bindSpecsRow(cap)
  }
  sel.addEventListener('change', () => {
    drawForm()
    invalidatePreflight()
    const cap = capById(sel.value)!
    if (capNeedsSpec(cap)) void refreshSpecList(cap)
  })
  drawForm()

  let configLoaded = false
  void window.ares.getTracerConfig().then(async cfg => {
    binIn.value = cfg.aresBinary
    specsDir = cfg.specsDir
    configLoaded = true
    void refreshBinary()
    const cap = capById(sel.value)!
    if (capNeedsSpec(cap)) { await refreshSpecList(cap); void refreshSpecsDot() }
  })
  const saveCfg = (): void => {
    if (!configLoaded) return
    void window.ares.setTracerConfig({ aresBinary: binIn.value, specsDir })
  }
  binIn.addEventListener('change', saveCfg)

  const preflightBtn = document.getElementById('cap-preflight') as HTMLButtonElement | null
  preflightBtn?.addEventListener('click', async () => {
    const token = preflightEpoch.bump()
    saveCfg()
    const pkg = String(vals.pkg ?? '')
    if (!pkg) { statusHost.textContent = 'enter a package first'; return }
    if (!isSafeToken(pkg)) { statusHost.textContent = 'package has unsupported characters'; return }
    statusHost.innerHTML = ''
    startBtn.disabled = true
    preflightBtn.disabled = true
    try {
      const checks = await window.ares.tracerPreflight(pkg)
      logAppend(checks.some(c => !c.ok) ? 'warn' : 'success', 'preflight',
        `Preflight: ${checks.length} checks, ${checks.filter(c => !c.ok).length} failing`)
      if (!preflightEpoch.isCurrent(token)) return // superseded by an edit or another run; don't enable Start for stale inputs
      preflightOk = checks.every(c => c.ok)
      startBtn.disabled = !preflightOk
    } catch (err) {
      if (!preflightEpoch.isCurrent(token)) return // superseded; don't write rows for a run nobody is waiting on
      const row = document.createElement('div')
      row.className = 'preflight-bad'
      row.textContent = `preflight failed: ${err instanceof Error ? err.message : String(err)}`
      statusHost.appendChild(row)
      preflightOk = false
      startBtn.disabled = true
    } finally {
      preflightBtn.disabled = false
    }
  })

  startBtn.addEventListener('click', async () => {
    const cap = capById(sel.value)!
    const errs = validateInputs(cap, vals)
    if (errs.length) { statusHost.textContent = errs.join('; '); return }
    consoleHost.innerHTML = ''
    startBtn.disabled = true; stopBtn.disabled = false
    const timeout = binTimeout()
    try {
      const r = await runLogged('capture', () => window.ares.tracerStart(cap.id, vals, timeout, saveIn?.value || undefined),
        res => ({ level: res.code === 0 ? 'success' : 'error', message: `Capture ${cap.id} finished (${res.kind}, code ${res.code})` }))
      appendConsoleLine(consoleHost, `--- done (exit ${r.code}, kind ${r.kind}) ---`)
      if (r.kind === 'jsonl' && r.runId !== undefined) showView('graph')
    } catch (err) {
      appendConsoleLine(consoleHost, `--- error: ${err instanceof Error ? err.message : String(err)} ---`)
    } finally {
      stopBtn.disabled = true; startBtn.disabled = !preflightOk
    }
  })

  stopBtn.addEventListener('click', () => { logAppend('info', 'capture', 'Stop requested'); void window.ares.tracerStop() })

  function binTimeout(): number | undefined {
    const t = parseInt((document.getElementById('cap-timeout') as HTMLInputElement).value, 10)
    return Number.isFinite(t) && t > 0 ? t : undefined
  }
}

function openCaptureModal(): void {
  showModal({
    title: 'Capture',
    width: 620,
    render: host => {
      const tpl = document.getElementById('capture-template') as HTMLTemplateElement | null
      if (tpl) host.appendChild(tpl.content.cloneNode(true))
      wireCapture() // binds the cap-* controls now present in the modal
    },
  })
}

function wireExport(): void {
  const md = document.getElementById('export-md')
  const json = document.getElementById('export-json')
  md?.addEventListener('click', () => {
    if (activeRunId !== undefined) void runLogged('export', () => window.ares.exportFindings(activeRunId!, 'md'),
      p => (p ? { level: 'success', message: `Exported ${p}` } : null))
  })
  json?.addEventListener('click', () => {
    if (activeRunId !== undefined) void runLogged('export', () => window.ares.exportFindings(activeRunId!, 'json'),
      p => (p ? { level: 'success', message: `Exported ${p}` } : null))
  })
}

window.ares.onProgress(pct => {
  const wrap = document.getElementById('ingest-progress')
  const bar = document.getElementById('ingest-bar')
  const label = document.getElementById('ingest-pct')
  if (!wrap || !bar || !label) return
  wrap.classList.remove('hidden')
  bar.style.width = `${pct}%`
  label.textContent = `Loading... ${pct}%`
})
window.ares.onLoaded(s => {
  closeModal() // any successful load closes the open (run / project / capture) modal that triggered it
  activeRunId = s.runId
  activeEngine = s.kinds.includes('funcs') && !s.kinds.includes('syscall') ? 'func' : 'syscall'
  tableOffset = 0 // a fresh run starts at page 1; a stale offset could land past its row count
  selectedRowId = undefined
  document.getElementById('empty-state')?.classList.add('hidden')
  document.getElementById('ingest-progress')?.classList.add('hidden')
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
  })
  // Coverage health text (not graph data) - stored, not shown, until a row
  // is selected and renderSlice surfaces it via the chip.
  void window.ares.coverage(s.runId).then(cov => {
    coverageChip = cov ? `${cov.snaps.total} snapshots · ${cov.snaps.truncated} truncated · CFI walks ${cov.cfi.walks}` : ''
  })
})
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
      currentLayout = { ...currentLayout, callSite: m, columns: engineColumnKeys(activeEngine, m) }
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
    runBtn.onclick = () => void runLogged('open', () => window.ares.openFile(), () => null)
    const projBtn = modalMenuItem('open-project', 'i-package', 'Open project…')
    projBtn.onclick = () => void runLogged('open-project', () => window.ares.openProject(), () => null)
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
      if (activeRunId !== undefined) void runLogged('save-project', () => window.ares.saveProject(activeRunId!, currentLayout), r => {
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

// Registered once (not per Capture-modal open) so re-opening Capture doesn't
// stack tracer:line subscriptions; appends to whichever cap-console is live.
window.ares.onTracerLine(line => {
  logAppend('info', 'tracer', line)
  const c = document.getElementById('cap-console')
  if (c) appendConsoleLine(c, line)
})

// Streamed preflight rows; registered once for the same reason as onTracerLine.
window.ares.onPreflightCheck(c => {
  const host = document.getElementById('cap-preflight-status')
  if (!host) return
  const row = document.createElement('div')
  row.className = c.ok ? 'preflight-ok' : 'preflight-bad'
  row.textContent = `${c.ok ? 'OK' : 'FAIL'}  ${c.label} - ${c.detail}`
  host.appendChild(row)
})

// Ctrl/Cmd+O opens a run (replaces the removed native-menu accelerator).
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); void window.ares.openFile() }
})

document.getElementById('app-quit')?.addEventListener('click', () => window.ares.requestClose())

// Registered once at startup: main intercepts both the window-X and the Quit
// rail item into the same 'app:confirmClose' signal, so there is exactly one
// place that decides whether unsaved project changes block the close.
window.ares.onConfirmClose(() => {
  if (!dirty) { window.ares.respondClose('close'); return }
  let responded = false
  const respond = (a: 'close' | 'cancel') => { if (!responded) { responded = true; window.ares.respondClose(a) } }
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
        const r = await window.ares.saveProject(activeRunId, currentLayout)
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
