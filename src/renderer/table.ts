import type { TableRow } from '@shared/table'

// Render the master table into #table. Cells use textContent (not innerHTML) so
// trace-derived strings can never inject markup. Clicking a row selects it.
export function renderTable(rows: TableRow[], onSelect: (row: TableRow) => void): void {
  const host = document.getElementById('table')
  if (!host) return
  host.innerHTML = ''

  const tbl = document.createElement('table')
  const head = tbl.insertRow()
  for (const h of ['id', 'tid', 'syscall', 'java?', 'top java', 'top native']) {
    const th = document.createElement('th')
    th.textContent = h
    head.appendChild(th)
  }

  for (const r of rows) {
    const tr = tbl.insertRow()
    const cells = [String(r.id), String(r.tid), r.syscall, r.hasJava ? '✓' : '', r.topJava ?? '', r.topNative ?? '']
    for (const c of cells) tr.insertCell().textContent = c
    tr.style.cursor = 'pointer'
    tr.onclick = () => onSelect(r)
  }

  host.appendChild(tbl)
}
