// Native Libraries view: loaded-run table + live device stream + artifacts
// dock. Pure DOM controller, no framework - mirrors flame-view/table's style.

import { NEW_LIB_SETTLE_MS, type LibRow, type LibLine, type Artifact } from '@shared/native-lib'
import { showModal, closeModal } from './modal'
import { isSafeToken } from '@shared/tracer-caps'
import { makeEpoch } from './selection-epoch'
import { renderPreflightRow, type PreflightCheck } from './capture-view'

type Source = 'loaded' | 'live'
const key = (pid: number, base: string): string => `${pid}|${base}`
const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

function humanBytes(n: number): string {
  if (!n) return '-'
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

export interface LibViewApi {
  setSource(s: Source): void
  applyMapped(l: LibLine & { atMs: number }): void
  applyUnmapped(l: LibLine & { atMs: number }): void
  applyPreflightCheck(c: PreflightCheck): void
  addArtifacts(a: Artifact[]): void
  appendLog(line: string): void
  streamEnded(): void
}

export interface LibViewDeps {
  loadedRows: () => Promise<LibRow[]>
  startLive: (pkg: string) => Promise<void>
  stopLive: () => Promise<void>
  dumpLib: (pid: number, pattern: string) => Promise<Artifact[]>
  reveal: (path: string) => void
  exportArtifact: (path: string) => void
  preflight: (pkg: string) => Promise<PreflightCheck[]>
}

export function createLibView(host: HTMLElement, deps: LibViewDeps): LibViewApi {
  let source: Source = 'loaded'
  let streaming = false
  const rows = new Map<string, LibRow>()
  const selected = new Set<string>()
  const artifacts: Artifact[] = []
  let livePkg = ''
  let checkHost: HTMLElement | null = null // the open modal's check list, else null
  const preflightEpoch = makeEpoch()

  host.innerHTML = `
    <div class="lib-hdr">
      <div class="lib-row1">
        <strong>Native Libraries</strong>
        <div class="lib-seg"><button data-src="loaded" class="on">Loaded run</button><button data-src="live">Live device</button></div>
        <div class="lib-ctl" data-live hidden>
          <button class="btn pri" data-live-open>Start live capture&hellip;</button>
          <span class="lib-live-on" data-live-on hidden>
            <span class="lib-dot"></span><span data-live-pkg></span>
            <button class="btn" data-stop>Stop</button>
          </span>
        </div>
      </div>
      <div class="lib-row1">
        <div class="lib-stat" data-stat></div>
        <div class="lib-ctl"><button class="btn pri" data-dump hidden>Dump selected (0)</button></div>
      </div>
    </div>
    <div class="lib-tbl"><table><thead></thead><tbody></tbody></table></div>
    <div class="lib-dock collapsed">
      <div class="lib-dock-hd" data-dock-toggle>Dumped artifacts <span class="c" data-dock-count>none yet</span></div>
      <div class="lib-dock-body"><table><thead><tr><th>module</th><th>base</th><th>pid</th><th>size</th><th>arch</th><th>ELF</th><th>sha-256</th><th>raw</th><th></th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="lib-log collapsed" data-log hidden>
      <div class="lib-log-hd" data-log-toggle>Device log <span class="c" data-log-count></span></div>
      <div class="lib-log-body" data-log-body></div>
    </div>`

  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector(sel) as T
  const thead = $('.lib-tbl thead'); const tbody = $('.lib-tbl tbody')
  const dumpBtn = $<HTMLButtonElement>('[data-dump]'); const statEl = $('[data-stat]')

  function renderHead(): void {
    const sel = source === 'live' ? '<th style="width:22px"></th>' : ''
    thead.innerHTML = `<tr>${sel}<th>Library</th><th>soname</th><th>base</th><th>size</th><th>pid</th><th>mapped</th><th>flags</th></tr>`
  }

  function isNew(r: LibRow): boolean {
    if (source !== 'live') return false
    const atMs = (r as LibRow & { atMs?: number }).atMs
    return atMs !== undefined && atMs > NEW_LIB_SETTLE_MS
  }

  function rowHtml(r: LibRow): string {
    const k = key(r.pid, r.base)
    const cb = source === 'live'
      ? `<td><input type="checkbox" data-k="${esc(k)}" ${selected.has(k) ? 'checked' : ''}></td>` : ''
    const atMs = (r as LibRow & { atMs?: number }).atMs
    const mapped = source === 'live' && atMs !== undefined ? `t+${(atMs / 1000).toFixed(1)}s` : `#${r.seq}`
    const flags = [
      isNew(r) ? '<span class="lib-badge new">new</span>' : '',
      r.unmapped ? '<span class="lib-badge">unmapped</span>' : '',
    ].join(' ')
    return `<tr class="${r.unmapped ? 'unmap' : ''}" data-k="${esc(k)}" title="${esc(r.library)}">
      ${cb}<td class="lib-name">${esc(r.library.split('/').pop() ?? r.library)}</td>
      <td>${r.soname ? esc(r.soname) : '-'}</td><td>${esc(r.base)}</td><td>${humanBytes(r.size)}</td>
      <td>${r.pid}</td><td>${mapped}</td><td>${flags}</td></tr>`
  }

  function renderRows(): void {
    tbody.innerHTML = [...rows.values()].map(rowHtml).join('')
    if (source === 'live') {
      tbody.querySelectorAll<HTMLInputElement>('input[data-k]').forEach(cb => {
        cb.onchange = () => { cb.checked ? selected.add(cb.dataset.k!) : selected.delete(cb.dataset.k!); syncDump() }
      })
    }
    renderEmpty()
  }

  function renderEmpty(): void {
    const existing = host.querySelector('.lib-empty'); if (existing) existing.remove()
    if (rows.size > 0) return
    const msg = source === 'live'
      ? (streaming
          ? `Waiting for [lib] events from ${esc(livePkg || 'the target')}&hellip; trigger activity in the app on the device.`
          : 'Start a live capture to stream mapped libraries from the device.')
      : 'No library records in this run. Capture with a current ares build (the syscall, lib and funcs engines all emit them), or stream live under Live device.'
    const div = document.createElement('div'); div.className = 'lib-empty'; div.innerHTML = msg
    $('.lib-tbl').appendChild(div)
  }

  function renderStat(): void {
    if (source !== 'live') { statEl.innerHTML = `${rows.size} libraries`; return }
    const news = [...rows.values()].filter(isNew).length
    const unm = [...rows.values()].filter(r => r.unmapped).length
    statEl.innerHTML =
      `${streaming ? '<span class="lib-dot"></span>streaming' : 'stopped'} · ${rows.size} mapped · <span class="new">${news} new since start</span> · ${unm} unmapped`
  }

  function syncDump(): void {
    dumpBtn.textContent = `Dump selected (${selected.size})`
    dumpBtn.hidden = source !== 'live' || selected.size === 0
  }

  async function loadLoaded(): Promise<void> {
    rows.clear(); selected.clear()
    for (const r of await deps.loadedRows()) rows.set(key(r.pid, r.base), r)
    renderHead(); renderRows(); renderStat(); syncDump()
  }

  function renderArtifacts(): void {
    const body = $('.lib-dock-body tbody')
    body.innerHTML = artifacts.map((a, i) => `<tr>
      <td class="lib-name">${esc(a.module.split('/').pop() ?? a.module)}</td><td>${esc(a.base)}</td><td>${a.pid}</td>
      <td>${humanBytes(a.size)}</td><td>${a.arch ? esc(a.arch) : '-'}</td><td>${a.elfValid ? 'valid' : 'invalid'}</td>
      <td>${a.sha256.slice(0, 6)}...</td><td>${a.raw ? 'raw' : 'no'}</td>
      <td><span class="lib-act" data-reveal="${i}">reveal</span> · <span class="lib-act" data-export="${i}">export</span></td></tr>`).join('')
    $('[data-dock-count]').textContent = artifacts.length ? `${artifacts.length} pulled` : 'none yet'
    body.querySelectorAll<HTMLElement>('[data-reveal]').forEach(el =>
      el.onclick = () => deps.reveal(artifacts[Number(el.dataset.reveal)].path))
    body.querySelectorAll<HTMLElement>('[data-export]').forEach(el =>
      el.onclick = () => deps.exportArtifact(artifacts[Number(el.dataset.export)].path))
  }

  // --- header wiring ---
  host.querySelectorAll<HTMLButtonElement>('.lib-seg button').forEach(b =>
    b.onclick = () => { void setSource(b.dataset.src as Source) })
  $('[data-dock-toggle]').onclick = () => $('.lib-dock').classList.toggle('collapsed')
  $('[data-log-toggle]').onclick = () => $('[data-log]').classList.toggle('collapsed')

  // --- live source: modal-driven preflight + streaming state ---
  function renderLiveHeader(): void {
    $<HTMLButtonElement>('[data-live-open]').hidden = streaming
    $('[data-live-on]').hidden = !streaming
    $('[data-live-pkg]').textContent = livePkg ? `streaming ${livePkg}` : 'streaming'
  }

  function beginLive(pkg: string): void {
    livePkg = pkg; rows.clear(); selected.clear(); streaming = true
    renderLiveHeader(); renderRows(); renderStat(); syncDump()
    void deps.startLive(pkg)
  }

  function openLiveModal(): void {
    showModal({
      title: 'Live library capture', width: 460,
      onClose: () => { checkHost = null },
      render: host => {
        host.innerHTML = `
          <div class="lib-modal">
            <label class="lib-modal-row">Package
              <input data-modal-pkg placeholder="e.g. dev.ares.detector" value="${esc(livePkg)}">
            </label>
            <div class="lib-modal-actions"><button class="btn" data-modal-refresh>Refresh device</button></div>
            <div class="lib-checks" data-modal-checks></div>
            <div class="lib-modal-foot"><button class="btn pri" data-modal-begin disabled>Begin</button></div>
          </div>`
        checkHost = host.querySelector('[data-modal-checks]')
        const pkgIn = host.querySelector('[data-modal-pkg]') as HTMLInputElement
        const beginBtn = host.querySelector('[data-modal-begin]') as HTMLButtonElement
        const refreshBtn = host.querySelector('[data-modal-refresh]') as HTMLButtonElement
        // Any edit invalidates a prior green preflight (epoch guard).
        pkgIn.oninput = () => { preflightEpoch.bump(); beginBtn.disabled = true; if (checkHost) checkHost.innerHTML = '' }
        refreshBtn.onclick = async () => {
          const pkg = pkgIn.value.trim()
          if (!pkg) { if (checkHost) checkHost.textContent = 'enter a package first'; return }
          if (!isSafeToken(pkg)) { if (checkHost) checkHost.textContent = 'package has unsupported characters'; return }
          const token = preflightEpoch.bump()
          if (checkHost) checkHost.innerHTML = ''
          beginBtn.disabled = true; refreshBtn.disabled = true
          try {
            const checks = await deps.preflight(pkg)
            if (!preflightEpoch.isCurrent(token)) return // superseded by an edit / newer run
            beginBtn.disabled = !(checks.length > 0 && checks.every(c => c.ok))
          } catch (e) {
            if (!preflightEpoch.isCurrent(token)) return
            if (checkHost) {
              const r = document.createElement('div'); r.className = 'preflight-bad'
              r.textContent = `preflight failed: ${e instanceof Error ? e.message : String(e)}`
              checkHost.appendChild(r)
            }
          } finally { refreshBtn.disabled = false }
        }
        beginBtn.onclick = () => {
          const pkg = pkgIn.value.trim(); if (!pkg) return
          closeModal(); beginLive(pkg)
        }
      },
    })
  }

  $<HTMLButtonElement>('[data-live-open]').onclick = () => openLiveModal()
  $<HTMLButtonElement>('[data-stop]').onclick = () => { void deps.stopLive() }
  dumpBtn.onclick = async () => {
    const jobs = [...selected].map(k => {
      const r = rows.get(k)
      const pid = Number(k.split('|')[0])
      const pattern = (r?.library.split('/').pop() || r?.soname || '') as string
      return { pid, pattern }
    }).filter(j => j.pattern)
    dumpBtn.disabled = true
    try { for (const j of jobs) addArtifacts(await deps.dumpLib(j.pid, j.pattern)) }
    finally { dumpBtn.disabled = false }
  }

  async function setSource(s: Source): Promise<void> {
    source = s
    host.querySelectorAll<HTMLButtonElement>('.lib-seg button').forEach(b => b.classList.toggle('on', b.dataset.src === s))
    $('[data-live]').hidden = s !== 'live'
    if (s === 'loaded') { streaming = false; await loadLoaded() }
    else { rows.clear(); selected.clear(); renderHead(); renderRows(); renderStat(); syncDump(); renderLiveHeader() }
  }

  function appendLog(line: string): void {
    $('[data-log]').hidden = false
    const div = document.createElement('div'); div.textContent = line
    if (/error|fail|not found|denied|no such|cannot|permission/i.test(line)) {
      div.className = 'log-err'
      $('[data-log]').classList.remove('collapsed') // never hide a failure
    }
    const body = $('[data-log-body]'); body.appendChild(div)
    $('[data-log-count]').textContent = `${body.childElementCount} lines`
  }

  function addArtifacts(a: Artifact[]): void { artifacts.push(...a); renderArtifacts() }

  // initial paint (loaded source)
  void setSource('loaded')

  return {
    setSource: s => { void setSource(s) },
    applyMapped: l => {
      const base = l.start
      const r: LibRow & { atMs: number } = {
        library: l.library ?? '', soname: l.soname ?? null, base, end: l.end,
        size: parseInt(l.end, 16) - parseInt(l.start, 16), pgoff: l.pgoff ?? 0, inode: l.inode ?? 0,
        pid: l.pid, tid: null, ppid: l.ppid ?? null, seq: rows.size, unmapped: false, atMs: l.atMs,
      }
      rows.set(key(l.pid, base), r); renderRows(); renderStat()
    },
    applyUnmapped: l => {
      const r = rows.get(key(l.pid, l.start)); if (r) { r.unmapped = true; renderRows(); renderStat() }
    },
    applyPreflightCheck: c => {
      if (!checkHost) return // no modal open: nothing to render into (a Capture preflight also lands here)
      renderPreflightRow(checkHost, c)
    },
    addArtifacts,
    appendLog,
    streamEnded: () => { streaming = false; renderLiveHeader(); renderStat(); appendLog('stream ended') },
  }
}
