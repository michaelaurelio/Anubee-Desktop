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
const fixture = resolve(root, 'tests/fixtures/sample.jsonl')

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

// 2. A bridge selected: the focused java -> native -> syscall subgraph.
await win.click('#table table tr:nth-child(2)') // first data row (row 1 is header)
await win.waitForSelector('#cy canvas', { timeout: 15000 })
await win.waitForTimeout(1200) // let ELK layout settle

// Nodes render as non-draggable round-rectangle boxes (task 6: node-box redesign).
const boxOk = await win.evaluate(() => {
  const cy = window.__cy
  const n = cy.nodes()[0]
  return n && n.style('shape') === 'round-rectangle' && !n.grabbable()
})
if (!boxOk) throw new Error('nodes are not non-draggable round-rectangle boxes')

await shot('02-subgraph.png')

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

// 4. Filtered: has-java_stack only, re-run.
await win.check('#f-hasjava')
await win.click('#apply')
await win.waitForTimeout(500)
await shot('04-filtered.png')

// 5. Flame view: toggle to the icicle over the filtered set.
await win.click('#tab-flame')
await win.waitForSelector('#flame svg', { timeout: 15000 })
await win.waitForTimeout(400)
await shot('05-flame.png')

// 6. Rules panel opens (closes the prior no-Rules-shot backlog gap).
await win.click('#rules-btn')
await win.waitForTimeout(300)
await shot('06-rules-panel.png')
await win.click('#rules-btn') // close

// 7. Light theme via the toggle.
await win.click('#tab-graph')
await win.click('#theme-toggle')
await win.waitForTimeout(300)
await shot('07-light-theme.png')
await win.click('#theme-toggle') // back to dark

// 8. Collapse the side panel, then the table.
await win.click('.panel-chevron[data-target="side"]')
await win.click('.panel-chevron[data-target="table"]')
await win.waitForTimeout(200)
await shot('08-collapsed.png')
await win.click('.panel-chevron[data-target="side"]')  // expand back
await win.click('.panel-chevron[data-target="table"]')

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

await app.close()

// Clean up the temp userData directory
try {
  rmSync(userDataDir, { recursive: true, force: true })
} catch (e) {
  console.warn('Failed to clean up temp directory:', e.message)
}

console.log('done')
