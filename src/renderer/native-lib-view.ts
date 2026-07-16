// Native Libraries view: loaded-run table + live device stream + artifacts
// dock. Pure DOM controller, no framework - mirrors flame-view/table's style.

import { type LibRow, type LibLine, type Artifact, type Modcmp, type ModcmpState } from '@shared/native-lib'
import { showModal, closeModal } from './modal'
import { isSafeToken, isSafePattern } from '@shared/tracer-caps'
import { makeEpoch } from './selection-epoch'
import { renderPreflightRow, type PreflightCheck } from './capture-view'

type Source = 'loaded' | 'live'
const key = (pid: number, base: string): string => `${pid}|${base}`
const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
// Numeric base compare: a verdict's base can differ from the row's only in
// formatting (leading zeros etc), never join by module name (an APK-embedded
// library's module is literally "base.apk").
const sameBase = (a: string, b: string): boolean => {
  try { return BigInt(a) === BigInt(b) } catch { return a === b }
}
// One shared word table for the evidence trail, used on both sides of the
// arrow - do not hardcode "clean" for the baseline, a nofile/unreadable
// baseline must not be mislabeled as clean.
const stateWord: Record<ModcmpState, string> = {
  match: 'clean', differ: 'modified', nofile: 'no file', apk: 'apk', unreadable: 'unreadable',
}
type RowX = LibRow & { atMs?: number; checkState?: ModcmpState; baselineState?: ModcmpState; checkedAtMs?: number }

function humanBytes(n: number): string {
  if (!n) return '-'
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

export interface LibViewApi {
  setSource(s: Source): void
  refresh(): void
  applyMapped(l: LibLine & { atMs: number }): void
  applyUnmapped(l: LibLine & { atMs: number }): void
  applyCheck(results: Modcmp[], atMs: number): void
  applyPreflightCheck(c: PreflightCheck): void
  addArtifacts(a: Artifact[]): void
  appendLog(line: string): void
  streamEnded(): void
}

export interface LibViewDeps {
  loadedRows: () => Promise<LibRow[]>
  startLive: (pkg: string, glob?: string) => Promise<void>
  stopLive: () => Promise<void>
  dumpLib: (pid: number, base: string) => Promise<Artifact[]>
  reveal: (path: string) => void
  exportArtifact: (path: string) => void
  preflight: (pkg: string) => Promise<PreflightCheck[]>
  verify: (pid: number, bases: string[]) => Promise<void>
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
      <div class="lib-tool">
        <strong>Native Libraries</strong>
        <div class="lib-seg"><button data-src="loaded" class="on">Loaded run</button><button data-src="live">Live device</button></div>
        <div class="lib-live" data-live hidden>
          <button class="btn pri" data-live-open>Start live capture&hellip;</button>
          <span class="lib-live-on" data-live-on hidden>
            <span class="lib-dot"></span><span data-live-pkg></span>
            <button class="btn" data-stop>Stop</button>
          </span>
        </div>
      </div>
      <div class="lib-stat" data-stat></div>
      <div class="lib-selbar" data-selbar hidden>
        <span class="n" data-sel-count></span>
        <span class="lib-div"></span>
        <button class="btn pri" data-dump>Dump</button>
        <button class="btn" data-verify>Verify</button>
        <span class="lib-sp"></span>
        <button class="btn gh" data-clear>Clear</button>
      </div>
    </div>
    <div class="lib-tbl"><table><thead></thead><tbody></tbody></table></div>
    <div class="lib-dock collapsed" data-active="artifacts">
      <div class="lib-grip" data-grip></div>
      <div class="lib-tabs">
        <button class="lib-tab on" data-tab="artifacts">Dumped artifacts <span class="c" data-dock-count>none yet</span></button>
        <button class="lib-tab" data-tab="log">Device log <span class="c" data-log-count></span><span class="dot-err" hidden></span></button>
        <button class="icon-btn" data-dock-collapse title="collapse"><svg class="ic" viewBox="0 0 24 24"><use href="#i-chevron-down"/></svg></button>
      </div>
      <div class="lib-pane" data-pane="artifacts"><table><thead><tr><th>module</th><th>base</th><th>pid</th><th>size</th><th>arch</th><th>ELF</th><th>sha-256</th><th>raw</th><th></th></tr></thead><tbody></tbody></table></div>
      <div class="lib-pane" data-pane="log" data-log-body hidden></div>
    </div>`

  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector(sel) as T
  const thead = $('.lib-tbl thead'); const tbody = $('.lib-tbl tbody')
  const dumpBtn = $<HTMLButtonElement>('[data-dump]'); const statEl = $('[data-stat]')
  const verifyBtn = $<HTMLButtonElement>('[data-verify]')

  function renderHead(): void {
    const sel = source === 'live' ? '<th style="width:22px"></th>' : ''
    thead.innerHTML = `<tr>${sel}<th>Library</th><th>soname</th><th>base</th><th>size</th><th>pid</th><th>mapped</th><th>flags</th></tr>`
  }

  // A row is only dumpable if its `library` is an on-disk path (dump derives the
  // device-side pattern from the basename); bracketed pseudo-paths like
  // "[anon_shmem:dalvik-jit-code-cache]" are not files and must not be offered.
  function isDumpable(r: LibRow): boolean {
    return r.library.startsWith('/')
  }

  function rowHtml(r: LibRow): string {
    const k = key(r.pid, r.base)
    const cb = source === 'live'
      ? (isDumpable(r) ? `<td><input type="checkbox" data-k="${esc(k)}" ${selected.has(k) ? 'checked' : ''}></td>` : '<td></td>') : ''
    const atMs = (r as RowX).atMs
    const mapped = source === 'live' && atMs !== undefined ? `t+${(atMs / 1000).toFixed(1)}s` : `#${r.seq}`
    const cs = (r as RowX).checkState
    const flags = [
      cs === 'differ' ? '<span class="lib-badge mod">MODIFIED</span>' : '',
      cs === 'nofile' ? '<span class="lib-badge nofile">NO FILE</span>' : '',
      r.unmapped ? '<span class="lib-badge">unmapped</span>' : '',
    ].filter(Boolean).join(' ')
    // Only a genuine baseline -> latest change (e.g. match -> differ) shows the
    // evidence trail; a first-seen differ shows only the MODIFIED badge.
    const baselineState = (r as RowX).baselineState
    const trail = baselineState && cs && baselineState !== cs
      ? ` (${stateWord[baselineState]} at t+${((atMs ?? 0) / 1000).toFixed(1)}s -> ${stateWord[cs]} at t+${(((r as RowX).checkedAtMs ?? 0) / 1000).toFixed(1)}s)`
      : ''
    return `<tr class="${r.unmapped ? 'unmap' : ''}" data-k="${esc(k)}" title="${esc(r.library)}${trail}">
      ${cb}<td class="lib-name">${esc(r.library.split('/').pop() ?? r.library)}</td>
      <td>${r.soname ? esc(r.soname) : '-'}</td><td>${esc(r.base)}</td><td>${humanBytes(r.size)}</td>
      <td>${r.pid}</td><td>${mapped}</td><td>${flags}</td></tr>`
  }

  function renderRows(): void {
    tbody.innerHTML = [...rows.values()].map(rowHtml).join('')
    if (source === 'live') {
      tbody.querySelectorAll<HTMLInputElement>('input[data-k]').forEach(cb => {
        cb.onchange = () => { cb.checked ? selected.add(cb.dataset.k!) : selected.delete(cb.dataset.k!); renderSelectionBar() }
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
    const modified = [...rows.values()].filter(r => (r as RowX).checkState === 'differ').length
    const unm = [...rows.values()].filter(r => r.unmapped).length
    statEl.innerHTML =
      `${streaming ? '<span class="lib-dot"></span>streaming' : 'stopped'} · ${rows.size} mapped · <span class="mod">${modified} modified</span> · ${unm} unmapped`
  }

  function renderSelectionBar(): void {
    const bar = $('[data-selbar]')
    const show = source === 'live' && selected.size > 0
    bar.hidden = !show
    if (show) $('[data-sel-count]').textContent = `${selected.size} selected`
  }

  async function loadLoaded(): Promise<void> {
    rows.clear(); selected.clear()
    for (const r of await deps.loadedRows()) rows.set(key(r.pid, r.base), r)
    renderHead(); renderRows(); renderStat(); renderSelectionBar()
  }

  function renderArtifacts(): void {
    const body = $('[data-pane="artifacts"] tbody')
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
  const dock = $('.lib-dock')
  function setActiveTab(tab: 'artifacts' | 'log'): void {
    dock.setAttribute('data-active', tab)
    host.querySelectorAll<HTMLElement>('.lib-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
    host.querySelectorAll<HTMLElement>('.lib-pane').forEach(p => { p.hidden = p.dataset.pane !== tab })
    if (tab === 'log') $('[data-tab="log"] .dot-err').hidden = true   // reading the log clears its alert
  }
  host.querySelectorAll<HTMLButtonElement>('.lib-tab').forEach(b =>
    b.onclick = () => setActiveTab(b.dataset.tab as 'artifacts' | 'log'))   // switch only, never collapse
  $('[data-dock-collapse]').onclick = () => { dock.classList.toggle('collapsed') }

  // --- live source: modal-driven preflight + streaming state ---
  function renderLiveHeader(): void {
    $<HTMLButtonElement>('[data-live-open]').hidden = streaming
    $('[data-live-on]').hidden = !streaming
    $('[data-live-pkg]').textContent = livePkg || 'streaming'
  }

  function beginLive(pkg: string, glob?: string): void {
    livePkg = pkg; rows.clear(); selected.clear(); streaming = true
    renderLiveHeader(); renderRows(); renderStat(); renderSelectionBar()
    void deps.startLive(pkg, glob)
  }

  function openLiveModal(): void {
    showModal({
      title: 'Live library capture', width: 460,
      onClose: () => { checkHost = null; preflightEpoch.bump() },
      render: host => {
        host.innerHTML = `
          <div class="lib-modal">
            <label class="lib-modal-row">Package
              <input data-modal-pkg placeholder="e.g. dev.ares.detector" value="${esc(livePkg)}">
            </label>
            <label class="lib-modal-row">Also dump matching libraries as they map (optional)
              <input data-modal-glob placeholder="e.g. libexample* or blob_[0-9]*">
            </label>
            <p class="lib-modal-hint">Catches libraries mapped from a file path. APK-embedded
              and anonymous mappings are caught in the table or by dumping their base.</p>
            <div class="lib-modal-actions"><button class="btn" data-modal-refresh>Refresh device</button></div>
            <div class="lib-checks" data-modal-checks></div>
            <div class="lib-modal-foot"><button class="btn pri" data-modal-begin disabled>Begin</button></div>
          </div>`
        checkHost = host.querySelector('[data-modal-checks]')
        const pkgIn = host.querySelector('[data-modal-pkg]') as HTMLInputElement
        const globIn = host.querySelector('[data-modal-glob]') as HTMLInputElement
        const beginBtn = host.querySelector('[data-modal-begin]') as HTMLButtonElement
        const refreshBtn = host.querySelector('[data-modal-refresh]') as HTMLButtonElement
        let preflightOk = false
        const globValid = (): boolean => { const g = globIn.value.trim(); return g === '' || isSafePattern(g) }
        const syncBegin = (): void => { beginBtn.disabled = !(preflightOk && globValid()) }
        // Any edit invalidates a prior green preflight (epoch guard).
        pkgIn.oninput = () => { preflightEpoch.bump(); preflightOk = false; beginBtn.disabled = true; if (checkHost) checkHost.innerHTML = '' }
        globIn.oninput = () => syncBegin()
        refreshBtn.onclick = async () => {
          const pkg = pkgIn.value.trim()
          if (!pkg) { if (checkHost) checkHost.textContent = 'enter a package first'; return }
          if (!isSafeToken(pkg)) { if (checkHost) checkHost.textContent = 'package has unsupported characters'; return }
          const token = preflightEpoch.bump()
          if (checkHost) checkHost.innerHTML = ''
          preflightOk = false; beginBtn.disabled = true; refreshBtn.disabled = true
          try {
            const checks = await deps.preflight(pkg)
            if (!preflightEpoch.isCurrent(token)) return // superseded by an edit / newer run
            preflightOk = checks.length > 0 && checks.every(c => c.ok)
            syncBegin()
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
          const glob = globIn.value.trim()
          closeModal(); beginLive(pkg, glob || undefined)
        }
      },
    })
  }

  $<HTMLButtonElement>('[data-live-open]').onclick = () => openLiveModal()
  $<HTMLButtonElement>('[data-stop]').onclick = () => { void deps.stopLive() }
  // Minimal on-demand re-check: the ticked subset if any row is selected,
  // else every dumpable streaming row's base. The pid comes from any row
  // (they all share the one streaming pid); with no rows there is nothing
  // to check.
  verifyBtn.onclick = () => {
    // Post-stop click must not silently no-op: liveCheckDir is nulled
    // main-side once the stream stops, so a click with no live stream
    // needs feedback instead of doing nothing.
    if (!streaming) { appendLog('verify needs a live stream (start a live capture first)'); return }
    const liveRows = [...rows.values()]
    if (liveRows.length === 0) return
    const pid = liveRows[0].pid
    const bases = selected.size > 0
      ? [...selected].map(k => k.split('|')[1]).filter((b): b is string => !!b)
      : liveRows.filter(isDumpable).map(r => r.base)
    void deps.verify(pid, bases)
  }
  $('[data-clear]').onclick = () => { selected.clear(); renderRows(); renderSelectionBar() }
  dumpBtn.onclick = async () => {
    const jobs = [...selected].map(k => {
      const [pidStr, base] = k.split('|')
      return { pid: Number(pidStr), base }
    }).filter(j => j.base)
    dumpBtn.disabled = true
    try {
      for (const j of jobs) {
        try { addArtifacts(await deps.dumpLib(j.pid, j.base)) }
        catch (e) { appendLog(`dump failed for pid ${j.pid} @${j.base}: ${e instanceof Error ? e.message : String(e)}`) }
      }
    } finally { dumpBtn.disabled = false }
  }

  async function setSource(s: Source): Promise<void> {
    source = s
    host.querySelectorAll<HTMLButtonElement>('.lib-seg button').forEach(b => b.classList.toggle('on', b.dataset.src === s))
    $('[data-live]').hidden = s !== 'live'
    if (s === 'loaded') {
      if (streaming) { streaming = false; void deps.stopLive() }
      await loadLoaded()
    } else { rows.clear(); selected.clear(); renderHead(); renderRows(); renderStat(); renderSelectionBar(); renderLiveHeader() }
  }

  function appendLog(line: string): void {
    const div = document.createElement('div'); div.textContent = line
    if (/error|fail|not found|denied|no such|cannot|permission/i.test(line)) {
      div.className = 'log-err'
      // red-dot the log tab only while it is the background tab; if the log tab is
      // already active, the analyst is looking at it and needs no alert.
      if (dock.getAttribute('data-active') !== 'log') $('[data-tab="log"] .dot-err').hidden = false
      if (source === 'live') dock.classList.remove('collapsed')  // errors auto-expand a collapsed dock
    }
    const body = $('[data-log-body]'); body.appendChild(div)
    $('[data-log-count]').textContent = `${body.childElementCount} lines`
  }

  function addArtifacts(a: Artifact[]): void { artifacts.push(...a); renderArtifacts() }

  // initial paint (loaded source)
  void setSource('loaded')

  return {
    setSource: s => { void setSource(s) },
    refresh: () => { if (source === 'loaded') void loadLoaded() },
    applyMapped: l => {
      if (source !== 'live') return // a stream-end already in flight must not write into the Loaded table
      const base = l.start
      const r: LibRow & { atMs: number } = {
        library: l.library ?? '', soname: l.soname ?? null, base, end: l.end,
        size: parseInt(l.end, 16) - parseInt(l.start, 16), pgoff: l.pgoff ?? 0, inode: l.inode ?? 0,
        pid: l.pid, tid: null, ppid: l.ppid ?? null, seq: rows.size, unmapped: false, atMs: l.atMs,
      }
      rows.set(key(l.pid, base), r); renderRows(); renderStat()
    },
    applyUnmapped: l => {
      if (source !== 'live') return
      const r = rows.get(key(l.pid, l.start)); if (r) { r.unmapped = true; renderRows(); renderStat() }
    },
    applyCheck: (results, atMs) => {
      if (source !== 'live') return
      for (const m of results) {
        // Join by pid + numeric base - never by module (APK-embedded module is
        // "base.apk"), and numeric so a formatting difference cannot drop it.
        const row = [...rows.values()].find(r =>
          r.pid === m.pid && sameBase(r.base, m.base)) as RowX | undefined
        if (!row) continue
        if (row.baselineState === undefined) row.baselineState = m.state
        row.checkState = m.state
        row.checkedAtMs = atMs
      }
      renderRows(); renderStat()
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
