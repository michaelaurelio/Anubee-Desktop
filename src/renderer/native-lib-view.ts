// Native Libraries view: loaded-run table + live device stream + artifacts
// dock. Pure DOM controller, no framework - mirrors flame-view/table's style.

import { NEW_LIB_SETTLE_MS, type LibRow, type LibLine, type Artifact } from '@shared/native-lib'

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
  addArtifacts(a: Artifact[]): void
  streamEnded(): void
}

export interface LibViewDeps {
  loadedRows: () => Promise<LibRow[]>
  startLive: (pkg: string) => Promise<void>
  stopLive: () => Promise<void>
  dumpLib: (pid: number, pattern: string) => Promise<Artifact[]>
  reveal: (path: string) => void
  exportArtifact: (path: string) => void
}

export function createLibView(host: HTMLElement, deps: LibViewDeps): LibViewApi {
  let source: Source = 'loaded'
  let streaming = false
  const rows = new Map<string, LibRow>()
  const selected = new Set<string>()
  const artifacts: Artifact[] = []
  let firstAtMs: number | null = null

  host.innerHTML = `
    <div class="lib-hdr">
      <div class="lib-row1">
        <strong>Native Libraries</strong>
        <div class="lib-seg"><button data-src="loaded" class="on">Loaded run</button><button data-src="live">Live device</button></div>
        <div class="lib-ctl" data-live hidden>
          <input data-pkg placeholder="package (e.g. dev.ares.detector)" size="26">
          <button class="btn" data-start>Start</button>
          <button class="btn" data-stop hidden>Stop</button>
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
    </div>`

  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector(sel) as T
  const thead = $('.lib-tbl thead'); const tbody = $('.lib-tbl tbody')
  const dumpBtn = $<HTMLButtonElement>('[data-dump]'); const statEl = $('[data-stat]')

  function renderHead(): void {
    const sel = source === 'live' ? '<th style="width:22px"></th>' : ''
    thead.innerHTML = `<tr>${sel}<th>Library</th><th>soname</th><th>base</th><th>size</th><th>pid</th><th>mapped</th><th>flags</th></tr>`
  }

  function isNew(r: LibRow): boolean {
    if (source !== 'live' || firstAtMs === null) return false
    return (r as LibRow & { atMs?: number }).atMs !== undefined &&
      ((r as LibRow & { atMs: number }).atMs - firstAtMs) > NEW_LIB_SETTLE_MS
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
    tbody.querySelectorAll<HTMLElement>('tr[data-k]').forEach(tr => {
      tr.onclick = e => { if ((e.target as HTMLElement).tagName !== 'INPUT') tr.classList.toggle('sel') }
    })
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
      <td>${humanBytes(a.size)}</td><td>${a.arch ?? '-'}</td><td>${a.elfValid ? 'valid' : 'invalid'}</td>
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
  $<HTMLButtonElement>('[data-start]').onclick = async () => {
    const pkg = $<HTMLInputElement>('[data-pkg]').value.trim(); if (!pkg) return
    rows.clear(); selected.clear(); firstAtMs = null; streaming = true
    $<HTMLButtonElement>('[data-start]').hidden = true; $<HTMLButtonElement>('[data-stop]').hidden = false
    renderRows(); renderStat(); await deps.startLive(pkg)
  }
  $<HTMLButtonElement>('[data-stop]').onclick = async () => { await deps.stopLive() }
  dumpBtn.onclick = async () => {
    const jobs = [...selected].map(k => { const [pid, base] = k.split('|'); return { pid: Number(pid), pattern: base.split('/').pop() as string } })
    dumpBtn.disabled = true
    for (const j of jobs) addArtifacts(await deps.dumpLib(j.pid, j.pattern))
    dumpBtn.disabled = false
  }

  async function setSource(s: Source): Promise<void> {
    source = s
    host.querySelectorAll<HTMLButtonElement>('.lib-seg button').forEach(b => b.classList.toggle('on', b.dataset.src === s))
    $('[data-live]').hidden = s !== 'live'
    if (s === 'loaded') { streaming = false; await loadLoaded() }
    else { rows.clear(); selected.clear(); renderHead(); renderRows(); renderStat(); syncDump() }
  }

  function addArtifacts(a: Artifact[]): void { artifacts.push(...a); renderArtifacts() }

  // initial paint (loaded source)
  void setSource('loaded')

  return {
    setSource: s => { void setSource(s) },
    applyMapped: l => {
      if (firstAtMs === null) firstAtMs = l.atMs
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
    addArtifacts,
    streamEnded: () => { streaming = false; renderStat() },
  }
}
