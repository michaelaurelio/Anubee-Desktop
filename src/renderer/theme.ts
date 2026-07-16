import type { RaspCategory } from '@shared/project-store'

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
  labelBacking: string // backing behind cytoscape node labels; must contrast the canvas
  labelText: string // node-label text color; mirrors the --text token per theme
  edge: string
}

const DARK: KindColors = {
  java: '#8fbe7a', native: '#7fa0c8', syscall: '#e8845c', func: '#e0a94a',
  // warm edge tuned to read on the night canvas without fighting the war-red accent
  labelBacking: '#211f26', labelText: '#e7e3d9', edge: '#6e6a63',
}
const LIGHT: KindColors = {
  java: '#4f8a3f', native: '#3c6e9e', syscall: '#c25a34', func: '#b07c1e',
  labelBacking: '#fbfaf6', labelText: '#201e1b', edge: '#c3bcaf',
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
  root: '#e5544b', debugger: '#e39a3d', emulator: '#b888c8',
  integrity: '#7fa0c8', hook: '#4fb6a0', custom: '#9a928a',
}
const CAT_LIGHT: Record<RaspCategory, string> = {
  root: '#c0392b', debugger: '#b9770e', emulator: '#8e5aa8',
  integrity: '#3c6e9e', hook: '#1e8f7e', custom: '#6b6358',
}

export function categoryColors(theme: Theme): Record<RaspCategory, string> {
  return theme === 'light' ? CAT_LIGHT : CAT_DARK
}
