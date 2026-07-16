// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createLibView, type LibViewDeps } from '../src/renderer/native-lib-view'
import type { LibRow } from '@shared/native-lib'

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
    ...over,
  }
  return { host, deps }
}

afterEach(() => { document.body.innerHTML = '' })

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
  it('appends device lines and shows the strip', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    api.appendLog('su: ares: not found')
    const wrap = host.querySelector('[data-log]') as HTMLElement
    expect(wrap.hidden).toBe(false)
    expect(host.querySelector('[data-log-body]')?.textContent).toContain('su: ares: not found')
  })

  it('auto-expands the strip on an error-like line', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    api.appendLog('some benign line')
    expect((host.querySelector('[data-log]') as HTMLElement).classList.contains('collapsed')).toBe(true)
    api.appendLog('error: permission denied')
    expect((host.querySelector('[data-log]') as HTMLElement).classList.contains('collapsed')).toBe(false)
  })

  it('logs stream end', () => {
    const { host, deps } = make()
    const api = createLibView(host, deps)
    api.setSource('live')
    api.streamEnded()
    expect(host.querySelector('[data-log-body]')?.textContent).toContain('stream ended')
  })

  it('records a trailing line after leaving Live mode without re-showing the strip', async () => {
    const { host, deps } = make({ loadedRows: vi.fn(async () => []) })
    const api = createLibView(host, deps)
    api.setSource('live')
    api.setSource('loaded')
    await vi.waitFor(() => expect(deps.loadedRows).toHaveBeenCalled())
    api.appendLog('some trailing line')
    const wrap = host.querySelector('[data-log]') as HTMLElement
    expect(wrap.hidden).toBe(true)
    expect(host.querySelector('[data-log-body]')?.textContent).toContain('some trailing line')
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
