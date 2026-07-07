// Single source of truth for the graph + flame kind colors per theme. index.html
// carries the CSS-token equivalents; cytoscape and the flame SVG can't read CSS
// vars, so they consume these. Keeping one map here removes the old triplication
// (cy style / #legend / flame KIND_FILL).
export type Theme = 'dark' | 'light'

export interface KindColors {
  java: string
  native: string
  syscall: string
  labelBacking: string // backing behind cytoscape node labels; must contrast the canvas
  labelText: string // node-label text color; mirrors the --text token per theme
  edge: string
}

const DARK: KindColors = {
  java: '#5fd28f', native: '#6fa8ff', syscall: '#ff8b7a',
  labelBacking: '#1a1f2b', labelText: '#c9d1e0', edge: '#3a4556',
}
const LIGHT: KindColors = {
  java: '#27ae60', native: '#2980b9', syscall: '#c0392b',
  labelBacking: '#ffffff', labelText: '#1e2530', edge: '#b0b0b0',
}

export function themeColors(theme: Theme): KindColors {
  return theme === 'light' ? LIGHT : DARK
}

export function parseTheme(raw: string | null): Theme {
  return raw === 'light' ? 'light' : 'dark'
}

export function serializeTheme(theme: Theme): string {
  return theme
}
