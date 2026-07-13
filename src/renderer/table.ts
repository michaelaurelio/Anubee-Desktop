import type { TableRow } from '@shared/table'
import { ALL_COLUMNS, type ColumnKey } from './columns'

const LABEL = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, c.label])) as Record<ColumnKey, string>

// The text a given column shows for a row. `tags` is the only column that
// depends on external state, so it takes the pre-computed badge string.
const CELL: Record<ColumnKey, (r: TableRow, badge: string) => string> = {
  id: r => String(r.id),
  tid: r => String(r.tid),
  syscall: r => r.syscall,
  java: r => (r.hasJava ? '✓' : ''),
  topJava: r => r.topJava ?? '',
  topNative: r => r.topNative ?? '',
  fn: r => r.fn ?? '',
  caller: r => r.caller ?? '',
  retval: r => (r.retval === null || r.retval === undefined ? '' : String(r.retval)),
  elapsed: r => (r.elapsed === null || r.elapsed === undefined ? '' : `${r.elapsed} ns`),
  arg: r => r.arg,
  tags: (_r, badge) => badge,
  callSite: () => '', // Task 2: placeholder for merged call-site rendering (TBD)
}

// Render the master table into #table from a caller-chosen ordered column set.
// Cells use textContent (not innerHTML) so trace-derived strings can never
// inject markup. Each row carries data-row-id so the renderer can highlight the
// selected record. Clicking a row selects it.
export function renderTable(
  rows: TableRow[],
  columns: ColumnKey[],
  onSelect: (row: TableRow) => void,
  badgeFor: (row: TableRow) => string = () => '',
): void {
  const host = document.querySelector<HTMLElement>('#table .table-scroll')
  if (!host) return
  host.innerHTML = ''

  const tbl = document.createElement('table')
  const head = tbl.insertRow()
  for (const key of columns) {
    const th = document.createElement('th')
    th.className = `col-${key}` // width is keyed by column, not position (columns are configurable)
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
      const c = CELL[key](r, badge)
      td.textContent = c
      if (c) td.title = c
    }
    tr.style.cursor = 'pointer'
    tr.onclick = () => onSelect(r)
  }

  host.appendChild(tbl)
}
