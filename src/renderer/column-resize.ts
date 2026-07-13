// Pure width math + width application for per-column drag resize. The drag event
// wiring lives in main.ts; this module owns the clamp + DOM width application so
// it is unit-testable.

export const MIN_COL = 48
export const MAX_COL = 640

export function clampColWidth(px: number): number {
  return Math.max(MIN_COL, Math.min(MAX_COL, Math.round(px)))
}

export function nextWidth(startW: number, dx: number): number {
  return clampColWidth(startW + dx)
}

// Apply persisted per-column widths onto the rendered table. Widths are keyed by
// ColumnKey; a `col-<key>` class marks both the <th> and its <td>s.
export function applyWidths(host: HTMLElement, widths: Record<string, number>): void {
  for (const [key, w] of Object.entries(widths)) {
    for (const el of host.querySelectorAll<HTMLElement>(`.col-${key}`)) {
      el.style.width = `${clampColWidth(w)}px`
    }
  }
}
