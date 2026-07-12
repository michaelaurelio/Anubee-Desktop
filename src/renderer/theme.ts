import type { RaspCategory } from '@shared/project-store'
import type { EdgeEngine } from '@shared/graph-shape'

// Single source of truth for the graph + flame kind colors per theme. index.html
// carries the CSS-token equivalents; cytoscape and the flame SVG can't read CSS
// vars, so they consume these. Keeping one map here removes the old triplication
// (cy style / #legend / flame KIND_FILL).
export type Theme = 'dark' | 'light'

export interface KindColors {
  java: string
  native: string
  syscall: string
  func: string
  check: string
  labelBacking: string // backing behind cytoscape node labels; must contrast the canvas
  labelText: string // node-label text color; mirrors the --text token per theme
  edge: string
}

const DARK: KindColors = {
  java: '#5fd28f', native: '#6fa8ff', syscall: '#ff8b7a', func: '#d9a441', check: '#e5484d',
  // edge lifted from the near-invisible #3a4556 so lines + arrowheads read on the dark canvas
  labelBacking: '#1a1f2b', labelText: '#c9d1e0', edge: '#6b7a91',
}
const LIGHT: KindColors = {
  // check picks a distinct crimson, not syscall's own #c0392b - they'd read as
  // the same color in the same view otherwise.
  java: '#27ae60', native: '#2980b9', syscall: '#c0392b', func: '#b8860b', check: '#a8324a',
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

// Per-category RASP colors for native block nodes (root check / debugger / ...).
// Single source like KindColors; cytoscape consumes these (can't read CSS vars).
const CAT_DARK: Record<RaspCategory, string> = {
  root: '#e5484d', debugger: '#e08c3b', emulator: '#b072e0',
  integrity: '#4aa3ff', hook: '#26c2a6', custom: '#8b97a4',
}
const CAT_LIGHT: Record<RaspCategory, string> = {
  root: '#c0392b', debugger: '#b9770e', emulator: '#8e44ad',
  integrity: '#2980b9', hook: '#0e8f7e', custom: '#5c6773',
}

export function categoryColors(theme: Theme): Record<RaspCategory, string> {
  return theme === 'light' ? CAT_LIGHT : CAT_DARK
}

// Per-engine edge colors (EPIC B4). Only the three non-default engines need an
// entry - syscall/untagged edges keep KindColors.edge, unchanged from today.
const EDGE_DARK: Record<EdgeEngine, string> = { funcs: '#d9a441', correlate: '#8a7dd6', sentinel: '#e5484d' }
const EDGE_LIGHT: Record<EdgeEngine, string> = { funcs: '#b8860b', correlate: '#6c5ce7', sentinel: '#a8324a' }

export function edgeEngineColors(theme: Theme): Record<EdgeEngine, string> {
  return theme === 'light' ? EDGE_LIGHT : EDGE_DARK
}
