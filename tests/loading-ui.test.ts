// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initLoadingUi, topbar, ingest, graph } from '../src/renderer/loading-ui'

function setupDom(): void {
  document.body.innerHTML = `
    <div id="loadbar" class="hidden"><div id="loadbar-fill"></div></div>
    <div id="toasts"></div>
    <div id="empty-state" class="hidden"></div>
    <div id="table-skeleton" class="hidden"></div>
    <div id="graph-overlay" class="hidden"></div>
  `
  initLoadingUi()
}

const el = (id: string) => document.getElementById(id) as HTMLElement
const hidden = (id: string) => el(id).classList.contains('hidden')

describe('ingest loading state', () => {
  beforeEach(() => {
    setupDom()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('begin shows the bar and skeleton', () => {
    ingest.begin(80_000_000, 80_000)
    expect(hidden('loadbar')).toBe(false)
    expect(hidden('table-skeleton')).toBe(false)
    ingest.end()
  })

  it('phase writes a toast with the phase text', () => {
    ingest.begin(1_000, 80_000)
    ingest.phase('Building view')
    expect(el('toasts').textContent).toContain('Building view')
    ingest.end()
  })

  it('end clears the bar, skeleton, and toast', () => {
    ingest.begin(1_000, 80_000)
    ingest.phase('Reading records')
    ingest.end()
    vi.runAllTimers()
    expect(hidden('loadbar')).toBe(true)
    expect(hidden('table-skeleton')).toBe(true)
    expect(el('toasts').children.length).toBe(0)
  })

  it('fail restores the empty-state, flashes red, and shows an error toast', () => {
    el('empty-state').classList.add('hidden')
    ingest.begin(1_000, 80_000)
    ingest.fail('bad file')
    expect(hidden('empty-state')).toBe(false)          // restored
    expect(hidden('table-skeleton')).toBe(true)         // cleared
    expect(el('loadbar').classList.contains('error')).toBe(true)
    const toast = el('toasts').querySelector('.toast.err')
    expect(toast?.textContent).toContain('bad file')
  })
})

describe('graph loading state', () => {
  beforeEach(setupDom)

  it('begin shows the overlay and sweeping bar', () => {
    graph.begin()
    expect(hidden('graph-overlay')).toBe(false)
    expect(el('loadbar').classList.contains('sweep')).toBe(true)
    graph.end()
  })

  it('end clears the overlay and hides the bar', () => {
    graph.begin()
    graph.end()
    expect(hidden('graph-overlay')).toBe(true)
    expect(hidden('loadbar')).toBe(true)
  })
})

describe('topbar ownership', () => {
  beforeEach(() => {
    setupDom()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a graph sweep does not clear an in-flight ingest bar', () => {
    ingest.begin(80_000_000, 80_000)
    graph.begin()   // must not steal the bar from ingest
    graph.end()     // must not hide the ingest bar
    expect(hidden('loadbar')).toBe(false)
    ingest.end()
    vi.runAllTimers()
    expect(hidden('loadbar')).toBe(true)
  })
})
