// Single owner of all loading DOM state: the window-top bar (determinate-estimated
// for ingest, indeterminate sweep for graph), the table skeleton, the graph
// overlay spinner, and corner toasts. Pace math lives in @shared/ingest-estimate;
// this module only writes the DOM. See the loading-feedback spec.
import { estimateMs, shownFraction } from '@shared/ingest-estimate'

let loadbar: HTMLElement | null = null
let loadbarFill: HTMLElement | null = null
let toasts: HTMLElement | null = null
let skeleton: HTMLElement | null = null
let overlay: HTMLElement | null = null
let emptyState: HTMLElement | null = null

// Who owns the top bar right now, so a graph click can't clear an ingest bar.
type Owner = 'none' | 'ingest' | 'graph'
let owner: Owner = 'none'

// ingest animation state
let raf = 0
let startTime = 0
let estTotal = 0
let phaseToast: HTMLElement | null = null

export function initLoadingUi(): void {
  loadbar = document.getElementById('loadbar')
  loadbarFill = document.getElementById('loadbar-fill')
  toasts = document.getElementById('toasts')
  skeleton = document.getElementById('table-skeleton')
  overlay = document.getElementById('graph-overlay')
  emptyState = document.getElementById('empty-state')
}

function show(elm: HTMLElement | null): void { elm?.classList.remove('hidden') }
function hide(elm: HTMLElement | null): void { elm?.classList.add('hidden') }

function addToast(text: string, isError: boolean): HTMLElement {
  const t = document.createElement('div')
  t.className = 'toast' + (isError ? ' err' : '')
  const span = document.createElement('span')
  span.className = 'msg'
  span.textContent = text
  t.appendChild(span)
  const x = document.createElement('button')
  x.className = 'tx'
  x.textContent = '×' // multiplication sign as a close glyph
  x.addEventListener('click', () => t.remove())
  t.appendChild(x)
  toasts?.appendChild(t)
  return t
}

// ---- top bar ----
export const topbar = {
  sweep(): void {
    if (!loadbar) return
    owner = 'graph'
    loadbar.classList.remove('error')
    loadbar.classList.add('sweep')
    show(loadbar)
  },
  flashError(): void {
    if (!loadbar) return
    loadbar.classList.remove('sweep')
    loadbar.classList.add('error')
    show(loadbar)
    setTimeout(() => { if (owner === 'none') hide(loadbar!) }, 900)
  },
  hide(): void {
    if (!loadbar) return
    loadbar.classList.remove('sweep', 'error')
    if (loadbarFill) loadbarFill.style.width = '0%'
    hide(loadbar)
  },
}

function stopRaf(): void {
  if (raf) { cancelAnimationFrame(raf); raf = 0 }
}

function frame(): void {
  if (owner !== 'ingest' || !loadbarFill) return
  const elapsed = performance.now() - startTime
  loadbarFill.style.width = (shownFraction(elapsed, estTotal) * 100).toFixed(1) + '%'
  raf = requestAnimationFrame(frame)
}

// ---- ingest (determinate-estimated) ----
export const ingest = {
  begin(fileBytes: number, throughput: number): void {
    owner = 'ingest'
    estTotal = estimateMs(fileBytes, throughput)
    startTime = performance.now()
    if (loadbar) { loadbar.classList.remove('sweep', 'error'); show(loadbar) }
    if (loadbarFill) loadbarFill.style.width = '0%'
    show(skeleton)
    phaseToast = addToast('Reading records', false)
    stopRaf()
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame)
  },
  phase(text: string): void {
    if (phaseToast) {
      const msg = phaseToast.querySelector('.msg')
      if (msg) msg.textContent = text
    } else {
      phaseToast = addToast(text, false)
    }
  },
  end(): void {
    stopRaf()
    if (loadbarFill) loadbarFill.style.width = '100%'
    owner = 'none'
    // brief fill-to-100 before clearing (silent success)
    setTimeout(() => { if (owner === 'none') topbar.hide() }, 200)
    hide(skeleton)
    phaseToast?.remove()
    phaseToast = null
  },
  fail(msg: string): void {
    stopRaf()
    owner = 'none'
    hide(skeleton)
    phaseToast?.remove()
    phaseToast = null
    show(emptyState)          // restore "No run loaded" so the canvas is not blank
    topbar.flashError()
    addToast('Failed to load: ' + msg, true)
  },
}

// ---- graph (indeterminate sweep + overlay) ----
export const graph = {
  begin(): void {
    // do not steal the bar from an in-flight ingest
    if (owner !== 'ingest') topbar.sweep()
    show(overlay)
  },
  end(): void {
    hide(overlay)
    if (owner === 'graph') { owner = 'none'; topbar.hide() }
  },
}
