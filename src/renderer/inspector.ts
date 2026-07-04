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

// Render the records behind a clicked node into #inspector: the node id, the
// count, a clickable list, and the selected record's formatted detail. Cells use
// textContent so trace strings can't inject markup. DOM side-effect, not unit-tested.
export function showNodeInspector(nodeId: string, events: SyscallEvent[]): void {
  const host = document.getElementById('inspector')
  if (!host) return
  host.innerHTML = ''

  const head = document.createElement('div')
  head.style.fontWeight = 'bold'
  head.style.marginBottom = '6px'
  head.textContent = `${nodeId} - ${events.length} record(s)`
  host.appendChild(head)

  const detail = document.createElement('pre')
  detail.style.whiteSpace = 'pre-wrap'
  detail.style.marginTop = '8px'
  detail.style.borderTop = '1px solid #eee'
  detail.style.paddingTop = '6px'

  const list = document.createElement('div')
  for (const ev of events.slice(0, 500)) {
    const item = document.createElement('a')
    item.href = '#'
    item.style.display = 'block'
    item.style.textDecoration = 'none'
    item.style.color = '#2563eb'
    item.style.padding = '1px 0'
    item.textContent = `#${ev.id} ${ev.syscall} (tid ${ev.tid})`
    item.onclick = evt => {
      evt.preventDefault()
      detail.textContent = formatEvent(ev)
    }
    list.appendChild(item)
  }
  host.appendChild(list)
  host.appendChild(detail)

  if (events[0]) detail.textContent = formatEvent(events[0])
}
