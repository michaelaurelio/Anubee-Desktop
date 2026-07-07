import { layoutFlame, type FlameNode, type FlameTree } from '@shared/flame-shape'
import { themeColors, type Theme } from './theme'

// Kind fills follow the active theme (single source: theme.ts). 'root' is the
// synthetic top frame with no graph equivalent in themeColors, so it keeps a
// fixed neutral grey across both themes.
export function kindFill(theme: Theme): Record<string, string> {
  const c = themeColors(theme)
  return { root: '#7f8c8d', java: c.java, native: c.native, syscall: c.syscall }
}
const SVG = 'http://www.w3.org/2000/svg'
const ROW_H = 22

// Render an icicle (root on top, growing down) into `host`. Clicking a frame
// with children re-roots (zoom); a reset button returns to the full tree.
export function renderFlame(host: HTMLElement, tree: FlameTree, truncated: boolean, theme: Theme = 'dark'): void {
  const fill = kindFill(theme)
  if (tree.root.value === 0) {
    host.innerHTML = ''
    host.textContent = 'No events match the current filter.'
    return
  }

  let current: FlameNode = tree.root

  const draw = (): void => {
    host.innerHTML = ''

    if (current !== tree.root) {
      const reset = document.createElement('button')
      reset.className = 'flame-reset'
      reset.textContent = '⤴ reset'
      reset.addEventListener('click', () => { current = tree.root; draw() })
      host.appendChild(reset)
    }
    if (truncated) {
      const b = document.createElement('div')
      b.className = 'flame-banner'
      b.textContent = 'Flame graph truncated - narrow the filter to see every path.'
      host.appendChild(b)
    }

    // clientWidth includes #flame's 4px horizontal padding on each side; subtract
    // it so the SVG fits the content box exactly (no spurious horizontal scrollbar).
    const width = Math.max(0, (host.clientWidth || 700) - 8)
    const rects = layoutFlame(current, width, ROW_H)
    const height = rects.reduce((m, r) => Math.max(m, r.y + r.h), ROW_H)

    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))

    for (const r of rects) {
      const rect = document.createElementNS(SVG, 'rect')
      rect.setAttribute('x', String(r.x))
      rect.setAttribute('y', String(r.y))
      rect.setAttribute('width', String(Math.max(0, r.w - 1)))
      rect.setAttribute('height', String(r.h - 1))
      rect.setAttribute('fill', fill[r.kind] ?? '#95a5a6')
      rect.style.cursor = r.node.children.length ? 'pointer' : 'default'

      const pct = ((r.value / current.value) * 100).toFixed(1)
      const title = document.createElementNS(SVG, 'title')
      title.textContent = `${r.label}\n${r.value} (${pct}%)` // native tooltip, offline-safe
      rect.appendChild(title)
      rect.addEventListener('click', () => {
        if (r.node.children.length) { current = r.node; draw() }
      })
      svg.appendChild(rect)

      if (r.w > 28) {
        const text = document.createElementNS(SVG, 'text')
        text.setAttribute('x', String(r.x + 3))
        text.setAttribute('y', String(r.y + r.h / 2 + 3))
        text.setAttribute('font-size', '10')
        text.setAttribute('fill', '#ffffff')
        text.setAttribute('pointer-events', 'none')
        // rough char budget so text never spills its rect
        const budget = Math.max(1, Math.floor((r.w - 6) / 6))
        text.textContent = r.label.length > budget ? r.label.slice(0, budget - 1) + '…' : r.label
        svg.appendChild(text)
      }
    }

    host.appendChild(svg)
  }

  draw()
}
