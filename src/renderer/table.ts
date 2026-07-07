import type { TableRow } from '@shared/table'

// Render the master table into #table. Cells use textContent (not innerHTML) so
// trace-derived strings can never inject markup. Clicking a row selects it.
export function renderTable(
  rows: TableRow[],
  onSelect: (row: TableRow) => void,
  badgeFor: (row: TableRow) => string = () => '',
): void {
  const host = document.querySelector<HTMLElement>('#table .table-scroll')
  if (!host) return
  host.innerHTML = ''

  const tbl = document.createElement('table')
  const head = tbl.insertRow()
  for (const h of ['id', 'tid', 'syscall', 'java?', 'top java', 'top native', 'tags']) {
    const th = document.createElement('th')
    th.textContent = h
    th.title = h // header may ellipsis-truncate in a narrow column
    head.appendChild(th)
  }

  for (const r of rows) {
    const tr = tbl.insertRow()
    const cells = [String(r.id), String(r.tid), r.syscall, r.hasJava ? '✓' : '',
      r.topJava ?? '', r.topNative ?? '', badgeFor(r)]
    for (const c of cells) {
      const td = tr.insertCell()
      td.textContent = c
      if (c) td.title = c // full value on hover, since wide cells ellipsis-truncate
    }
    tr.style.cursor = 'pointer'
    tr.onclick = () => onSelect(r)
  }

  host.appendChild(tbl)
}
