import cytoscape from 'cytoscape'
import { themeColors, categoryColors, parseTheme, serializeTheme, type Theme } from './theme'
import { wirePanels } from './panels'
import { sliceToElements, filterForRow } from './graph-view'
import { runElkLayout } from './elk-layout'
import { renderTable } from './table'
import { currentFilter, wireFilterControls } from './filter-controls'
import { showNodeInspector } from './inspector'
import { badgeText, renderTagEditor } from './tag-view'
import { highlightNeighborhood, clearHighlight } from './graph-highlight'
import { showOffsetPopup, closeOffsetPopup, eventForOffset } from './offset-popup'
import { showNodeMenu, closeNodeMenu } from './node-menu'
import { renderSuggestions } from './suggestions-view'
import { renderOrphans } from './orphans-view'
import { renderRules } from './rules-view'
import { raspNodeStates } from './rasp-node-state'
import { upsertTag, removeTag, tagsByTarget, orphanedTags, isDismissed, addDismissed, type Tag, type Dismissed } from '@shared/project-store'
import type { TableRow } from '@shared/table'
import { renderDiffTable, mergedToElements, filterDiffRows, type DiffMode } from './diff-view'
import { renderFlame } from './flame-view'
import { buildFlame } from '@shared/flame-shape'
import { GRAPH_SLICE_CAP, FLAME_CHAIN_CAP, FLAME_NODE_CAP } from '@shared/caps'
import { renderCapabilityForm, appendConsoleLine } from './capture-view'
import { CAPABILITIES, capById, validateInputs, type CapValues } from '@shared/tracer-caps'

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
    // Badge border marks a tagged node; scoped to non-native so it doesn't
    // double-mark native nodes, which use the RASP category accent instead.
    { selector: 'node[badge][kind != "native"]', style: { 'border-width': 3, 'border-color': '#8e44ad' } },
    {
      selector: 'edge',
      style: {
        width: 'mapData(count, 1, 50, 2, 6)',
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
    { selector: 'node.highlighted', style: { 'z-index': 10 } },
    // Edges read grey by default; the selected node's fan-in/out lights them.
    { selector: 'edge.highlighted', style: {
      'line-color': tc.labelText, 'target-arrow-color': tc.labelText,
      'width': 2.5, 'opacity': 1, 'z-index': 10,
    } },
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
let tags: Tag[] = []
let dismissed: Dismissed[] = []
let runB: number | undefined
let diffMode: DiffMode = 'all'
let currentView: 'graph' | 'flame' | 'capture' = 'graph'

async function refreshTags(): Promise<void> {
  const rid = activeRunId
  if (rid === undefined) return
  const [r, dm] = await Promise.all([window.ares.loadTags(rid), window.ares.dismissedGet(rid)])
  if (activeRunId === rid) { tags = r.tags; dismissed = dm }
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

// Populate the suggestions popup. A suggestion drops off the list once it is
// confirmed (already a tag of that category) or rejected (dismissed) - both
// persisted, so it never returns.
async function refreshSuggestions(): Promise<void> {
  if (activeRunId === undefined) return
  const host = document.getElementById('suggestions-popup')
  if (!host) return
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
      void recolorRasp()
    })
  void recolorRasp()
}

// Toggle the suggestions popup from the chrome-bar button; refresh on open.
document.getElementById('suggest-btn')?.addEventListener('click', () => {
  const host = document.getElementById('suggestions-popup')
  if (!host) return
  if (host.hidden) { host.hidden = false; void refreshSuggestions() }
  else host.hidden = true
})

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

function showView(view: 'graph' | 'flame' | 'capture'): void {
  currentView = view
  document.getElementById('cy')?.classList.toggle('hidden', view !== 'graph')
  document.getElementById('flame')?.classList.toggle('active', view === 'flame')
  document.getElementById('flame')?.classList.toggle('hidden', view !== 'flame')
  document.getElementById('capture')?.classList.toggle('hidden', view !== 'capture')
  if (view === 'flame') void refreshFlame()
  for (const [id, v] of [['tab-graph', 'graph'], ['tab-flame', 'flame'], ['tab-capture', 'capture']] as const) {
    document.getElementById(id)?.classList.toggle('on', currentView === v)
  }
}

// Refresh whichever middle view is active (used by the filter apply action).
function refreshMiddle(): void {
  if (currentView === 'flame') void refreshFlame()
  // graph view refreshes on row selection, not on filter apply
}

async function selectRow(row: TableRow): Promise<void> {
  showView('graph')
  const slice = await window.ares.slice(filterForRow(row, currentFilter()), GRAPH_SLICE_CAP, activeRunId)
  const els = sliceToElements(slice)
  cy.elements().remove()
  cy.add(els.nodes)
  cy.add(els.edges)
  await runElkLayout(cy)
  cy.fit(undefined, 48) // frame the slice with padding; consistent zoom per selection
  showBanner(slice.truncated)
  redrawBadges()
  void recolorRasp()
}

// Exposed for the screenshot harness / debugging to drive the graph deterministically.
;(window as unknown as { __cy: typeof cy }).__cy = cy

cy.on('tap', 'node', evt => {
  const node = evt.target
  const nodeId = node.id()
  highlightNeighborhood(cy, node)
  if (node.data('kind') === 'native') {
    document.getElementById('inspector')?.replaceChildren()
    void Promise.all([
      window.ares.nodeOffsets(nodeId, currentFilter(), activeRunId),
      window.ares.nodeEvents(nodeId, currentFilter(), activeRunId),
    ]).then(([rows, events]) => {
      showOffsetPopup({
        nodeId,
        rows,
        anchor: { x: evt.originalEvent.clientX, y: evt.originalEvent.clientY },
        tagHost: h => renderTagEditor(h, nodeId, undefined, tagsByTarget(tags, nodeId),
          async tag => { tags = upsertTag(tags, tag); await persistTags(); void refreshTable(); redrawBadges(); void recolorRasp() },
          async (t, off) => { tags = removeTag(tags, t, off); await persistTags(); void refreshTable(); redrawBadges(); void recolorRasp() }),
        eventForOffset: (row) => eventForOffset(events, row),
      })
    })
  } else {
    closeOffsetPopup()
    void window.ares.nodeEvents(nodeId, currentFilter(), activeRunId).then(events => {
      showNodeInspector(nodeId, events)
      const host = document.getElementById('inspector')
      if (!host) return
      renderTagEditor(host, nodeId, undefined, tagsByTarget(tags, nodeId),
        async tag => { tags = upsertTag(tags, tag); await persistTags(); void refreshTable(); redrawBadges(); void recolorRasp() },
        async (t, off) => { tags = removeTag(tags, t, off); await persistTags(); void refreshTable(); redrawBadges(); void recolorRasp() })
    })
  }
})

// Right-click any node -> Copy the identifier / Tag it, for any node kind.
cy.on('cxttap', 'node', evt => {
  const nodeId = evt.target.id()
  showNodeMenu({
    nodeId,
    anchor: { x: evt.originalEvent.clientX, y: evt.originalEvent.clientY },
    onCopy: text => void window.ares.copyToClipboard(text),
    tagHost: h => renderTagEditor(h, nodeId, undefined, tagsByTarget(tags, nodeId),
      async tag => { tags = upsertTag(tags, tag); await persistTags(); void refreshTable(); redrawBadges(); void recolorRasp() },
      async (t, off) => { tags = removeTag(tags, t, off); await persistTags(); void refreshTable(); redrawBadges(); void recolorRasp() }),
  })
})

cy.on('tap', evt => { if (evt.target === cy) { clearHighlight(cy); closeOffsetPopup(); closeNodeMenu() } })

function applyGraphTheme(next: Theme): void {
  const c = themeColors(next)
  cy.style()
    .selector('node').style({ color: c.labelText, 'background-color': c.labelBacking, 'border-color': c.native })
    .selector('node[kind = "java"]').style({ 'border-color': c.java })
    .selector('node[kind = "native"]').style({ 'border-color': c.native })
    .selector('node[kind = "syscall"]').style({ 'border-color': c.syscall })
    .selector('edge').style({ 'line-color': c.edge, 'target-arrow-color': c.edge })
    .selector('edge.highlighted').style({ 'line-color': c.labelText, 'target-arrow-color': c.labelText })
    .update()
}

// Glyph shows the current theme (dark -> moon, light -> sun), matching the
// index.html default so a light-theme reload isn't stuck on the moon.
function syncThemeToggleGlyph(): void {
  const btn = document.getElementById('theme-toggle')
  if (btn) btn.textContent = theme === 'dark' ? '☾' : '☀'
}
syncThemeToggleGlyph() // init from the restored theme so a light-theme reload isn't stuck on the moon

document.getElementById('theme-toggle')?.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('ares.theme', serializeTheme(theme))
  syncThemeToggleGlyph()
  applyGraphTheme(theme)
  styleRaspCategories(theme)
  if (currentView === 'flame') void refreshFlame()
})

wirePanels(document.body)

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

function wireCapture(): void {
  const sel = document.getElementById('cap-select') as HTMLSelectElement | null
  const formHost = document.getElementById('cap-form')
  const statusHost = document.getElementById('cap-preflight-status')
  const consoleHost = document.getElementById('cap-console')
  const startBtn = document.getElementById('cap-start') as HTMLButtonElement | null
  const stopBtn = document.getElementById('cap-stop') as HTMLButtonElement | null
  const binIn = document.getElementById('cfg-binary') as HTMLInputElement | null
  const specIn = document.getElementById('cfg-specs') as HTMLInputElement | null
  if (!sel || !formHost || !statusHost || !consoleHost || !startBtn || !stopBtn || !binIn || !specIn) return

  let vals: CapValues = {}
  let preflightOk = false

  for (const c of CAPABILITIES) {
    const opt = document.createElement('option')
    opt.value = c.id; opt.textContent = c.label
    sel.appendChild(opt)
  }

  // A prior preflight validated a specific package; any capability switch or
  // input edit invalidates it, so re-gate Start until preflight is re-run.
  const invalidatePreflight = (): void => {
    preflightOk = false
    startBtn.disabled = true
    statusHost.innerHTML = ''
  }
  const drawForm = (): void => {
    vals = {}
    renderCapabilityForm(formHost, capById(sel.value)!, vals, v => { vals = v; invalidatePreflight() })
  }
  sel.addEventListener('change', () => {
    drawForm()
    invalidatePreflight()
  })
  drawForm()

  let configLoaded = false
  void window.ares.getTracerConfig().then(cfg => { binIn.value = cfg.aresBinary; specIn.value = cfg.specsDir; configLoaded = true })
  const saveCfg = (): void => {
    if (!configLoaded) return
    void window.ares.setTracerConfig({ aresBinary: binIn.value, specsDir: specIn.value })
  }
  binIn.addEventListener('change', saveCfg)
  specIn.addEventListener('change', saveCfg)

  document.getElementById('cap-preflight')?.addEventListener('click', async () => {
    saveCfg()
    const pkg = String(vals.pkg ?? '')
    if (!pkg) { statusHost.textContent = 'enter a package first'; return }
    statusHost.textContent = 'running preflight...'
    const checks = await window.ares.tracerPreflight(pkg)
    statusHost.innerHTML = ''
    for (const c of checks) {
      const row = document.createElement('div')
      row.className = c.ok ? 'preflight-ok' : 'preflight-bad'
      row.textContent = `${c.ok ? 'OK' : 'FAIL'}  ${c.label} - ${c.detail}`
      statusHost.appendChild(row)
    }
    preflightOk = checks.every(c => c.ok)
    startBtn.disabled = !preflightOk
  })

  startBtn.addEventListener('click', async () => {
    const cap = capById(sel.value)!
    const errs = validateInputs(cap, vals)
    if (errs.length) { statusHost.textContent = errs.join('; '); return }
    consoleHost.innerHTML = ''
    startBtn.disabled = true; stopBtn.disabled = false
    const timeout = binTimeout()
    try {
      const r = await window.ares.tracerStart(cap.id, vals, timeout)
      appendConsoleLine(consoleHost, `--- done (exit ${r.code}, kind ${r.kind}) ---`)
      if (r.kind === 'jsonl' && r.runId !== undefined) showView('graph')
    } catch (err) {
      appendConsoleLine(consoleHost, `--- error: ${err instanceof Error ? err.message : String(err)} ---`)
    } finally {
      stopBtn.disabled = true; startBtn.disabled = !preflightOk
    }
  })

  stopBtn.addEventListener('click', () => void window.ares.tracerStop())

  window.ares.onTracerLine(line => appendConsoleLine(consoleHost, line))

  function binTimeout(): number | undefined {
    const t = parseInt((document.getElementById('cap-timeout') as HTMLInputElement).value, 10)
    return Number.isFinite(t) && t > 0 ? t : undefined
  }
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
  document.getElementById('empty-state')?.classList.add('hidden')
  status(`Loaded ${s.eventCount} events (${s.errors} parse errors)`)
  void refreshTags().then(() => {
    void refreshTable()
    refreshMiddle()
    redrawBadges()
    void refreshSuggestions()
    void refreshOrphans()
  })
})
document.getElementById('tab-graph')?.addEventListener('click', () => showView('graph'))
document.getElementById('tab-flame')?.addEventListener('click', () => showView('flame'))
document.getElementById('tab-capture')?.addEventListener('click', () => showView('capture'))
document.getElementById('rules-btn')?.addEventListener('click', () => {
  const host = document.getElementById('rules')
  if (!host) return
  const opening = host.style.display === 'none' || host.style.display === ''
  host.style.display = opening ? 'block' : 'none'
  if (opening) {
    void renderRules(host, activeRunId, () => { void refreshSuggestions() })
  }
})
wireFilterControls(() => { void refreshTable(); refreshMiddle() })
wireExport()
wireDiff()
wireCapture()

function zoomBy(factor: number): void {
  const c = cy.container()
  if (!c) return
  const b = c.getBoundingClientRect()
  cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: b.width / 2, y: b.height / 2 } })
}
document.getElementById('zoom-in')?.addEventListener('click', () => zoomBy(1.2))
document.getElementById('zoom-out')?.addEventListener('click', () => zoomBy(1 / 1.2))
document.getElementById('zoom-fit')?.addEventListener('click', () => cy.fit(undefined, 48))

// Ctrl/Cmd +/- zoom the graph (only in graph view), overriding the browser's
// page zoom. Accepts '=' (unshifted '+'), '+', numpad, and '-'.
window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || currentView !== 'graph') return
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') { e.preventDefault(); zoomBy(1.2) }
  else if (e.key === '-' || e.code === 'NumpadSubtract') { e.preventDefault(); zoomBy(1 / 1.2) }
})

document.getElementById('open-run')?.addEventListener('click', () => { void window.ares.openFile() })

for (const toggle of document.querySelectorAll<HTMLElement>('[data-menu-toggle]')) {
  toggle.addEventListener('click', e => {
    e.stopPropagation()
    const menu = toggle.closest('.menu')
    const wasOpen = menu?.classList.contains('open')
    for (const m of document.querySelectorAll('.menu.open')) m.classList.remove('open')
    if (menu && !wasOpen) menu.classList.add('open')
  })
}
document.addEventListener('click', () => {
  for (const m of document.querySelectorAll('.menu.open')) m.classList.remove('open')
})
