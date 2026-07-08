import type { SyscallEvent } from '@shared/events'

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

  if (e.java_stack?.length) lines.push('java_stack:\n' + e.java_stack.map(m => `  ${m}`).join('\n'))

  lines.push('backtrace:\n' + e.backtrace.map(f => `  #${f.frame} ${f.symbol}`).join('\n'))
  return lines.join('\n')
}

// The single most informative argument for the inspector table's `args` column:
// the resolved path/string arg if present, else the fd path, else the decoded
// args, else the raw args. Pure and unit-tested.
export function primaryArg(e: SyscallEvent): string {
  const strs = Object.values(e.string_args)
  if (strs.length) return strs.join(' ')
  const fds = Object.values(e.fd_args)
  if (fds.length) return fds.join(' ')
  const dec = Object.values(e.decoded_args)
  if (dec.length) return dec.join(' ')
  return e.args.join(' ')
}

// Render the records behind a clicked node into #inspector as a compact table
// (id, syscall, tid, retval, primary arg); clicking a row shows that record's
// full formatted detail below. Cells use textContent so trace strings can't
// inject markup. DOM side-effect, not unit-tested.
export function showNodeInspector(nodeId: string, events: SyscallEvent[]): void {
  const host = document.getElementById('inspector')
  if (!host) return
  host.innerHTML = ''

  const head = document.createElement('div')
  head.className = 'insp-head'
  head.textContent = `${nodeId} - ${events.length} record(s)`
  host.appendChild(head)

  const detail = document.createElement('pre')
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
  for (const ev of events.slice(0, 500)) {
    const tr = document.createElement('tr')
    const cells = [String(ev.id), ev.syscall, String(ev.tid), String(ev.retval), primaryArg(ev)]
    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement('td')
      td.textContent = cells[i]
      if (i === 4) td.className = 'insp-arg' // let the args column wrap/truncate
      tr.appendChild(td)
    }
    tr.onclick = () => {
      selected?.classList.remove('sel')
      tr.classList.add('sel')
      selected = tr
      detail.textContent = formatEvent(ev)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  scroll.appendChild(table)
  host.appendChild(scroll)
  host.appendChild(detail)

  if (events[0]) {
    detail.textContent = formatEvent(events[0])
    tbody.firstChild && (tbody.firstChild as HTMLTableRowElement).classList.add('sel')
    selected = tbody.firstChild as HTMLTableRowElement
  }
}
