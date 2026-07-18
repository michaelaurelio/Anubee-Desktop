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

const LS_KEY = 'anubee.layout'

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
    // The square collapse button shows the panel SVG icon; toggling `.collapsed`
    // flips its direction via CSS (transform: scaleX(-1)) instead of overwriting
    // the icon markup. Kept in sync on restore from localStorage too.
    const tab = root.querySelector<HTMLElement>('#tab-left')
    if (tab) tab.classList.toggle('collapsed', state.tableCollapsed)
  }
  const save = (): void => localStorage.setItem(LS_KEY, serializeLayout(state))
  apply()

  for (const h of root.querySelectorAll<HTMLElement>('.resize-handle')) {
    const which = h.dataset.resize as 'table' | 'side'
    h.addEventListener('pointerdown', down => {
      down.preventDefault()
      const startX = down.clientX
      const startW = which === 'table' ? state.tableW : state.sideW
      // Listen on window (not the 5px handle) for the duration of the drag: the
      // pointer leaves the handle immediately, and window delivery is robust for
      // both real input and synthetic (CDP/Playwright) events - no pointer capture.
      const move = (e: PointerEvent): void => {
        // table grows as the pointer moves right; side grows as it moves left.
        const delta = which === 'table' ? e.clientX - startX : startX - e.clientX
        const w = clampWidth(startW + delta)
        if (which === 'table') state.tableW = w; else state.sideW = w
        apply()
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        save()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })
  }

  root.querySelector<HTMLElement>('#tab-left')?.addEventListener('click', () => {
    state.tableCollapsed = !state.tableCollapsed
    apply(); save() // apply() syncs the button arrow
  })
}
