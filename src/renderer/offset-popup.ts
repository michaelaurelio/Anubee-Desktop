// Floating popup for a selected native node: a read-only per-syscall histogram
// (syscall / count), one row per distinct syscall reached through the node.
// Non-interactive - the offset for a specific record is seen in that record's
// detail card in the inspector. Positioned right of the node via placePopup.
import type { OffsetRow } from '@shared/origins'

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

// Fold a node's per-offset rows into a per-syscall histogram: sum counts across
// offsets that reach the same syscall, ordered by count desc then syscall asc.
// Pure - unit-tested.
export function aggregateBySyscall(rows: OffsetRow[]): { syscall: string; count: number }[] {
  const totals = new Map<string, number>()
  for (const r of rows) totals.set(r.syscall, (totals.get(r.syscall) ?? 0) + r.count)
  return [...totals]
    .map(([syscall, count]) => ({ syscall, count }))
    .sort((a, b) => b.count - a.count || a.syscall.localeCompare(b.syscall))
}

let host: HTMLDivElement | undefined
let onDocDown: ((e: MouseEvent) => void) | undefined
let onKeyDown: ((e: KeyboardEvent) => void) | undefined

export function closeOffsetPopup(): void {
  host?.remove(); host = undefined
  if (onDocDown) { document.removeEventListener('mousedown', onDocDown); onDocDown = undefined }
  if (onKeyDown) { document.removeEventListener('keydown', onKeyDown); onKeyDown = undefined }
}

interface ShowOpts {
  nodeId: string
  rows: OffsetRow[]
  anchor: NodeBox // the selected node's on-screen box; the popup sits to its right
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
    for (const r of aggregateBySyscall(state.rows)) {
      const rowEl = document.createElement('div')
      rowEl.className = 'offset-row'
      const line = document.createElement('div')
      line.className = 'offset-row-line'
      const reaches = document.createElement('span'); reaches.className = 'reaches-cell'; reaches.textContent = r.syscall
      const cnt = document.createElement('span'); cnt.className = 'count-cell'; cnt.textContent = String(r.count)
      line.append(reaches, cnt)
      rowEl.append(line)
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
