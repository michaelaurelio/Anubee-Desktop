// Pure layout state for the adjustable body panels. Persisted to localStorage by
// the DOM layer (wirePanels, Task 4); these functions never touch the DOM.
export interface LayoutState {
  tableW: number
  sideW: number
  tableCollapsed: boolean
  sideCollapsed: boolean
}

export const MIN_W = 160
export const MAX_W = 760
export const DEFAULT_LAYOUT: LayoutState = {
  tableW: 420, sideW: 320, tableCollapsed: false, sideCollapsed: false,
}

export function clampWidth(w: number): number {
  return Math.max(MIN_W, Math.min(MAX_W, w))
}

export function serializeLayout(s: LayoutState): string {
  return JSON.stringify(s)
}

export function parseLayout(raw: string | null): LayoutState {
  if (!raw) return { ...DEFAULT_LAYOUT }
  let o: Partial<LayoutState>
  try {
    o = JSON.parse(raw) as Partial<LayoutState>
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
  return {
    tableW: typeof o.tableW === 'number' ? clampWidth(o.tableW) : DEFAULT_LAYOUT.tableW,
    sideW: typeof o.sideW === 'number' ? clampWidth(o.sideW) : DEFAULT_LAYOUT.sideW,
    tableCollapsed: typeof o.tableCollapsed === 'boolean' ? o.tableCollapsed : DEFAULT_LAYOUT.tableCollapsed,
    sideCollapsed: typeof o.sideCollapsed === 'boolean' ? o.sideCollapsed : DEFAULT_LAYOUT.sideCollapsed,
  }
}
