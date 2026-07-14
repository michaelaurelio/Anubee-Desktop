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
    expect(deps.startLive).toHaveBeenCalledWith('dev.ares.detector')
    expect((host.querySelector('[data-live-on]') as HTMLElement).hidden).toBe(false)
  })
})
