import { logGetAll, logSubscribe, logClear, type LogEntry } from './log-store'

function hhmmss(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function lineEl(e: LogEntry): HTMLDivElement {
  const div = document.createElement('div')
  div.className = `log-line log-${e.level}`
  div.textContent = `${hhmmss(e.ts)} [${e.label}] ${e.message}`
  return div
}

// Render the activity-log terminal into `host` and keep it live. Returns a
// cleanup that unsubscribes - the caller runs it on modal close.
export function renderLogModal(host: HTMLElement): () => void {
  host.innerHTML = ''

  const term = document.createElement('div')
  term.className = 'log-term'

  const draw = (): void => {
    term.innerHTML = ''
    const all = logGetAll()
    if (all.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'log-empty'
      empty.textContent = 'No activity yet'
      term.appendChild(empty)
      return
    }
    for (const e of all) term.appendChild(lineEl(e))
    term.scrollTop = term.scrollHeight
  }
  draw()

  const unsub = logSubscribe(e => {
    // logClear notifies with an empty label - redraw from scratch.
    if (e.label === '' && e.message === '') { draw(); return }
    const pinned = term.scrollTop + term.clientHeight >= term.scrollHeight - 4
    const emptyMsg = term.querySelector('.log-empty')
    if (emptyMsg) term.innerHTML = ''
    term.appendChild(lineEl(e))
    if (pinned) term.scrollTop = term.scrollHeight
  })

  const bar = document.createElement('div')
  bar.className = 'log-actions'
  const clear = document.createElement('button')
  clear.className = 'btn'; clear.textContent = 'Clear'
  clear.onclick = () => logClear()
  bar.appendChild(clear)

  host.appendChild(term)
  host.appendChild(bar)
  return unsub
}
