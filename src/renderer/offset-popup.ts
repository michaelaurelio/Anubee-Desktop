// Floating offset-table popup for a selected native node: one row per call-site
// offset (offset / reaches / count / expand), a moved-in tag editor, and a
// right-click Copy / Copy-as-JSON menu. Row-expand is an inline accordion showing
// that offset's ground-truth event. See spec Phase 1b s3.2.
import type { OffsetRow } from '@shared/origins'
import { copyText, rowJson } from '@shared/origins'
import type { SyscallEvent } from '@shared/events'
import { formatEvent } from './inspector'

export function popupState(rows: OffsetRow[]): { kind: 'rows' | 'empty'; rows: OffsetRow[] } {
  return { kind: rows.length ? 'rows' : 'empty', rows }
}

let host: HTMLDivElement | undefined
let menu: HTMLDivElement | undefined

export function closeOffsetPopup(): void {
  host?.remove(); host = undefined
  menu?.remove(); menu = undefined
}

interface ShowOpts {
  nodeId: string
  rows: OffsetRow[]
  anchor: { x: number; y: number }
  tagHost: (h: HTMLElement) => void
  eventForOffset: (offset: string) => SyscallEvent | undefined
}

export function showOffsetPopup(opts: ShowOpts): void {
  closeOffsetPopup()
  host = document.createElement('div')
  host.className = 'offset-popup'
  // Static position at the click, clamped to the viewport (approx size 360x300).
  const x = Math.min(opts.anchor.x, window.innerWidth - 372)
  const y = Math.min(opts.anchor.y, window.innerHeight - 312)
  Object.assign(host.style, { position: 'fixed', left: Math.max(8, x) + 'px', top: Math.max(8, y) + 'px', zIndex: '50' })

  const head = document.createElement('div')
  head.className = 'offset-popup-head'
  head.textContent = opts.nodeId
  host.appendChild(head)

  const state = popupState(opts.rows)
  if (state.kind === 'empty') {
    const note = document.createElement('div')
    note.className = 'offset-popup-empty'
    note.textContent = 'no call-sites in the current filter'
    host.appendChild(note)
  } else {
    const table = document.createElement('div')
    table.className = 'offset-popup-rows'
    for (const r of state.rows) {
      const rowEl = document.createElement('div')
      rowEl.className = 'offset-row'
      const line = document.createElement('div')
      line.className = 'offset-row-line'
      const off = document.createElement('span'); off.className = 'offset-cell'; off.textContent = r.offset
      const reaches = document.createElement('span'); reaches.className = 'reaches-cell'; reaches.textContent = r.reaches.join(' ')
      const cnt = document.createElement('span'); cnt.className = 'count-cell'; cnt.textContent = String(r.count)
      line.append(off, reaches, cnt)
      const detail = document.createElement('pre')
      detail.className = 'offset-row-detail'
      detail.style.display = 'none'
      detail.style.whiteSpace = 'pre-wrap'
      line.onclick = () => {
        const open = detail.style.display !== 'none'
        table.querySelectorAll('pre.offset-row-detail').forEach(p => ((p as HTMLElement).style.display = 'none'))
        if (!open) {
          const ev = opts.eventForOffset(r.offset)
          detail.textContent = ev ? formatEvent(ev) : '(no sample event)'
          detail.style.display = 'block'
        }
      }
      rowEl.oncontextmenu = e => { e.preventDefault(); openRowMenu(e.clientX, e.clientY, r) }
      rowEl.append(line, detail)
      table.appendChild(rowEl)
    }
    host.appendChild(table)
  }

  const tagBox = document.createElement('div')
  opts.tagHost(tagBox)
  host.appendChild(tagBox)

  document.body.appendChild(host)

  // Dismiss on outside-click / Esc.
  setTimeout(() => {
    const onDoc = (e: MouseEvent) => { if (host && !host.contains(e.target as Node)) { closeOffsetPopup(); document.removeEventListener('mousedown', onDoc) } }
    document.addEventListener('mousedown', onDoc)
  }, 0)
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { closeOffsetPopup(); document.removeEventListener('keydown', esc) } })
}

function openRowMenu(x: number, y: number, row: OffsetRow): void {
  menu?.remove()
  menu = document.createElement('div')
  menu.className = 'offset-row-menu'
  Object.assign(menu.style, { position: 'fixed', left: x + 'px', top: y + 'px', zIndex: '60' })
  const item = (text: string, fn: () => void) => {
    const b = document.createElement('div'); b.className = 'offset-menu-item'; b.textContent = text
    b.onclick = () => { fn(); menu?.remove(); menu = undefined }
    menu!.appendChild(b)
  }
  item('Copy', () => void navigator.clipboard.writeText(copyText(row)))
  item('Copy as JSON', () => void navigator.clipboard.writeText(rowJson(row)))
  document.body.appendChild(menu)
  setTimeout(() => {
    const onDoc = (e: MouseEvent) => { if (menu && !menu.contains(e.target as Node)) { menu.remove(); menu = undefined; document.removeEventListener('mousedown', onDoc) } }
    document.addEventListener('mousedown', onDoc)
  }, 0)
}
