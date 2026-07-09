import type { DiffRow, MergedSlice, Presence } from '@shared/diff'
import { truncateLabel } from './graph-view'

// Red = removed (in A, gone in B); green = added (new in B); grey = shared.
export function presenceColor(p: Presence): string {
  if (p === 'A-only') return '#c0392b'
  if (p === 'B-only') return '#27ae60'
  return '#95a5a6'
}

export type DiffMode = 'all' | 'only-in-A' | 'only-in-B' | 'tagged'

export function filterDiffRows(rows: DiffRow[], mode: DiffMode, tagged: Set<string>): DiffRow[] {
  if (mode === 'all') return rows
  if (mode === 'only-in-A') return rows.filter(r => r.presence === 'A-only')
  if (mode === 'only-in-B') return rows.filter(r => r.presence === 'B-only')
  return rows.filter(r => tagged.has(r.id))
}

export function mergedToElements(slice: MergedSlice): {
  nodes: { data: { id: string; label: string; kind: string; count: number; presence: string } }[]
  edges: { data: { id: string; source: string; target: string; count: number; presence: string } }[]
} {
  return {
    nodes: slice.nodes.map(n => ({
      data: { id: n.id, label: truncateLabel(n.label), kind: n.kind, count: n.count, presence: n.presence },
    })),
    edges: slice.edges.map(e => ({
      data: { id: `${e.source}=>${e.target}`, source: e.source, target: e.target, count: e.count, presence: e.presence },
    })),
  }
}

// Render the diff table into a host element. Each row: label, A, B, Δ, tags,
// coloured by presence. Clicking a row calls onSelect with the node id.
export function renderDiffTable(
  host: HTMLElement,
  rows: DiffRow[],
  tagBadge: (id: string) => string,
  onSelect: (id: string) => void,
): void {
  host.innerHTML = ''
  const tbl = document.createElement('table')
  const head = tbl.insertRow()
  for (const h of ['node', 'A', 'B', 'Δ', 'tags']) {
    const th = document.createElement('th')
    th.textContent = h
    head.appendChild(th)
  }
  for (const r of rows) {
    const tr = tbl.insertRow()
    const cells = [r.label, String(r.countA), String(r.countB), String(r.delta), tagBadge(r.id)]
    for (const c of cells) {
      const td = tr.insertCell()
      td.textContent = c
      if (c) td.title = c
    }
    tr.style.color = presenceColor(r.presence)
    tr.style.cursor = 'pointer'
    tr.onclick = () => onSelect(r.id)
  }
  host.appendChild(tbl)
}
