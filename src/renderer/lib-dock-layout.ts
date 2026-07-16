// Pure layout state for the Native Libraries dock (tabbed artifacts + log).
// Persisted to localStorage by native-lib-view (UI chrome, deliberately not the
// run sidecar). Mirrors panels.ts on the vertical axis; no DOM here.
export interface DockLayout {
  height: number
  collapsed: boolean
  activeTab: 'artifacts' | 'log'
}

export const MIN_H = 90
export const MAX_H = 520
export const DEFAULT_DOCK: DockLayout = { height: 180, collapsed: true, activeTab: 'artifacts' }

export function clampHeight(h: number): number {
  return Math.max(MIN_H, Math.min(MAX_H, h))
}

export function serializeDock(s: DockLayout): string {
  return JSON.stringify(s)
}

const TABS: readonly DockLayout['activeTab'][] = ['artifacts', 'log']

export function parseDock(raw: string | null): DockLayout {
  if (!raw) return { ...DEFAULT_DOCK }
  let o: Partial<DockLayout>
  try { o = JSON.parse(raw) as Partial<DockLayout> } catch { return { ...DEFAULT_DOCK } }
  return {
    height: typeof o.height === 'number' ? clampHeight(o.height) : DEFAULT_DOCK.height,
    collapsed: typeof o.collapsed === 'boolean' ? o.collapsed : DEFAULT_DOCK.collapsed,
    activeTab: TABS.includes(o.activeTab as DockLayout['activeTab']) ? o.activeTab as DockLayout['activeTab'] : DEFAULT_DOCK.activeTab,
  }
}
