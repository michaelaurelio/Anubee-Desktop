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

const LS_KEY = 'ares.layout'

// Restore + wire the adjustable body panels. Widths drive CSS vars on #main;
// collapse toggles a `.collapsed` class. State persists to localStorage (UI chrome
// preference, deliberately not the run sidecar).
export function wirePanels(root: HTMLElement): void {
  const main = root.querySelector<HTMLElement>('#main')
  const table = root.querySelector<HTMLElement>('#table')
  const side = root.querySelector<HTMLElement>('#side')
  if (!main || !table || !side) return

  let state: LayoutState = parseLayout(localStorage.getItem(LS_KEY))
  const apply = (): void => {
    main.style.setProperty('--table-w', `${state.tableW}px`)
    main.style.setProperty('--side-w', `${state.sideW}px`)
    table.classList.toggle('collapsed', state.tableCollapsed)
    side.classList.toggle('collapsed', state.sideCollapsed)
    // Keep chevron glyphs in sync with collapsed state (incl. on restore from
    // localStorage), so a persisted-collapsed panel doesn't show a backwards arrow.
    for (const c of root.querySelectorAll<HTMLElement>('.panel-chevron')) {
      if (c.dataset.target === 'table') c.textContent = state.tableCollapsed ? '›' : '‹'
      if (c.dataset.target === 'side') c.textContent = state.sideCollapsed ? '‹' : '›'
    }
  }
  const save = (): void => localStorage.setItem(LS_KEY, serializeLayout(state))
  apply()

  for (const h of root.querySelectorAll<HTMLElement>('.resize-handle')) {
    const which = h.dataset.resize as 'table' | 'side'
    h.addEventListener('pointerdown', down => {
      down.preventDefault()
      h.setPointerCapture(down.pointerId)
      const startX = down.clientX
      const startW = which === 'table' ? state.tableW : state.sideW
      const move = (e: PointerEvent): void => {
        // table grows as the pointer moves right; side grows as it moves left.
        const delta = which === 'table' ? e.clientX - startX : startX - e.clientX
        const w = clampWidth(startW + delta)
        if (which === 'table') state.tableW = w; else state.sideW = w
        apply()
      }
      const up = (): void => {
        h.removeEventListener('pointermove', move)
        h.removeEventListener('pointerup', up)
        save()
      }
      h.addEventListener('pointermove', move)
      h.addEventListener('pointerup', up)
    })
  }

  for (const c of root.querySelectorAll<HTMLElement>('.panel-chevron')) {
    c.addEventListener('click', () => {
      const t = c.dataset.target
      if (t === 'table') state.tableCollapsed = !state.tableCollapsed
      if (t === 'side') state.sideCollapsed = !state.sideCollapsed
      apply(); save() // apply() now syncs the chevron glyph
    })
  }
}
