// Master-table pager: page math, the jump input, button state and the row
// flash. Positions are 1-based rows of the current (possibly filtered) table,
// not record ids. Jumping only moves the page window; it never touches the
// filter or the graph.

// A position clamped into [1, total]; 0 when the table is empty.
export function clampPosition(n: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(1, Math.min(total, Math.trunc(n)))
}

// Offset of the page that holds row n: 12345 -> 12000 (rows 12001-12500),
// 12000 -> 11500 (rows 11501-12000). Out-of-range n lands on the first/last page.
export function pageOffsetFor(n: number, total: number, pageSize: number): number {
  const pos = clampPosition(n, total)
  return pos === 0 ? 0 : Math.floor((pos - 1) / pageSize) * pageSize
}

export function lastPageOffset(total: number, pageSize: number): number {
  return total <= 0 ? 0 : Math.floor((total - 1) / pageSize) * pageSize
}

// Read a typed position: digits with optional `,` `_` or space separators and
// an optional leading `-`. Anything else (12k, 1.5, 1e5, empty) is undefined.
export function parsePosition(text: string): number | undefined {
  const s = text.replace(/[,_\s]/g, '')
  return /^-?\d+$/.test(s) ? Number(s) : undefined
}

export interface RangeEditOpts {
  range: HTMLElement        // the "1–500 / N" text; click to edit
  editor: HTMLElement       // wrapper holding the input + total label, hidden when idle
  input: HTMLInputElement
  totalLabel: HTMLElement
  total: () => number
  current: () => number     // first row of the shown page, pre-filled on open
  onJump: (position: number) => void
}

// Turn the pager's range text into a jump input. Enter jumps to the typed
// position; Escape, blur or a non-number cancels. Handlers are assigned (not
// added) so wiring twice replaces rather than stacks.
export function wireRangeEdit(o: RangeEditOpts): void {
  let open = false
  // Idempotent: hiding the focused input after Enter fires blur, which must not
  // close (or jump) a second time.
  const close = (): void => {
    if (!open) return
    open = false
    o.editor.classList.add('hidden')
    o.range.classList.remove('hidden')
  }
  o.range.onclick = () => {
    const total = o.total()
    if (total <= 0) return
    open = true
    o.totalLabel.textContent = `/ ${total}`
    o.input.value = String(o.current())
    o.range.classList.add('hidden')
    o.editor.classList.remove('hidden')
    o.input.focus()
    o.input.select() // typing replaces the pre-filled position
  }
  o.input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const n = parsePosition(o.input.value)
      close()
      if (n !== undefined) o.onJump(n)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }
  o.input.onblur = close
}

// Paint the table-header pager: range text plus first/prev/next/last state.
// Missing elements are skipped.
export function renderPager(offset: number, pageLen: number, total: number, pageSize: number): void {
  const rng = document.getElementById('pager-range')
  const btn = (id: string) => document.getElementById(id) as HTMLButtonElement | null
  if (rng) rng.textContent = total === 0 ? '0 / 0' : `${offset + 1}–${offset + pageLen} / ${total}`
  const atStart = offset <= 0
  const atEnd = offset + pageSize >= total
  const first = btn('pager-first'), prev = btn('pager-prev'), next = btn('pager-next'), last = btn('pager-last')
  if (first) first.disabled = atStart
  if (prev) prev.disabled = atStart
  if (next) next.disabled = atEnd
  if (last) last.disabled = offset >= lastPageOffset(total, pageSize)
}

// Scroll the jumped-to row into view and flash it. pageIndex is 0-based within
// the page; table row 0 is the header (see renderTable). Does not select it.
export function flashTableRow(host: HTMLElement, pageIndex: number): void {
  const tr = host.querySelector('table')?.rows[pageIndex + 1]
  if (pageIndex < 0 || !tr) return
  tr.scrollIntoView({ block: 'center' })
  tr.classList.remove('flash')
  void tr.offsetWidth // reflow so a repeat jump to the same row restarts the animation
  tr.classList.add('flash')
  tr.addEventListener('animationend', () => tr.classList.remove('flash'), { once: true })
}
