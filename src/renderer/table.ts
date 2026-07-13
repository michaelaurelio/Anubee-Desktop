import type { TableRow } from '@shared/table'
import { ALL_COLUMNS, type ColumnKey } from './columns'
import { javaLeaf, nativeLeaf, formatDuration } from './call-site'

const LABEL = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, c.label])) as Record<ColumnKey, string>

function span(cls: string, text: string): HTMLElement {
  const s = document.createElement('span')
  s.className = cls
  s.textContent = text        // trace-derived text is never innerHTML
  s.title = text
  return s
}

// Build the merged call-site cell for one row. Syscall: java leaf over native
// leaf (arrow only when paired); native-only -> single native line; neither ->
// "— no backtrace". Funcs: function over "◂ from" caller.
function renderCallSite(td: HTMLElement, r: TableRow): void {
  td.classList.add('cs')
  if (r.engine === 'func') {
    td.appendChild(span('cs-fn', nativeLeaf(r.fn ?? '')))
    if (r.caller) td.appendChild(span('cs-caller', nativeLeaf(r.caller)))
    else td.appendChild(span('cs-caller cs-top', '— top frame'))
    return
  }
  if (r.topJava && r.topNative) {
    td.classList.add('paired')
    td.appendChild(span('cs-java', javaLeaf(r.topJava)))
    td.appendChild(span('cs-native', nativeLeaf(r.topNative)))
  } else if (r.topNative) {
    td.appendChild(span('cs-native', nativeLeaf(r.topNative)))
  } else {
    td.appendChild(span('cs-none', '— no backtrace'))
  }
}

function renderTags(td: HTMLElement, badge: string): void {
  if (!badge) return
  for (const t of badge.split(',').map(s => s.trim()).filter(Boolean)) {
    const chip = span(`chip cat-${t}`, t)
    td.appendChild(chip)
  }
}

function renderElapsed(td: HTMLElement, r: TableRow, max: number): void {
  if (r.elapsed === null || r.elapsed === undefined) { td.textContent = '—'; return }
  td.appendChild(span('dur', formatDuration(r.elapsed)))
  const bar = document.createElement('div')
  bar.className = 'bar' + (max > 0 && r.elapsed >= max ? ' hot' : '')
  bar.style.width = max > 0 ? `${Math.round((r.elapsed / max) * 100)}%` : '0%'
  td.appendChild(bar)
}

function renderRetval(td: HTMLElement, r: TableRow): void {
  if (r.retval === null || r.retval === undefined) { td.textContent = '—'; return }
  const neg = r.retval < 0
  td.appendChild(span(neg ? 'neg' : '', String(r.retval)))
}

// Simple text columns: value + title, empty -> ''.
const TEXT: Partial<Record<ColumnKey, (r: TableRow) => string>> = {
  id: r => String(r.id),
  tid: r => String(r.tid),
  syscall: r => r.syscall,
  java: r => (r.hasJava ? '✓' : ''),
  topJava: r => r.topJava ?? '',
  topNative: r => r.topNative ?? '',
  fn: r => r.fn ?? '',
  caller: r => r.caller ?? '',
  arg: r => r.arg,
}

// Render the master table. Cells that carry structure (callSite, tags, elapsed,
// retval) build child elements; the rest set textContent. `elapsedMax` scales
// the funcs duration bar (pass the visible page's max elapsed, or 0 to hide bars).
export function renderTable(
  rows: TableRow[],
  columns: ColumnKey[],
  onSelect: (row: TableRow) => void,
  badgeFor: (row: TableRow) => string = () => '',
  elapsedMax = 0,
): void {
  const host = document.querySelector<HTMLElement>('#table .table-scroll')
  if (!host) return
  host.innerHTML = ''

  const tbl = document.createElement('table')
  const head = tbl.insertRow()
  for (const key of columns) {
    const th = document.createElement('th')
    th.className = `col-${key}`
    th.textContent = LABEL[key]
    th.title = LABEL[key]
    head.appendChild(th)
  }

  for (const r of rows) {
    const tr = tbl.insertRow()
    tr.dataset.rowId = String(r.id)
    const badge = badgeFor(r)
    for (const key of columns) {
      const td = tr.insertCell()
      td.className = `col-${key}`
      if (key === 'callSite') renderCallSite(td, r)
      else if (key === 'tags') renderTags(td, badge)
      else if (key === 'elapsed') renderElapsed(td, r, elapsedMax)
      else if (key === 'retval') renderRetval(td, r)
      else {
        const c = TEXT[key]?.(r) ?? ''
        td.textContent = c
        if (c) td.title = c
      }
    }
    tr.style.cursor = 'pointer'
    tr.onclick = () => onSelect(r)
  }

  host.appendChild(tbl)
}
