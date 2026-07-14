// GUI screenshot harness: launches the built Electron app, auto-loads the
// sample fixture (via ARES_OPEN_FILE), drives the renderer, and captures PNGs of
// each state so they can be reviewed. Run: node scripts/screenshot.mjs
//
// Requires a prior `npm run build` (uses out/main/index.js) and a display
// (WSLg provides DISPLAY=:0; falls back to --no-sandbox for the Electron zygote).
import { _electron as electron } from 'playwright'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shots = resolve(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const fixture = resolve(root, 'tests/fixtures/detector_snap.jsonl')

// Fresh userData dir per run: otherwise localStorage (panel widths, theme) persists
// across invocations and the resize-drag step below can start already clamped at
// MAX_W, making the "did it move" assertion a false failure on a re-run.
const userDataDir = mkdtempSync(resolve(tmpdir(), 'ares-desktop-shots-'))

const app = await electron.launch({
  args: [resolve(root, 'out/main/index.js'), '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`],
  env: { ...process.env, ARES_OPEN_FILE: fixture },
})

const win = await app.firstWindow()
await win.setViewportSize({ width: 1400, height: 900 })

async function shot(name) {
  await win.screenshot({ path: resolve(shots, name) })
  console.log('captured', name)
}

// 1. Loaded: the master table populated from the fixture.
await win.waitForSelector('#table table tr', { timeout: 30000 })
await win.waitForTimeout(300)
await shot('01-loaded-table.png')

// Rail + command-bar shape (redesign): icon rail with #tab-graph, a separate
// #cmdbar filter row, no leftover legacy toolbar #chrome wrapper.
const barOk = await win.evaluate(() =>
  !!document.getElementById('rail') &&
  !!document.getElementById('cmdbar') &&
  !!document.getElementById('tab-graph') &&
  !!document.getElementById('app-quit') &&
  !document.getElementById('chrome'))
if (!barOk) throw new Error('shell not in rail + command-bar shape')

// Control buttons carry inline <svg> glyphs now (round-2: no unicode glyph
// text to assert on) - just confirm the icon markup is actually there.
const svgOk = await win.evaluate(() =>
  !!document.querySelector('#pager-prev svg') &&
  !!document.querySelector('#pager-next svg') &&
  !!document.querySelector('#zoom-in svg') &&
  !!document.querySelector('#zoom-out svg') &&
  !!document.querySelector('#zoom-fit svg') &&
  !!document.querySelector('#cols-btn svg') &&
  !!document.querySelector('#tab-left svg') &&
  !!document.querySelector('#side-close svg'))
if (!svgOk) throw new Error('a control button is missing its inline svg icon')

// Call-site column merges java-over-native (or native-only) into one cell.
const csOk = await win.evaluate(() => !!document.querySelector('#table td.col-callSite .cs-native'))
if (!csOk) throw new Error('call-site cell did not render a native line')

// The graph pane shows its empty-state prompt until a row is selected.
const emptyShown = await win.evaluate(() =>
  !document.getElementById('graph-empty')?.classList.contains('hidden'))
if (!emptyShown) throw new Error('graph empty-state prompt not shown before a selection')

// 2. A bridge selected: the focused java -> native -> syscall subgraph.
await win.click('#table table tr:nth-child(2)') // first data row (row 1 is header)
await win.waitForSelector('#cy canvas', { timeout: 15000 })
// renderSlice hides the empty-state prompt only once the ELK layout for the
// slice finishes; a large slice can take longer than a short fixed pause, so
// poll for it instead of guessing a sleep duration.
await win.waitForFunction(() =>
  document.getElementById('graph-empty')?.classList.contains('hidden'), { timeout: 10000 })
await win.waitForTimeout(1200) // let ELK layout settle further before reading node styles

// Nodes render as non-draggable round-rectangle boxes (task 6: node-box redesign).
const boxOk = await win.evaluate(() => {
  const cy = window.__cy
  const n = cy.nodes()[0]
  return n && n.style('shape') === 'round-rectangle' && !n.grabbable()
})
if (!boxOk) throw new Error('nodes are not non-draggable round-rectangle boxes')

// Node accent is now a uniform border, not a left-stripe gradient (task 4).
const borderOk = await win.evaluate(() => {
  const n = window.__cy.nodes()[0]
  return n && parseFloat(n.style('border-width')) >= 2
})
if (!borderOk) throw new Error('node accent border missing')

await shot('02-subgraph.png')

// (round-2: the unified uppercase `.cat-chip` is asserted in the Rules modal
// step below - robust, no dependence on graph-node hit-testing or on a row's
// innermost-frame tag surfacing in the master table's tags column.)

// RASP category coloring on native blocks (task 7). The heuristic run must
// produce suggestions, and when a suggested native block is rendered it must pick
// up a category class. An arbitrary first-row subgraph need not contain a
// suggested node (true for a real capture), so drive it deterministically: read
// the run's suggestions, filter the table by the suggested block's symbol (free
// text matches backtrace symbols), select that bridge, and assert the class.
const sugTarget = await win.evaluate(async () => {
  const s = await window.ares.suggest()
  if (!s.length) return null
  const id = s[0].target // 'nat:<module>!<symbol>' or 'nat:<module>'
  const rest = id.slice(4)
  const bang = rest.indexOf('!')
  return bang >= 0 ? rest.slice(bang + 1) : rest // symbol, else module
})
if (!sugTarget) throw new Error('heuristic engine produced no suggestions on the capture')
await win.fill('#f-text', sugTarget)
await win.press('#f-text', 'Enter') // omni bar: Enter applies (no #apply button since the omni filter bar redesign)
await win.waitForTimeout(400)
await win.click('#table table tr:nth-child(2)')
// ELK layout + the async recolorRasp round-trip settle at different rates run to
// run (more so since the JetBrains Mono metrics shifted node sizing); poll for the
// category class rather than guessing a fixed delay.
await win.waitForFunction(
  () => !!window.__cy && window.__cy.nodes('.native.suggested, .native.confirmed').length > 0,
  { timeout: 12000 },
).catch(() => { throw new Error('a rendered suggested native block did not receive a RASP category class') })
await shot('02b-rasp-colored.png')
// Clear the filter so later steps see the full run again.
await win.fill('#f-text', '')
await win.press('#f-text', 'Enter')
await win.waitForTimeout(300)

// 3. A node inspected: click the syscall node at its real rendered position.
const pos = await win.evaluate(() => {
  const cy = window.__cy
  const n = cy.nodes('[kind = "syscall"]')[0] ?? cy.nodes()[0]
  const p = n.renderedPosition()
  const bb = cy.container().getBoundingClientRect()
  return { x: bb.left + p.x, y: bb.top + p.y }
})
await win.mouse.click(pos.x, pos.y)
await win.waitForTimeout(500)
await shot('03-inspector.png')

// 3b. A native node tapped: the floating offset popup opens (with the tag
// editor moved in) and the off-path graph dims (task 8: tap routing). A single
// row's bridge slice is one straight chain (every node reachable from every
// other), so fan-in/fan-out highlighting can never leave anything dimmed there;
// load the whole run instead (two disconnected bridges in the fixture) so the
// dim assertion is meaningful.
await win.evaluate(async () => {
  const cy = window.__cy
  // Honest java -> native -> syscall topology (the app's directed slice) with two
  // branches so a native tap's fan-in/out both lights edges and dims off-path.
  // Node ids must be real ids from the loaded run (not placeholder strings):
  // a native tap's inspector/offset-popup query DuckDB by exact node id, and a
  // made-up id never appears in any real event's causal chain, so the inspector
  // assertion below would see zero records.
  const slice = await window.ares.slice({}, 500)
  const byKind = k => slice.nodes.filter(n => n.kind === k)
  const j = byKind('java'), n = byKind('native'), s = byKind('syscall')
  if (j.length < 2 || n.length < 2 || s.length < 1) {
    throw new Error('run lacks enough distinct java/native/syscall nodes for the harness graph')
  }
  const [j1, j2] = j
  const [n1, n2] = n
  const [s1] = s
  cy.elements().remove()
  cy.add([j1, j2, n1, n2, s1].map(x => ({ data: { id: x.id, kind: x.kind, label: x.label }, classes: x.kind })))
  cy.add([
    { data: { id: 'e1', source: j1.id, target: n1.id } },
    { data: { id: 'e2', source: n1.id, target: s1.id } },
    { data: { id: 'e3', source: j2.id, target: n2.id } },
    { data: { id: 'e4', source: n2.id, target: s1.id } },
  ])
  cy.layout({ name: 'grid' }).run()
  cy.fit(undefined, 48)
})
await win.waitForTimeout(200)
const npos = await win.evaluate(() => {
  const cy = window.__cy
  // Centre + enlarge the native node so the coordinate click lands squarely.
  const n = cy.nodes('[kind = "native"]')[0]
  cy.center(n)
  cy.zoom(cy.zoom() * 1.6)
  cy.center(n)
  const p = n.renderedPosition()
  const bb = cy.container().getBoundingClientRect()
  return { x: bb.left + p.x, y: bb.top + p.y }
})
await win.mouse.click(npos.x, npos.y)
await win.waitForSelector('.offset-popup', { timeout: 5000 })
const dimOk = await win.evaluate(() => window.__cy.elements('.dimmed').length > 0)
if (!dimOk) throw new Error('tap did not dim the off-path elements')
const litEdges = await win.evaluate(() => window.__cy.edges('.highlighted').length > 0)
if (!litEdges) throw new Error('native tap did not light any edges')
// The inspector fills with the node's filtered records (not cleared).
const inspOk = await win.evaluate(() => !!document.querySelector('#inspector .insp-table tbody tr'))
if (!inspOk) throw new Error('native tap did not fill the inspector with records')
// The offset popup carries no tag editor (tagging is right-click now).
const noTag = await win.evaluate(() => !document.querySelector('.offset-popup .tag-editor'))
if (!noTag) throw new Error('offset popup still contains a tag editor')
// The popup sits to the right of (or flipped left of) the node - never over it.
const clearOk = await win.evaluate(() => {
  const cy = window.__cy
  const n = cy.nodes('[kind = "native"]')[0]
  const bb = n.renderedBoundingBox()
  const rect = cy.container().getBoundingClientRect()
  const nodeRight = rect.left + bb.x2, nodeLeft = rect.left + bb.x1
  const pop = document.querySelector('.offset-popup').getBoundingClientRect()
  return pop.left >= nodeRight - 1 || pop.right <= nodeLeft + 1
})
if (!clearOk) throw new Error('offset popup overlaps the node instead of sitting beside it')
await win.waitForTimeout(300)
await shot('03b-offset-popup.png')

// 3c. Right-click a node -> context menu (Copy / Add Tag); Add Tag opens the tag popup.
await win.keyboard.press('Escape') // close the offset popup first
await win.waitForTimeout(150)
await win.mouse.click(npos.x, npos.y, { button: 'right' })
await win.waitForSelector('.node-menu', { timeout: 5000 })
const hasAddTag = await win.evaluate(() =>
  [...document.querySelectorAll('.node-menu-item')].some(el => el.textContent === 'Add Tag'))
if (!hasAddTag) throw new Error('right-click menu has no Add Tag item')
await win.waitForTimeout(150)
await shot('03c-node-menu.png')
// Activate Add Tag -> the themed tag popup opens.
await win.evaluate(() =>
  [...document.querySelectorAll('.node-menu-item')].find(el => el.textContent === 'Add Tag')?.click())
await win.waitForSelector('.tag-popup .tag-editor', { timeout: 5000 })
await win.waitForTimeout(150)
await shot('03d-tag-popup.png')
// Save the tag (defaults: category 'root', no note) - this persists via
// persistTags() and flips the run dirty, which the quit-confirm step below
// (step 10) relies on to surface the save-on-close modal.
await win.evaluate(() =>
  [...document.querySelectorAll('.tag-popup button')].find(b => b.textContent === 'Save tag')?.click())
await win.waitForTimeout(300)
await win.keyboard.press('Escape')

// 4. Filtered: has-java_stack only, re-run (omni bar: a `java:yes` chip, no
// standalone checkbox since the omni filter bar redesign).
await win.fill('#f-text', 'java:yes')
await win.press('#f-text', 'Enter')
await win.waitForTimeout(500)
await shot('04-filtered.png')

// 5. Flame view: toggle to the icicle over the filtered set.
await win.click('#tab-flame')
await win.waitForSelector('#flame svg', { timeout: 15000 })
await win.waitForTimeout(400)
await shot('05-flame.png')

// 6. Rules opens as a centered modal (no side panel consumed).
await win.click('#rules-btn')
await win.waitForSelector('.modal-backdrop .modal-head', { timeout: 5000 })
const rulesModal = await win.evaluate(() => document.querySelector('.modal-head .modal-title')?.textContent === 'Rules')
if (!rulesModal) throw new Error('Rules did not open in a modal')
// Round-2 unified chip: rules rows render an uppercase, category-colored `.cat-chip`.
const catChipOk = await win.evaluate(() => {
  const chip = document.querySelector('.modal-body .cat-chip')
  return !!chip && chip.textContent.length > 0 && chip.textContent === chip.textContent.toUpperCase()
})
if (!catChipOk) throw new Error('rules modal did not render an uppercase .cat-chip (unified chip)')
await shot('07-rules-modal.png')
await win.keyboard.press('Escape')

// 6b. Suggestions opens as a centered modal with Confirm / Reject rows.
await win.click('#suggest-btn')
await win.waitForSelector('.modal-backdrop .modal-body .sug-row', { timeout: 5000 })
const suggestModal = await win.evaluate(() => document.querySelector('.modal-head .modal-title')?.textContent === 'Suggestions')
if (!suggestModal) throw new Error('Suggestions did not open in a modal')
await win.waitForTimeout(200)
await shot('06b-suggestions.png')
await win.keyboard.press('Escape')

// 6c. Capture as a centered modal, opened directly from its rail button (the
// rail shell has no File menu to open first).
await win.click('#file-capture')
await win.waitForSelector('.modal-backdrop .modal', { timeout: 5000 })
const capOk = await win.evaluate(() => {
  const sel = document.querySelector('.modal-body #cap-select')
  return !!sel && sel.options.length > 0
})
if (!capOk) throw new Error('Capture modal capability dropdown is empty (wireCapture did not run against the attached DOM)')
await shot('06-capture-modal.png')
await win.keyboard.press('Escape')

// 6d. Open modal (round-3): two full-width `.modal-menu-item` icon rows.
await win.click('#file-open')
await win.waitForSelector('.modal-backdrop .modal-menu-item', { timeout: 5000 })
const openRows = await win.evaluate(() => {
  const rows = [...document.querySelectorAll('.modal-body .modal-menu-item')]
  return rows.length === 2 && !!document.getElementById('open-run') && !!document.getElementById('open-project') &&
    rows.every(r => !!r.querySelector('svg use'))
})
if (!openRows) throw new Error('Open modal did not render two icon rows (open-run / open-project)')
await shot('06d-open-modal.png')
await win.keyboard.press('Escape')

// 6e. Export modal (round-3): three icon rows (Markdown / JSON / Save project).
await win.click('#export-btn')
await win.waitForSelector('.modal-backdrop .modal-menu-item', { timeout: 5000 })
const exportRows = await win.evaluate(() => {
  const rows = [...document.querySelectorAll('.modal-body .modal-menu-item')]
  return rows.length === 3 && !!document.getElementById('export-md') &&
    !!document.getElementById('export-json') && !!document.getElementById('save-project')
})
if (!exportRows) throw new Error('Export modal did not render three icon rows')
await shot('06e-export-modal.png')
await win.keyboard.press('Escape')

// 6f. Diff modal (round-3): a single Load-run-B icon row, and - crucially - the
// Mode filter is NOT present before run B loads (post-load-only deferral).
await win.click('#diff-btn')
await win.waitForSelector('.modal-backdrop .modal-menu-item', { timeout: 5000 })
const diffPreload = await win.evaluate(() => {
  const rows = document.querySelectorAll('.modal-body .modal-menu-item')
  return rows.length === 1 && !!document.getElementById('load-run-b') &&
    document.getElementById('diff-mode') === null // Mode hidden until run B loads
})
if (!diffPreload) throw new Error('Diff modal pre-load state wrong (expected only Load run B, no Mode select)')
await shot('06f-diff-modal.png')
await win.keyboard.press('Escape')

// 7. Theme toggle. Round-3: rail-aware - collapsed rail shows a single
// `.theme-mini` glyph of the current theme; hovering the rail expands it and
// reveals the full `.theme-pill`. Verify the DOM has both, the mini tracks the
// theme, and the toggle flips the applied theme.
const pillOk = await win.evaluate(() =>
  !!document.querySelector('#theme-toggle .theme-pill') && !!document.querySelector('#theme-toggle .theme-mini use'))
if (!pillOk) throw new Error('#theme-toggle missing .theme-pill or .theme-mini glyph')
await win.click('#tab-graph')
// Collapsed rail: mini glyph visible, pill hidden. Move the mouse off the rail
// so it stays at its 46px collapsed width for the shot.
await win.mouse.move(700, 400)
await win.waitForTimeout(200)
const collapsedThemeOk = await win.evaluate(() => {
  const mini = document.querySelector('#theme-toggle .theme-mini')
  const pill = document.querySelector('#theme-toggle .theme-pill')
  return getComputedStyle(mini).display !== 'none' && getComputedStyle(pill).display === 'none' &&
    document.querySelector('#theme-toggle .theme-mini use')?.getAttribute('href') === '#i-moon' // dark
})
if (!collapsedThemeOk) throw new Error('collapsed theme toggle should show the mini moon glyph, not the pill')
await shot('07a-theme-collapsed.png')
// Expanded rail (hover): pill visible, mini hidden.
await win.hover('#rail')
await win.waitForTimeout(250)
const expandedThemeOk = await win.evaluate(() => {
  const mini = document.querySelector('#theme-toggle .theme-mini')
  const pill = document.querySelector('#theme-toggle .theme-pill')
  return getComputedStyle(pill).display === 'flex' && getComputedStyle(mini).display === 'none'
})
if (!expandedThemeOk) throw new Error('expanded (rail-hover) theme toggle should show the pill, not the mini glyph')
await shot('07b-theme-expanded.png')
// Flip to light and confirm the pill state + mini glyph both follow.
await win.click('#theme-toggle')
await win.waitForTimeout(300)
const lightOk = await win.evaluate(() =>
  document.documentElement.getAttribute('data-theme') === 'light' &&
  document.querySelector('#theme-toggle .theme-pill')?.classList.contains('light') &&
  document.querySelector('#theme-toggle .theme-mini use')?.getAttribute('href') === '#i-sun')
if (!lightOk) throw new Error('theme toggle did not apply light theme to pill + mini glyph')
await shot('07-light-theme.png')
await win.click('#theme-toggle') // back to dark
await win.mouse.move(700, 400)   // un-hover the rail

// 8. Dismiss the detail panel (its X), then collapse the table via the floating tab.
await win.click('#side-close')          // hide the right detail panel
await win.click('#tab-left')            // collapse the master table to its outer edge
await win.waitForTimeout(200)
await shot('08-collapsed.png')
await win.click('#tab-left')            // expand the table back

// 9. Resize the table panel by dragging its handle right, then zoom the graph.
const widthBefore = await win.evaluate(() =>
  getComputedStyle(document.getElementById('main')).getPropertyValue('--table-w').trim())
const hb = await win.evaluate(() => {
  const h = document.querySelector('.resize-handle[data-resize="table"]')
  const r = h.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
await win.mouse.move(hb.x, hb.y)
await win.mouse.down()
await win.mouse.move(hb.x + 140, hb.y, { steps: 8 })
await win.mouse.up()
await win.waitForTimeout(100)
const widthAfter = await win.evaluate(() =>
  getComputedStyle(document.getElementById('main')).getPropertyValue('--table-w').trim())
// Fail loudly instead of emitting a screenshot that silently proves nothing.
if (widthAfter === widthBefore) {
  throw new Error(`resize drag no-op: --table-w unchanged at ${widthBefore}`)
}
console.log(`resize: --table-w ${widthBefore} -> ${widthAfter}`)
await win.click('#zoom-in')
await win.click('#zoom-in')
await win.waitForTimeout(300)
await shot('09-resized-zoomed.png')

// 10. Native Libraries view. The primary fixture above carries no lib/unlib
// events, so a dedicated fixture (mapped libc + libsentinel, plus a third
// library that unmaps) is loaded in its own short-lived instance to actually
// exercise the populated table - a fresh app + userData dir keeps it decoupled
// from the stateful walkthrough above (which stays open for the quit step below).
const libFixture = resolve(root, 'tests/fixtures/lib-sample.jsonl')
const libUserDataDir = mkdtempSync(resolve(tmpdir(), 'ares-desktop-shots-libs-'))
const libApp = await electron.launch({
  args: [resolve(root, 'out/main/index.js'), '--no-sandbox', '--disable-gpu', `--user-data-dir=${libUserDataDir}`],
  env: { ...process.env, ARES_OPEN_FILE: libFixture },
})
const libWin = await libApp.firstWindow()
await libWin.setViewportSize({ width: 1400, height: 900 })
await libWin.waitForSelector('#table table tr', { timeout: 30000 })
await libWin.waitForTimeout(300)

const libTabOk = await libWin.evaluate(() => !!document.getElementById('tab-libs')?.querySelector('svg use'))
if (!libTabOk) throw new Error('#tab-libs rail item missing its inline svg icon')

await libWin.click('#tab-libs')
await libWin.waitForSelector('#libs table tbody tr', { timeout: 10000 })
await libWin.waitForTimeout(300)

const libRowsOk = await libWin.evaluate(() => {
  const rows = [...document.querySelectorAll('#libs .lib-tbl tbody tr')]
  const names = rows.map(r => r.querySelector('.lib-name')?.textContent)
  return rows.length === 3 && names.includes('libc.so') && names.includes('libsentinel.so') &&
    names.includes('libunmapped.so') && rows.at(-1)?.classList.contains('unmap') === true
})
if (!libRowsOk) throw new Error('Libraries table did not render libc/libsentinel/libunmapped with the last row struck through')

const libDockOk = await libWin.evaluate(() => document.querySelector('#libs .lib-dock')?.classList.contains('collapsed') === true)
if (!libDockOk) throw new Error('artifacts dock should start collapsed')

await libWin.mouse.move(700, 400) // off #rail so the hover-expanded (172px) rail doesn't clip the shot
await libWin.waitForTimeout(150)
await libWin.screenshot({ path: resolve(shots, '10-libraries.png') })
console.log('captured', '10-libraries.png')

await libApp.close()
try {
  rmSync(libUserDataDir, { recursive: true, force: true })
} catch (e) {
  console.warn('Failed to clean up temp directory:', e.message)
}

// 11. Quit rail item (round-2: new #app-quit, above #theme-toggle) - the very
// last step. Clicking it on a dirty run (the tag saved in step 3d) intercepts
// window-close and surfaces the save-on-close confirm modal instead of exiting.
// Capture it, then hit "Don't Save" so the app closes itself.
const quitOk = await win.evaluate(() => !!document.getElementById('app-quit'))
if (!quitOk) throw new Error('#app-quit rail item missing')
await win.click('#app-quit')
await win.waitForSelector('.modal-backdrop .modal-head', { timeout: 5000 })
const closeModalTitle = await win.evaluate(() => document.querySelector('.modal-head .modal-title')?.textContent)
if (closeModalTitle !== 'Unsaved project changes') {
  throw new Error(`quit did not surface the save-on-close confirm modal (got title: ${closeModalTitle})`)
}
await shot('11-quit-confirm.png')
const dismissed = await win.evaluate(() => {
  const btn = [...document.querySelectorAll('.modal-body button')].find(b => b.textContent === "Don't Save")
  if (!btn) return false
  btn.click()
  return true
})
if (!dismissed) throw new Error("save-on-close modal had no Don't Save button")
// "Don't Save" answers the confirm with 'close', so main quits the window itself.
await app.waitForEvent('close')

// Clean up the main temp userData directory
try {
  rmSync(userDataDir, { recursive: true, force: true })
} catch (e) {
  console.warn('Failed to clean up temp directory:', e.message)
}

console.log('done')
