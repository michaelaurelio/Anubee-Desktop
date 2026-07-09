// Floating offset-table popup for a selected native node: one row per call-site
// offset (offset / reaches / count / expand) and a right-click Copy / Copy-as-JSON
// menu. Positioned to the right of the node via placePopup. Row-expand is an inline
// accordion showing that offset's ground-truth event. Tagging is separate now
// (right-click -> Add Tag popup), not embedded here. See spec Phase 1b s3.2.
import type { OffsetRow } from '@shared/origins'
import { copyText, rowJson } from '@shared/origins'
import type { SyscallEvent } from '@shared/events'
import { formatEvent } from './inspector'

export interface NodeBox { left: number; top: number; right: number; bottom: number }
export interface PopupPlacement { left: number; top: number }

// Place a popup of (w,h) just right of the node box, flipping to its left when
// the right would overflow the viewport; vertically center on the node, clamped
// into the viewport. Pure - unit-tested without a DOM. See design s3.3.
export function placePopup(
  box: NodeBox, w: number, h: number, viewport: { w: number; h: number }, gap = 12,
): PopupPlacement {
  const left = box.right + gap + w <= viewport.w
    ? box.right + gap
    : Math.max(8, box.left - gap - w)
  const centered = box.top + (box.bottom - box.top - h) / 2
  const top = Math.max(8, Math.min(centered, viewport.h - h - 8))
  return { left, top }
}

export function popupState(rows: OffsetRow[]): { kind: 'rows' | 'empty'; rows: OffsetRow[] } {
  return { kind: rows.length ? 'rows' : 'empty', rows }
}

// The event behind a row's inline expand: the row's representative event
// (store-chosen via sampleEventId), else the first fetched event.
export function eventForOffset(events: SyscallEvent[], row: OffsetRow): SyscallEvent | undefined {
  return events.find(e => e.id === row.sampleEventId) ?? events[0]
}

let host: HTMLDivElement | undefined
let menu: HTMLDivElement | undefined
let onDocDown: ((e: MouseEvent) => void) | undefined
let onKeyDown: ((e: KeyboardEvent) => void) | undefined
let onMenuDown: ((e: MouseEvent) => void) | undefined

function closeRowMenu(): void {
  menu?.remove(); menu = undefined
  if (onMenuDown) { document.removeEventListener('mousedown', onMenuDown); onMenuDown = undefined }
}

export function closeOffsetPopup(): void {
  host?.remove(); host = undefined
  if (onDocDown) { document.removeEventListener('mousedown', onDocDown); onDocDown = undefined }
  if (onKeyDown) { document.removeEventListener('keydown', onKeyDown); onKeyDown = undefined }
  closeRowMenu()
}

interface ShowOpts {
  nodeId: string
  rows: OffsetRow[]
  anchor: NodeBox // the selected node's on-screen box; the popup sits to its right
  eventForOffset: (row: OffsetRow) => SyscallEvent | undefined
}

export function showOffsetPopup(opts: ShowOpts): void {
  closeOffsetPopup()
  host = document.createElement('div')
  host.className = 'offset-popup'
  const { left, top } = placePopup(opts.anchor, 400, 300, { w: window.innerWidth, h: window.innerHeight })
  Object.assign(host.style, { position: 'fixed', left: left + 'px', top: top + 'px', zIndex: '50' })

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
      const reaches = document.createElement('span'); reaches.className = 'reaches-cell'; reaches.textContent = r.syscall
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
          const ev = opts.eventForOffset(r)
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

  document.body.appendChild(host)

  // Dismiss on outside-click / Esc.
  setTimeout(() => {
    onDocDown = (e: MouseEvent) => { if (host && !host.contains(e.target as Node)) closeOffsetPopup() }
    onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeOffsetPopup() }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKeyDown)
  }, 0)
}

function openRowMenu(x: number, y: number, row: OffsetRow): void {
  closeRowMenu()
  menu = document.createElement('div')
  menu.className = 'offset-row-menu'
  Object.assign(menu.style, { position: 'fixed', left: x + 'px', top: y + 'px', zIndex: '60' })
  const item = (text: string, fn: () => void) => {
    const b = document.createElement('div'); b.className = 'offset-menu-item'; b.textContent = text
    b.onclick = () => { fn(); closeRowMenu() }
    menu!.appendChild(b)
  }
  item('Copy', () => void window.ares.copyToClipboard(copyText(row)))
  item('Copy as JSON', () => void window.ares.copyToClipboard(rowJson(row)))
  document.body.appendChild(menu)
  setTimeout(() => {
    onMenuDown = (e: MouseEvent) => { if (menu && !menu.contains(e.target as Node)) closeRowMenu() }
    document.addEventListener('mousedown', onMenuDown)
  }, 0)
}
