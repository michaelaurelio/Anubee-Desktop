import type { SyscallEvent, FuncEvent } from '@shared/events'

// The pager descriptor a node inspector renders: which window of records it shows
// (`offset`), how many exist in total, and the arrow callbacks (owned by main.ts,
// mirroring the master table's tableOffset/refreshTable).
export interface InspectorPage {
  offset: number
  total: number
  onPrev: () => void
  onNext: () => void
}

// Build the inspector pager row (prev / "a-b / total" / next), styled like the
// master-table pager. Disabled at the ends. "next" is off once this page reaches
// the total (offset + pageLen === total on the last page), so no page constant is
// needed here - main.ts owns NODE_PAGE.
function buildInspectorPager(page: InspectorPage, pageLen: number): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'pager insp-pager'
  const prev = document.createElement('button')
  prev.className = 'icon-btn'; prev.title = 'previous page'
  prev.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-cl"/></svg>'
  prev.disabled = page.offset <= 0
  prev.onclick = () => page.onPrev()
  const rng = document.createElement('span')
  rng.className = 'rng'
  rng.textContent = page.total === 0 ? '0 / 0' : `${page.offset + 1}–${page.offset + pageLen} / ${page.total}`
  const next = document.createElement('button')
  next.className = 'icon-btn'; next.title = 'next page'
  next.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-cr"/></svg>'
  next.disabled = page.offset + pageLen >= page.total
  next.onclick = () => page.onNext()
  bar.append(prev, rng, next)
  return bar
}

// A readable multi-line summary of one raw syscall record. Pure and unit-tested.
export function formatEvent(e: SyscallEvent): string {
  const lines: string[] = []
  lines.push(`${e.syscall}  (nr ${e.syscall_nr})  tid ${e.tid}  retval ${e.retval}`)

  const strs = Object.entries(e.string_args)
  if (strs.length) lines.push('string_args:\n' + strs.map(([k, v]) => `  [${k}] ${v}`).join('\n'))

  const dec = Object.entries(e.decoded_args)
  if (dec.length) lines.push('decoded_args:\n' + dec.map(([k, v]) => `  [${k}] ${v}`).join('\n'))

  const fds = Object.entries(e.fd_args)
  if (fds.length) lines.push('fd_args:\n' + fds.map(([k, v]) => `  [${k}] ${v}`).join('\n'))

  if (e.sock_addr) lines.push(`sock_addr:\n  ${e.sock_addr}`)

  if (e.java_stack?.length) lines.push('java_stack:\n' + e.java_stack.map(m => `  ${m}`).join('\n'))

  lines.push('backtrace:\n' + e.backtrace.map(f => `  #${f.frame} ${f.symbol}`).join('\n'))
  return lines.join('\n')
}

// The single most informative argument for the inspector table's `args` column:
// the resolved path/string arg if present, else the sock_addr, else the fd path,
// else the decoded args, else the raw args. Pure and unit-tested.
export function primaryArg(e: SyscallEvent): string {
  const strs = Object.values(e.string_args)
  if (strs.length) return strs.join(' ')
  if (e.sock_addr) return e.sock_addr
  const fds = Object.values(e.fd_args)
  if (fds.length) return fds.join(' ')
  const dec = Object.values(e.decoded_args)
  if (dec.length) return dec.join(' ')
  return e.args.join(' ')
}

export interface KvRow { k: string; v: string; sub?: boolean }
export type DetailSection =
  | { title: string; kind: 'kv'; rows: KvRow[] }
  | { title: string; kind: 'stack'; lines: string[]; highlight?: number }

const SYSTEM_LIB = /^(libc\.so|libc\+\+|libdl\.so|libm\.so|libart\.so|libartbase|libnativebridge|libnativeloader|libandroid_runtime\.so|libbinder\.so|libselinux\.so|libcutils|liblog\.so|boot\.oat|\[anon|\[vdso|linker64|libziparchive|libnativehelper|libbase\.so)/
// The innermost frame whose module is NOT a system/runtime lib (the app's own block); -1 if none.
export function appFrameIndex(frames: { symbol: string }[]): number {
  for (let i = 0; i < frames.length; i++) if (!SYSTEM_LIB.test(frames[i].symbol)) return i
  return -1
}

// Group a record into the inspector's detail cards. Pure and unit-tested; the
// DOM wrapper is renderEventDetail. Empty arg/stack groups are skipped.
export function eventDetailSections(e: SyscallEvent): DetailSection[] {
  const out: DetailSection[] = []
  out.push({ title: 'Summary', kind: 'kv', rows: [
    { k: 'syscall', v: `${e.syscall} (nr ${e.syscall_nr})` },
    { k: 'tid', v: String(e.tid) },
    { k: 'retval', v: String(e.retval) },
  ] })
  const argRows = interleaveArgRows(e.args, [
    ['string', e.string_args],
    ['decoded', e.decoded_args],
    ['fd', e.fd_args],
  ])
  if (e.sock_addr) argRows.push({ k: 'sock_addr', v: e.sock_addr })
  if (argRows.length) out.push({ title: 'Args', kind: 'kv', rows: argRows })
  if (e.java_stack?.length) out.push({ title: 'Java stack', kind: 'stack', lines: e.java_stack.slice() })
  if (e.backtrace.length) out.push({ title: 'Backtrace', kind: 'stack', lines: e.backtrace.map(f => `#${f.frame} ${f.symbol}`), highlight: appFrameIndex(e.backtrace) })
  return out
}

// Build the interleaved Args rows: for each arg index 0..max, the raw `arg[i]`
// row (when present) followed by any decoded overlays for that same index as
// `sub` rows. Overlay maps are keyed by the stringified arg index; an overlay
// whose index has no raw slot still renders (as a lone sub row under that index).
function interleaveArgRows(args: string[], overlays: [string, Record<string, string>][]): KvRow[] {
  let max = args.length - 1
  for (const [, m] of overlays) for (const k of Object.keys(m)) {
    const n = Number(k)
    if (Number.isInteger(n) && n > max) max = n
  }
  const rows: KvRow[] = []
  for (let i = 0; i <= max; i++) {
    if (i < args.length) rows.push({ k: `arg[${i}]`, v: args[i] })
    for (const [label, m] of overlays) {
      const v = m[String(i)]
      if (v !== undefined) rows.push({ k: label, v, sub: true })
    }
  }
  return rows
}

// Build the `.bt` frame-row list for a stack section: one `.f` row per line,
// split into an `.idx` (leading `#n`, if present) and `.sym` (the rest). When
// `highlight` names a frame index, that row gets `.app`, the rest `.sys` - the
// mockup's "app's own frame stands out from the bionic/ART scaffolding" cue.
// Cells use textContent so trace strings can't inject markup.
function buildStackRows(sec: { lines: string[]; highlight?: number }): HTMLDivElement {
  const wrap = document.createElement('div'); wrap.className = 'bt'
  sec.lines.forEach((line, i) => {
    const row = document.createElement('div'); row.className = 'f'
    // highlight === -1 (all-system backtrace) renders plain rows with no .app/.sys classes
    if (sec.highlight !== undefined && sec.highlight >= 0) row.classList.add(i === sec.highlight ? 'app' : 'sys')
    const m = /^(#\d+)\s(.*)$/.exec(line)
    const idx = document.createElement('span'); idx.className = 'idx'; idx.textContent = m ? m[1] : ''
    const sym = document.createElement('span'); sym.className = 'sym'; sym.textContent = m ? m[2] : line
    row.append(idx, sym)
    wrap.appendChild(row)
  })
  return wrap
}

// Render the detail cards for one event into `host` (clears it first). Cells use
// textContent so trace strings can't inject markup. DOM side-effect.
export function renderEventDetail(host: HTMLElement, e: SyscallEvent): void {
  host.innerHTML = ''
  for (const sec of eventDetailSections(e)) {
    const card = document.createElement('div'); card.className = 'insp-card'
    const h = document.createElement('div'); h.className = 'insp-card-h'
    const t = document.createElement('span'); t.textContent = sec.title; h.appendChild(t)
    if (sec.kind === 'stack') { const c = document.createElement('span'); c.className = 'insp-card-cnt'; c.textContent = String(sec.lines.length); h.appendChild(c) }
    card.appendChild(h)
    if (sec.kind === 'kv') {
      const tbl = document.createElement('table'); tbl.className = 'insp-kv'
      for (const row of sec.rows) {
        const tr = document.createElement('tr')
        if (row.sub) tr.className = 'insp-kv-sub'
        const kd = document.createElement('td'); kd.textContent = row.k
        const vd = document.createElement('td'); vd.textContent = row.v
        tr.append(kd, vd); tbl.appendChild(tr)
      }
      card.appendChild(tbl)
    } else {
      card.appendChild(buildStackRows(sec))
    }
    host.appendChild(card)
  }
}

// Options for the node-inspector header: the node's graph kind (colors the
// kind-dot + name) and its RASP tag categories (rendered as `.cat-chip`s).
export interface NodeInspectorOpts {
  kind?: string
  cats?: string[]
}

// Build the node-inspector header: a kind dot + kind-colored node name, and one
// `.cat-chip` per tag category underneath. The record count lives in the pager
// row's range readout, so it is not repeated here. Cells use textContent so
// trace strings/tags can't inject markup.
function buildNodeHeader(nodeId: string, opts?: NodeInspectorOpts): HTMLDivElement {
  const head = document.createElement('div')
  head.className = 'insp-head'

  const title = document.createElement('div')
  title.className = 'insp-head-title'
  if (opts?.kind) {
    const dot = document.createElement('span')
    dot.className = `insp-kdot k-${opts.kind}`
    title.appendChild(dot)
  }
  const nm = document.createElement('span')
  nm.className = 'insp-head-nm'
  if (opts?.kind) nm.classList.add(`k-${opts.kind}`)
  nm.textContent = nodeId
  title.appendChild(nm)
  head.appendChild(title)

  if (opts?.cats?.length) {
    const cats = document.createElement('div')
    cats.className = 'insp-head-cats'
    for (const cat of opts.cats) {
      const chip = document.createElement('span')
      chip.className = `cat-chip cat-${cat}`
      chip.textContent = cat.toUpperCase()
      cats.appendChild(chip)
    }
    head.appendChild(cats)
  }
  return head
}

// Render the records behind a clicked node into #inspector as a compact table
// (id, syscall, tid, retval, primary arg); clicking a row shows that record's
// full formatted detail below. Cells use textContent so trace strings can't
// inject markup. DOM side-effect, not unit-tested.
export function showNodeInspector(nodeId: string, events: SyscallEvent[], page: InspectorPage, opts?: NodeInspectorOpts): void {
  const host = document.getElementById('inspector')
  if (!host) return
  host.innerHTML = ''

  host.appendChild(buildNodeHeader(nodeId, opts))
  host.appendChild(buildInspectorPager(page, events.length))

  const detail = document.createElement('div')
  detail.className = 'insp-detail'

  const scroll = document.createElement('div')
  scroll.className = 'insp-table-wrap'
  const table = document.createElement('table')
  table.className = 'insp-table'

  const thead = document.createElement('thead')
  const htr = document.createElement('tr')
  for (const h of ['#', 'syscall', 'tid', 'ret', 'args']) {
    const th = document.createElement('th')
    th.textContent = h
    htr.appendChild(th)
  }
  thead.appendChild(htr)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  let selected: HTMLTableRowElement | undefined
  for (const ev of events) {
    const tr = document.createElement('tr')
    const cells = [String(ev.id), ev.syscall, String(ev.tid), String(ev.retval), primaryArg(ev)]
    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement('td')
      td.textContent = cells[i]
      if (i === 1) td.className = 'insp-rsys' // syscall name, kind-colored
      if (i === 3 && ev.retval !== null && ev.retval < 0) td.className = 'insp-rneg' // negative retval, called out in red
      if (i === 4) td.className = 'insp-arg' // let the args column wrap/truncate
      tr.appendChild(td)
    }
    tr.onclick = () => {
      selected?.classList.remove('sel')
      tr.classList.add('sel')
      selected = tr
      renderEventDetail(detail, ev)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  scroll.appendChild(table)
  host.appendChild(scroll)
  host.appendChild(detail)

  if (events[0]) {
    renderEventDetail(detail, events[0])
    tbody.firstChild && (tbody.firstChild as HTMLTableRowElement).classList.add('sel')
    selected = tbody.firstChild as HTMLTableRowElement
  }
}

// Render one record's full detail into `host` (single-record mode, used by a
// master-table row click). Clears host, writes a short header, then the same
// detail cards renderEventDetail produces. DOM side-effect.
export function showRecordDetail(host: HTMLElement, e: SyscallEvent): void {
  host.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'insp-head'
  head.textContent = `#${e.id} · ${e.syscall} · tid ${e.tid}`
  host.appendChild(head)
  const detail = document.createElement('div')
  detail.className = 'insp-detail'
  renderEventDetail(detail, e)
  host.appendChild(detail)
}

// The primary arg for a funcs record: resolved string arg, else sock, else fd,
// else raw args. Pure and unit-tested.
export function primaryFuncArg(e: FuncEvent): string {
  const strs = Object.values(e.string_args ?? {})
  if (strs.length) return strs.join(' ')
  const socks = Object.values(e.sock_args ?? {})
  if (socks.length) return socks.join(' ')
  const fds = Object.values(e.fd_args ?? {})
  if (fds.length) return fds.join(' ')
  return (e.args ?? []).join(' ')
}

// Group a funcs record into the inspector's detail cards. Pure and unit-tested.
export function funcDetailSections(e: FuncEvent): DetailSection[] {
  const out: DetailSection[] = []
  out.push({ title: 'Summary', kind: 'kv', rows: [
    { k: 'function', v: `${e.module}!${e.symbol}` },
    { k: 'tid', v: String(e.tid) },
    { k: 'retval', v: e.retval === undefined ? '-' : String(e.retval) },
    { k: 'elapsed', v: e.elapsed_ns === undefined ? '-' : `${e.elapsed_ns} ns` },
  ] })
  const argRows: KvRow[] = []
  for (const [k, v] of Object.entries(e.string_args ?? {})) argRows.push({ k: `string[${k}]`, v })
  for (const [k, v] of Object.entries(e.fd_args ?? {})) argRows.push({ k: `fd[${k}]`, v })
  for (const [k, v] of Object.entries(e.sock_args ?? {})) argRows.push({ k: `sock[${k}]`, v })
  for (const [k, v] of Object.entries(e.out_args ?? {})) argRows.push({ k: `out[${k}]`, v })
  ;(e.args ?? []).forEach((v, i) => argRows.push({ k: `arg[${i}]`, v }))
  if (argRows.length) out.push({ title: 'Args', kind: 'kv', rows: argRows })
  if (e.java_stack?.length) out.push({ title: 'Java stack', kind: 'stack', lines: e.java_stack.slice() })
  if (e.backtrace.length) out.push({ title: 'Backtrace', kind: 'stack', lines: e.backtrace.map(f => `#${f.frame} ${f.symbol}`), highlight: appFrameIndex(e.backtrace) })
  return out
}

// Immediate native caller (backtrace[1], offset stripped), or '-'.
function funcCaller(e: FuncEvent): string {
  const s = e.backtrace[1]?.symbol
  return s ? s.replace(/\+0x[0-9a-fA-F]+$/, '') : '-'
}

// Render one funcs record's full detail (single-record mode, master-table row click).
export function showFuncsRecordDetail(host: HTMLElement, e: FuncEvent): void {
  host.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'insp-head'
  head.textContent = `#${e.id} · ${e.module}!${e.symbol} · tid ${e.tid}`
  host.appendChild(head)
  const detail = document.createElement('div')
  detail.className = 'insp-detail'
  renderFuncDetail(detail, e)
  host.appendChild(detail)
}

// DOM wrapper around funcDetailSections (mirrors renderEventDetail).
function renderFuncDetail(host: HTMLElement, e: FuncEvent): void {
  host.innerHTML = ''
  for (const sec of funcDetailSections(e)) {
    const card = document.createElement('div'); card.className = 'insp-card'
    const h = document.createElement('div'); h.className = 'insp-card-h'
    const t = document.createElement('span'); t.textContent = sec.title; h.appendChild(t)
    if (sec.kind === 'stack') { const c = document.createElement('span'); c.className = 'insp-card-cnt'; c.textContent = String(sec.lines.length); h.appendChild(c) }
    card.appendChild(h)
    if (sec.kind === 'kv') {
      const tbl = document.createElement('table'); tbl.className = 'insp-kv'
      for (const row of sec.rows) {
        const tr = document.createElement('tr')
        if (row.sub) tr.className = 'insp-kv-sub'
        const kd = document.createElement('td'); kd.textContent = row.k
        const vd = document.createElement('td'); vd.textContent = row.v
        tr.append(kd, vd); tbl.appendChild(tr)
      }
      card.appendChild(tbl)
    } else {
      card.appendChild(buildStackRows(sec))
    }
    host.appendChild(card)
  }
}

// Render the funcs records behind a clicked node: a compact table
// (# / caller / retval / elapsed / args); clicking a row shows that record's detail.
export function showFuncsNodeInspector(nodeId: string, records: FuncEvent[], page: InspectorPage, opts?: NodeInspectorOpts): void {
  const host = document.getElementById('inspector')
  if (!host) return
  host.innerHTML = ''
  host.appendChild(buildNodeHeader(nodeId, opts))
  host.appendChild(buildInspectorPager(page, records.length))

  const detail = document.createElement('div')
  detail.className = 'insp-detail'
  const scroll = document.createElement('div')
  scroll.className = 'insp-table-wrap'
  const table = document.createElement('table')
  table.className = 'insp-table'
  const thead = document.createElement('thead')
  const htr = document.createElement('tr')
  for (const h of ['#', 'caller', 'ret', 'elapsed', 'args']) {
    const th = document.createElement('th'); th.textContent = h; htr.appendChild(th)
  }
  thead.appendChild(htr); table.appendChild(thead)

  const tbody = document.createElement('tbody')
  let selected: HTMLTableRowElement | undefined
  for (const ev of records) {
    const tr = document.createElement('tr')
    const cells = [String(ev.id), funcCaller(ev),
      ev.retval === undefined ? '-' : String(ev.retval),
      ev.elapsed_ns === undefined ? '-' : `${ev.elapsed_ns} ns`, primaryFuncArg(ev)]
    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement('td')
      td.textContent = cells[i]
      if (i === 4) td.className = 'insp-arg'
      tr.appendChild(td)
    }
    tr.onclick = () => {
      selected?.classList.remove('sel'); tr.classList.add('sel'); selected = tr
      renderFuncDetail(detail, ev)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody); scroll.appendChild(table)
  host.appendChild(scroll); host.appendChild(detail)

  if (records[0]) {
    renderFuncDetail(detail, records[0])
    tbody.firstChild && (tbody.firstChild as HTMLTableRowElement).classList.add('sel')
    selected = tbody.firstChild as HTMLTableRowElement
  }
}
