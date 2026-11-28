// Master-table pager: page math for jumping to a typed row position. Positions
// are 1-based rows of the current (possibly filtered) table, not record ids.
// Jumping only moves the page window; it never touches the filter or graph.

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
    o.input.value = ''
    o.range.classList.add('hidden')
    o.editor.classList.remove('hidden')
    o.input.focus()
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
