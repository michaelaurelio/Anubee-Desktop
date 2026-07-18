// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createLibView, type LibViewDeps } from '../src/renderer/native-lib-view'
import type { LibRow, Modcmp } from '@shared/native-lib'

const row = (over: Partial<LibRow> = {}): LibRow => ({
  library: '/data/app/dev.ares.detector-1/lib/arm64/libsentinel.so', soname: 'libsentinel.so',
  base: '0x1000', end: '0x2000', size: 0x1000, pgoff: 0, inode: 5, pid: 7420, tid: null,
  ppid: 1, seq: 0, unmapped: false, ...over,
})

function make(over: Partial<LibViewDeps> = {}): { host: HTMLElement; deps: LibViewDeps } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const deps: LibViewDeps = {
    loadedRows: vi.fn(async () => []),
    startLive: vi.fn(async () => {}),
    stopLive: vi.fn(async () => {}),
    dumpLib: vi.fn(async () => []),
    reveal: vi.fn(),
    exportArtifact: vi.fn(),
    preflight: vi.fn(async () => [{ id: 'device', label: 'device reachable', ok: true, detail: 'device' }]),
    verify: vi.fn(async () => {}),
    ...over,
  }
  return { host, deps }
}

afterEach(() => { document.body.innerHTML = ''; localStorage.clear() })

// Drives a real grip drag the same way a pointer would: pointerdown on the grip,
// pointermove/pointerup on window (matching the window-level listener pattern in
// native-lib-view.ts and panels.ts). startH is read from the live --dock-h so the
// helper is correct regardless of the dock's current height.
function setDockHeight(host: HTMLElement, target: number): void {
  const grip = host.querySelector('[data-grip]') as HTMLElement
  const dock = host.querySelector('.lib-dock') as HTMLElement
  const cur = dock.style.getPropertyValue('--dock-h')
  const startH = cur ? parseInt(cur, 10) : 180
  grip.dispatchEvent(new PointerEvent('pointerdown', { clientY: 0, bubbles: true }))
  window.dispatchEvent(new PointerEvent('pointermove', { clientY: -(target - startH), bubbles: true }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
}

// Drives the full preflight-modal Begin flow so the view actually enters its
// internal `streaming` state (only reachable this way - `setSource('live')`
// alone does not stream). Used by the Verify tests below to populate rows via
// a real Begin -> [lib] flow, though Verify itself no longer requires
// `streaming` to be true (task B3).
async function beginLiveCapture(host: HTMLElement, pkg = 'dev.ares.detector'): Promise<void> {
  ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
  ;(document.body.querySelector('[data-modal-pkg]') as HTMLInputElement).value = pkg
  ;(document.body.querySelector('[data-modal-refresh]') as HTMLButtonElement).click()
  await vi.waitFor(() =>
    expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(false))
  ;(document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).click()
}

describe('native-lib-view live modal', () => {
  it('hides live controls in loaded mode', () => {
    const { host, deps } = make()
    createLibView(host, deps)
    expect((host.querySelector('[data-live]') as HTMLElement).hidden).toBe(true)
  })

  it('shows the Start-live-capture button in live mode', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    const live = host.querySelector('[data-live]') as HTMLElement
    expect(live.hidden).toBe(false)
    expect(host.querySelector('[data-live-open]')).not.toBeNull()
  })

  it('opens the preflight modal with package input + disabled Begin', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
    expect(document.body.querySelector('[data-modal-pkg]')).not.toBeNull()
    expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables Begin only when every preflight check passes', async () => {
    const { host, deps } = make({
      preflight: vi.fn(async () => [
        { id: 'device', label: 'device reachable', ok: true, detail: 'device' },
        { id: 'root', label: 'root available', ok: true, detail: 'uid 0' },
      ]),
    })
    const api = createLibView(host, deps)
    api.setSource('live')
    ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
    const pkg = document.body.querySelector('[data-modal-pkg]') as HTMLInputElement
    pkg.value = 'dev.ares.detector'
    ;(document.body.querySelector('[data-modal-refresh]') as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(false))
  })

  it('keeps Begin disabled when a check fails', async () => {
    const { host, deps } = make({
      preflight: vi.fn(async () => [{ id: 'root', label: 'root available', ok: false, detail: 'uid 2000' }]),
    })
    const api = createLibView(host, deps)
    api.setSource('live')
    ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
    ;(document.body.querySelector('[data-modal-pkg]') as HTMLInputElement).value = 'dev.ares.detector'
    ;(document.body.querySelector('[data-modal-refresh]') as HTMLButtonElement).click()
    await new Promise(r => setTimeout(r, 0))
    expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Begin calls startLive and enters streaming state', async () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
    ;(document.body.querySelector('[data-modal-pkg]') as HTMLInputElement).value = 'dev.ares.detector'
    ;(document.body.querySelector('[data-modal-refresh]') as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(false))
    ;(document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).click()
    expect(deps.startLive).toHaveBeenCalledWith('dev.ares.detector', undefined)
    expect((host.querySelector('[data-live-on]') as HTMLElement).hidden).toBe(false)
  })
})

describe('native-lib-view on-map glob field', () => {
  it('renders a glob field and boundary hint below the package field', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
    expect(document.body.querySelector('[data-modal-glob]')).not.toBeNull()
    expect(document.body.querySelector('.lib-modal-hint')?.textContent).toMatch(/APK-embedded/)
  })

  it('passes the glob to startLive when Begin is clicked with a safe glob set', async () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
    ;(document.body.querySelector('[data-modal-pkg]') as HTMLInputElement).value = 'dev.ares.detector'
    ;(document.body.querySelector('[data-modal-glob]') as HTMLInputElement).value = 'libexample*'
    ;(document.body.querySelector('[data-modal-refresh]') as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(false))
    ;(document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).click()
    expect(deps.startLive).toHaveBeenCalledWith('dev.ares.detector', 'libexample*')
  })

  it('keeps Begin disabled when the glob has unsafe characters, even after a clean preflight', async () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
    ;(document.body.querySelector('[data-modal-pkg]') as HTMLInputElement).value = 'dev.ares.detector'
    ;(document.body.querySelector('[data-modal-refresh]') as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(false))
    const globIn = document.body.querySelector('[data-modal-glob]') as HTMLInputElement
    globIn.value = "lib'; rm -rf /"
    globIn.dispatchEvent(new Event('input'))
    expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('leaves the glob field empty as valid: Begin stays enabled and startLive is called without a glob', async () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
    ;(document.body.querySelector('[data-modal-pkg]') as HTMLInputElement).value = 'dev.ares.detector'
    ;(document.body.querySelector('[data-modal-refresh]') as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(false))
    ;(document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).click()
    expect(deps.startLive).toHaveBeenCalledWith('dev.ares.detector', undefined)
  })
})

describe('native-lib-view device log', () => {
  it('appends device lines and expands the dock on an error-like line', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    api.appendLog('su: ares: not found')
    const dock = host.querySelector('.lib-dock') as HTMLElement
    expect(dock.classList.contains('collapsed')).toBe(false)
    expect(host.querySelector('[data-log-body]')?.textContent).toContain('su: ares: not found')
  })

  it('auto-expands the dock on an error-like line', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    api.appendLog('some benign line')
    expect((host.querySelector('.lib-dock') as HTMLElement).classList.contains('collapsed')).toBe(true)
    api.appendLog('error: permission denied')
    expect((host.querySelector('.lib-dock') as HTMLElement).classList.contains('collapsed')).toBe(false)
  })

  it('logs stream end', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    api.streamEnded()
    expect(host.querySelector('[data-log-body]')?.textContent).toContain('stream ended')
  })

  it('records a trailing error line after leaving Live mode without expanding the dock', async () => {
    const { host, deps } = make({ loadedRows: vi.fn(async () => []) })
    const api = createLibView(host, deps)
    api.setSource('live')
    api.setSource('loaded')
    await vi.waitFor(() => expect(deps.loadedRows).toHaveBeenCalled())
    api.appendLog('dump failed: trailing error')
    const dock = host.querySelector('.lib-dock') as HTMLElement
    expect(dock.classList.contains('collapsed')).toBe(true)
    expect(host.querySelector('[data-log-body]')?.textContent).toContain('dump failed: trailing error')
  })
})

describe('native-lib-view tabbed dock (task 3)', () => {
  it('tabs switch between artifacts and log without collapsing', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    const dock = host.querySelector('.lib-dock')!
    ;(host.querySelector('[data-dock-collapse]') as HTMLElement).click()   // expand (default is collapsed)
    ;(host.querySelector('[data-tab="log"]') as HTMLElement).click()
    expect(dock.getAttribute('data-active')).toBe('log')
    expect(dock.classList.contains('collapsed')).toBe(false)   // tab click never collapses
  })

  it('the chevron collapses and expands; tabs stay visible when collapsed', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    const dock = host.querySelector('.lib-dock')!
    expect(dock.classList.contains('collapsed')).toBe(true)   // default collapsed
    ;(host.querySelector('[data-dock-collapse]') as HTMLElement).click()
    expect(dock.classList.contains('collapsed')).toBe(false)  // expanded
    expect(host.querySelector('.lib-tabs')).not.toBeNull()      // tab bar still shown
    ;(host.querySelector('[data-dock-collapse]') as HTMLElement).click()
    expect(dock.classList.contains('collapsed')).toBe(true)   // collapsed again
    expect(host.querySelector('.lib-tabs')).not.toBeNull()      // tab bar still shown
  })

  it('an error line red-dots the background tab and auto-expands a collapsed dock, without switching tab', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    const dock = host.querySelector('.lib-dock')!
    expect(dock.classList.contains('collapsed')).toBe(true)   // default collapsed
    api.appendLog('dump failed for pid 7: some error')
    expect(dock.classList.contains('collapsed')).toBe(false)  // error auto-expanded
    expect(dock.getAttribute('data-active')).toBe('artifacts') // did NOT steal the tab
    expect((host.querySelector('[data-tab="log"] .dot-err') as HTMLElement).hidden).toBe(false) // red dot shown
  })

  it('switching to the log tab clears its error dot', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    api.appendLog('dump failed: boom')
    ;(host.querySelector('[data-tab="log"]') as HTMLElement).click()
    expect((host.querySelector('[data-tab="log"] .dot-err') as HTMLElement).hidden).toBe(true)
  })

  it('a non-error live line does not expand a collapsed dock', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    const dock = host.querySelector('.lib-dock')!
    expect(dock.classList.contains('collapsed')).toBe(true)
    api.appendLog('some ordinary device line')
    expect(dock.classList.contains('collapsed')).toBe(true)   // stayed collapsed
  })
})

describe('native-lib-view dock resize + persistence (task 4)', () => {
  it('persists dock height/collapsed/activeTab across a re-mount', () => {
    localStorage.clear()
    const { host, deps } = make()
    createLibView(host, deps)
    ;(host.querySelector('[data-dock-collapse]') as HTMLElement).click()  // expand (default is collapsed)
    ;(host.querySelector('[data-tab="log"]') as HTMLElement).click()
    setDockHeight(host, 260)
    host.innerHTML = ''                       // unmount
    createLibView(host, deps)                 // remount reads localStorage
    const dock = host.querySelector('.lib-dock') as HTMLElement
    expect(dock.getAttribute('data-active')).toBe('log')
    expect(dock.classList.contains('collapsed')).toBe(false)
    expect(dock.style.getPropertyValue('--dock-h')).toBe('260px')
  })

  it('clamps a dragged height to MAX_H so the dock cannot crush the table', () => {
    localStorage.clear()
    const { host, deps } = make()
    createLibView(host, deps)
    ;(host.querySelector('[data-dock-collapse]') as HTMLElement).click()  // expand
    setDockHeight(host, 9999)
    const dock = host.querySelector('.lib-dock') as HTMLElement
    expect(dock.style.getPropertyValue('--dock-h')).toBe('520px')
  })
})

describe('native-lib-view empty states', () => {
  it('shows the loaded empty-state when a run has no libraries', async () => {
    const { host, deps } = make({ loadedRows: vi.fn(async () => []) })
    const api = createLibView(host, deps)
    api.setSource('loaded')
    await vi.waitFor(() =>
      expect(host.querySelector('.lib-empty')?.textContent).toContain('No library records'))
  })

  it('shows the live waiting empty-state after Begin with no rows yet', async () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
    ;(document.body.querySelector('[data-modal-pkg]') as HTMLInputElement).value = 'dev.ares.detector'
    ;(document.body.querySelector('[data-modal-refresh]') as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(false))
    ;(document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).click()
    expect(host.querySelector('.lib-empty')?.textContent).toContain('Waiting for')
  })

  it('hides the empty-state once rows are present', async () => {
    const { host, deps } = make({ loadedRows: vi.fn(async () => [row()]) })
    const api = createLibView(host, deps)
    api.setSource('loaded')
    await vi.waitFor(() => expect(host.querySelector('.lib-tbl tbody tr')).not.toBeNull())
    expect(host.querySelector('.lib-empty')).toBeNull()
  })
})

describe('native-lib-view source switching (review fix 1)', () => {
  it('stops the live stream on leaving Live mode, and a stale live event after the switch cannot land a row', async () => {
    const { host, deps } = make({ loadedRows: vi.fn(async () => []) })
    const api = createLibView(host, deps)
    api.setSource('live')
    ;(host.querySelector('[data-live-open]') as HTMLButtonElement).click()
    ;(document.body.querySelector('[data-modal-pkg]') as HTMLInputElement).value = 'dev.ares.detector'
    ;(document.body.querySelector('[data-modal-refresh]') as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect((document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).disabled).toBe(false))
    ;(document.body.querySelector('[data-modal-begin]') as HTMLButtonElement).click()
    expect(deps.startLive).toHaveBeenCalledWith('dev.ares.detector', undefined)

    api.setSource('loaded')
    await vi.waitFor(() => expect(deps.stopLive).toHaveBeenCalled())

    // A [lib] event that arrives after the switch (stream-end already in flight)
    // must not inject a row into what is now the Loaded table.
    api.applyMapped({
      kind: 'lib', library: '/data/app/dev.ares.detector-1/lib/arm64/libc.so', soname: 'libc.so',
      start: '0x3000', end: '0x4000', pid: 7420, ppid: 1, atMs: 2000,
    })
    expect(host.querySelectorAll('.lib-tbl tbody tr').length).toBe(0)
  })
})

describe('native-lib-view refresh (review fix 1)', () => {
  it('re-fetches loaded rows when the source is loaded', async () => {
    const { host, deps } = make({ loadedRows: vi.fn(async () => []) })
    const api = createLibView(host, deps)
    await vi.waitFor(() => expect(deps.loadedRows).toHaveBeenCalledTimes(1))
    api.refresh()
    await vi.waitFor(() => expect(deps.loadedRows).toHaveBeenCalledTimes(2))
  })

  it('does nothing when the source is live', async () => {
    const { host, deps } = make({ loadedRows: vi.fn(async () => []) })
    const api = createLibView(host, deps)
    await vi.waitFor(() => expect(deps.loadedRows).toHaveBeenCalledTimes(1))
    api.setSource('live')
    api.refresh()
    await new Promise(r => setTimeout(r, 0))
    expect(deps.loadedRows).toHaveBeenCalledTimes(1)
  })
})

describe('native-lib-view dump button', () => {
  it('dumping a ticked row calls dumpLib with its exact pid+base, not a name', async () => {
    const calls: Array<[number, string]> = []
    const { host, deps } = make({ dumpLib: async (pid, base) => { calls.push([pid, base]); return [] } })
    const api = createLibView(host, deps)
    api.setSource('live')
    api.applyMapped({
      kind: 'lib', pid: 25659, ppid: 1, start: '0x7281a0000', end: '0x7281c0000',
      library: '/data/app/base.apk', atMs: 4300,
    })
    const cb = host.querySelector('input[data-k="25659|0x7281a0000"]') as HTMLInputElement
    cb.click()
    ;(host.querySelector('[data-dump]') as HTMLButtonElement).click()
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toEqual([[25659, '0x7281a0000']])
  })
})

describe('native-lib-view dump checkbox eligibility (review fix 3)', () => {
  it('omits the dump checkbox for a bracketed pseudo-path row, keeps it for a real on-disk file row', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    api.applyMapped({
      kind: 'lib', library: '[anon_shmem:dalvik-jit-code-cache]', start: '0x5000', end: '0x6000',
      pid: 7420, ppid: 1, atMs: 2000,
    })
    api.applyMapped({
      kind: 'lib', library: '/data/app/dev.ares.detector-1/lib/arm64/libsentinel.so', soname: 'libsentinel.so',
      start: '0x7000', end: '0x8000', pid: 7420, ppid: 1, atMs: 2000,
    })
    const rows = [...host.querySelectorAll('.lib-tbl tbody tr')]
    const pseudoRow = rows.find(r => r.getAttribute('title') === '[anon_shmem:dalvik-jit-code-cache]')
    const fileRow = rows.find(r => r.getAttribute('title') === '/data/app/dev.ares.detector-1/lib/arm64/libsentinel.so')
    expect(pseudoRow?.querySelector('input[type=checkbox]')).toBeNull()
    expect(fileRow?.querySelector('input[type=checkbox]')).not.toBeNull()
  })
})

describe('native-lib-view MODIFIED / NO FILE badges from dump --check verdicts', () => {
  const cm = (over: Partial<Modcmp> = {}): Modcmp => ({
    module: 'm', path: 'p', base: '0x1', pid: 7, state: 'match', memSha256: null, fileSha256: null, ...over,
  })

  it('renders MODIFIED for differ and NO FILE for nofile, nothing for the rest', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    const map = (pid: number, base: string) => api.applyMapped({ kind: 'lib', pid, ppid: 1, start: base, end: base, library: '/x', atMs: 4300 })
    map(7, '0x1'); map(7, '0x2'); map(7, '0x3'); map(7, '0x4')
    api.applyCheck([
      cm({ base: '0x1', state: 'differ', memSha256: 'a', fileSha256: 'b' }),
      cm({ base: '0x2', state: 'nofile' }),
      cm({ base: '0x3', state: 'match', memSha256: 'a', fileSha256: 'a' }),
      cm({ base: '0x4', state: 'unreadable' }),
    ], 5000)
    const html = host.querySelector('.lib-tbl tbody')!.innerHTML
    expect(html).toContain('MODIFIED'); expect(html).toContain('NO FILE')
    // The false-MODIFIED guard: match and unreadable get NO badge.
    expect((html.match(/MODIFIED/g) ?? []).length).toBe(1)
    expect((html.match(/NO FILE/g) ?? []).length).toBe(1)
  })

  it('joins a verdict to its row by pid+base numerically, not by module name', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    // APK-embedded: the row is at 0x7281a0000; the verdict.module is "base.apk".
    api.applyMapped({ kind: 'lib', pid: 7, ppid: 1, start: '0x7281a0000', end: '0x7281c0000', library: '/data/app/base.apk', atMs: 4300 })
    api.applyCheck([cm({ module: 'base.apk', path: '/data/app/base.apk', base: '0x7281a0000', state: 'differ', memSha256: 'a', fileSha256: 'b' })], 5000)
    expect(host.querySelector('.lib-tbl tbody')!.innerHTML).toContain('MODIFIED')
  })

  it('a base that differs only in formatting still joins (BigInt compare)', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    api.applyMapped({ kind: 'lib', pid: 7, ppid: 1, start: '0x0b0', end: '0xc0', library: '/x', atMs: 4300 })
    api.applyCheck([cm({ base: '0xb0', state: 'differ', memSha256: 'a', fileSha256: 'b' })], 5000)
    expect(host.querySelector('.lib-tbl tbody')!.innerHTML).toContain('MODIFIED')
  })

  it('records a clean -> modified transition as an evidence trail', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    api.applyMapped({ kind: 'lib', pid: 7, ppid: 1, start: '0x1', end: '0x2', library: '/x', atMs: 4300 })
    api.applyCheck([cm({ base: '0x1', state: 'match', memSha256: 'a', fileSha256: 'a' })], 4300)
    api.applyCheck([cm({ base: '0x1', state: 'differ', memSha256: 'c', fileSha256: 'a' })], 31000)
    const row = host.querySelector('.lib-tbl tbody tr[data-k="7|0x1"]') as HTMLElement
    expect(row.title).toMatch(/clean.*->.*modified/i)
  })

  it('no longer renders a NEW badge or an "N new since start" stat', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    api.applyMapped({ kind: 'lib', pid: 7, ppid: 1, start: '0x1', end: '0x2', library: '/x', atMs: 9999 })
    expect(host.innerHTML).not.toMatch(/\bnew\b/i)
  })

  it('withholds the badge for a first-seen apk verdict (baseline unresolved) - the false-MODIFIED guard', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    api.applyMapped({ kind: 'lib', pid: 7, ppid: 1, start: '0x1', end: '0x2', library: '/x', atMs: 4300 })
    api.applyCheck([cm({ base: '0x1', state: 'apk', memSha256: null, fileSha256: null })], 5000)
    const row = host.querySelector('.lib-tbl tbody tr[data-k="7|0x1"]') as HTMLElement
    expect(row.querySelector('.lib-badge')).toBeNull()
  })

  it('joins a differ verdict only to its exact row - the sibling row at an adjacent base is never badged', () => {
    // Pin the join target precisely: two rows for the same pid at adjacent
    // bases must not cross-contaminate - only the checked row gets the badge,
    // and the sibling row (never checked) stays unbadged.
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    api.applyMapped({ kind: 'lib', pid: 7, ppid: 1, start: '0x1', end: '0x2', library: '/x', atMs: 4300 })
    api.applyMapped({ kind: 'lib', pid: 7, ppid: 1, start: '0x2', end: '0x3', library: '/y', atMs: 4300 })
    api.applyCheck([cm({ base: '0x1', state: 'differ', memSha256: 'a', fileSha256: 'b' })], 5000)
    const checked = host.querySelector('.lib-tbl tbody tr[data-k="7|0x1"]') as HTMLElement
    const sibling = host.querySelector('.lib-tbl tbody tr[data-k="7|0x2"]') as HTMLElement
    expect(checked.querySelector('.lib-badge.mod')).not.toBeNull()
    expect(sibling.querySelector('.lib-badge')).toBeNull()
  })

  it('a differ verdict that later heals to match clears the MODIFIED badge but keeps the trail honest at the first-seen differ baseline', () => {
    // The healing transition: differ (t+5.0s) -> match (t+31.0s). checkState
    // must move to match (badge gone), while baselineState stays frozen at
    // the first-seen differ, so the trail reads "modified -> clean" - a
    // genuine baseline -> latest change, not a silently erased history.
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    api.applyMapped({ kind: 'lib', pid: 7, ppid: 1, start: '0x1', end: '0x2', library: '/x', atMs: 4300 })
    api.applyCheck([cm({ base: '0x1', state: 'differ', memSha256: 'a', fileSha256: 'b' })], 5000)
    const afterDiffer = host.querySelector('.lib-tbl tbody tr[data-k="7|0x1"]') as HTMLElement
    expect(afterDiffer.querySelector('.lib-badge.mod')).not.toBeNull()

    api.applyCheck([cm({ base: '0x1', state: 'match', memSha256: 'a', fileSha256: 'a' })], 31000)
    const afterMatch = host.querySelector('.lib-tbl tbody tr[data-k="7|0x1"]') as HTMLElement
    expect(afterMatch.querySelectorAll('.lib-badge.mod').length).toBe(0)
    expect(afterMatch.title).toMatch(/modified.*->.*clean/i)
  })

  it('renders a "N modified" stat computed from differ rows, not a hand-fixed count', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    api.applyMapped({ kind: 'lib', pid: 7, ppid: 1, start: '0x1', end: '0x2', library: '/x', atMs: 4300 })
    api.applyMapped({ kind: 'lib', pid: 7, ppid: 1, start: '0x2', end: '0x3', library: '/y', atMs: 4300 })
    api.applyCheck([
      cm({ base: '0x1', state: 'differ', memSha256: 'a', fileSha256: 'b' }),
      cm({ base: '0x2', state: 'match', memSha256: 'a', fileSha256: 'a' }),
    ], 5000)
    expect(host.querySelector('[data-stat]')!.textContent).toContain('1 modified')
  })
})

describe('native-lib-view Verify button (task 5)', () => {
  it('calls verify with the streaming pid and every dumpable base when nothing is ticked', async () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    await beginLiveCapture(host) // populate rows via a real live [lib] flow (Verify itself no longer requires streaming)
    api.applyMapped({ kind: 'lib', pid: 42, ppid: 1, start: '0x1', end: '0x2', library: '/x', atMs: 100 })
    // a pseudo-path row is not dumpable and must be excluded from the "all" set
    api.applyMapped({ kind: 'lib', pid: 42, ppid: 1, start: '0x2', end: '0x3', library: '[anon_shmem:x]', atMs: 100 })
    api.applyMapped({ kind: 'lib', pid: 42, ppid: 1, start: '0x3', end: '0x4', library: '/y', atMs: 100 })
    ;(host.querySelector('[data-verify]') as HTMLButtonElement).click()
    expect(deps.verify).toHaveBeenCalledTimes(1)
    expect(deps.verify).toHaveBeenCalledWith(42, ['0x1', '0x3'])
  })

  it('calls verify with only the ticked subset when some rows are selected', async () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    await beginLiveCapture(host)
    api.applyMapped({ kind: 'lib', pid: 42, ppid: 1, start: '0x1', end: '0x2', library: '/x', atMs: 100 })
    api.applyMapped({ kind: 'lib', pid: 42, ppid: 1, start: '0x2', end: '0x3', library: '/y', atMs: 100 })
    ;(host.querySelector('input[data-k="42|0x1"]') as HTMLInputElement).click()
    ;(host.querySelector('[data-verify]') as HTMLButtonElement).click()
    expect(deps.verify).toHaveBeenCalledTimes(1)
    expect(deps.verify).toHaveBeenCalledWith(42, ['0x1'])
  })

  it('does nothing when there are no live rows yet', async () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    await beginLiveCapture(host)
    ;(host.querySelector('[data-verify]') as HTMLButtonElement).click()
    expect(deps.verify).not.toHaveBeenCalled()
  })

  it('keeps the selection bar hidden in loaded mode so Verify is unreachable, and never calls verify there', async () => {
    const { host, deps } = make({ loadedRows: vi.fn(async () => [row()]) })
    const api = createLibView(host, deps)
    await vi.waitFor(() => expect(host.querySelector('.lib-tbl tbody tr')).not.toBeNull())
    expect((host.querySelector('[data-selbar]') as HTMLElement).hidden).toBe(true)
    expect(deps.verify).not.toHaveBeenCalled()
  })
})

describe('native-lib-view selection bar (task 2)', () => {
  it('shows the selection bar only when rows are ticked, with Dump + Verify + Clear', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    api.applyMapped({ kind: 'lib', pid: 7, start: '0x1', end: '0x2', library: '/x/liba.so', atMs: 100 })
    // nothing ticked -> the bar exists (toggled via [hidden], not removed) but stays hidden
    expect((host.querySelector('.lib-selbar') as HTMLElement).hidden).toBe(true)
    ;(host.querySelector('input[data-k="7|0x1"]') as HTMLInputElement).click()
    const bar = host.querySelector('.lib-selbar') as HTMLElement
    expect(bar.hidden).toBe(false)
    expect(bar.textContent).toMatch(/1 selected/)
    expect(bar.querySelector('[data-dump]')).not.toBeNull()
    expect(bar.querySelector('[data-verify]')).not.toBeNull()
    expect(bar.querySelector('[data-clear]')).not.toBeNull()
  })

  it('Clear unticks every row and hides the selection bar', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps); api.setSource('live')
    api.applyMapped({ kind: 'lib', pid: 7, start: '0x1', end: '0x2', library: '/x/liba.so', atMs: 100 })
    ;(host.querySelector('input[data-k="7|0x1"]') as HTMLInputElement).click()
    ;(host.querySelector('[data-clear]') as HTMLElement).click()
    expect((host.querySelector('.lib-selbar') as HTMLElement).hidden).toBe(true)
  })

  it('loaded mode has no selection bar and the stat row reads "N libraries"', async () => {
    const { host, deps } = make({ loadedRows: vi.fn(async () => []) })
    const api = createLibView(host, deps); api.setSource('loaded')
    await vi.waitFor(() => expect(host.querySelector('[data-stat]')!.textContent).toMatch(/librar/i))
    expect((host.querySelector('.lib-selbar') as HTMLElement).hidden).toBe(true)
  })

  it('calls verify even when the view is live-source but not currently streaming (post-stop)', () => {
    // task B3: a memory-vs-disk check is point-in-time and does not need a live
    // stream - Verify must work against the last-known rows after Stop, not
    // just while streaming is true.
    const verified: unknown[] = []
    const { host, deps } = make({ verify: async (...a) => { verified.push(a) } })
    const api = createLibView(host, deps); api.setSource('live')
    api.applyMapped({ kind: 'lib', pid: 7, start: '0x1', end: '0x2', library: '/x/liba.so', atMs: 100 })
    ;(host.querySelector('input[data-k="7|0x1"]') as HTMLInputElement).click()
    ;(host.querySelector('[data-verify]') as HTMLElement).click()
    expect(verified).toEqual([[7, ['0x1']]])
  })
})
