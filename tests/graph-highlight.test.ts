import { describe, it, expect } from 'vitest'
import cytoscape from 'cytoscape'
import { applyHighlight, clearHighlight } from '../src/renderer/graph-highlight'

// J1 -> N1 -> S1 and J2 -> N2 -> S1.
function graph() {
  return cytoscape({
    headless: true,
    elements: [
      { data: { id: 'J1', kind: 'java' } }, { data: { id: 'N1', kind: 'native' } },
      { data: { id: 'J2', kind: 'java' } }, { data: { id: 'N2', kind: 'native' } },
      { data: { id: 'S1', kind: 'syscall' } },
      { data: { id: 'J1=>N1', source: 'J1', target: 'N1' } },
      { data: { id: 'N1=>S1', source: 'N1', target: 'S1' } },
      { data: { id: 'J2=>N2', source: 'J2', target: 'N2' } },
      { data: { id: 'N2=>S1', source: 'N2', target: 'S1' } },
    ],
  })
}

describe('applyHighlight', () => {
  it('highlights the given node and edge ids, dims the rest', () => {
    const cy = graph()
    applyHighlight(cy, { nodes: ['J1', 'N1', 'S1'], edges: ['J1=>N1', 'N1=>S1'] })
    expect(cy.$('#J1').hasClass('highlighted')).toBe(true)
    expect(cy.$('#N1=>S1').hasClass('highlighted')).toBe(true)
    expect(cy.$('#J2').hasClass('highlighted')).toBe(false)
    expect(cy.$('#J2').hasClass('dimmed')).toBe(true)
    expect(cy.$('#J2=>N2').hasClass('dimmed')).toBe(true)
  })

  it('lit elements are never also dimmed', () => {
    const cy = graph()
    applyHighlight(cy, { nodes: ['J1', 'N1', 'S1'], edges: ['J1=>N1', 'N1=>S1'] })
    expect(cy.$('#J1').hasClass('dimmed')).toBe(false)
    expect(cy.$('#N1=>S1').hasClass('dimmed')).toBe(false)
  })

  it('clearHighlight removes both classes', () => {
    const cy = graph()
    applyHighlight(cy, { nodes: ['J1'], edges: [] })
    clearHighlight(cy)
    expect(cy.$('#J1').hasClass('highlighted')).toBe(false)
    expect(cy.$('#J2').hasClass('dimmed')).toBe(false)
  })
})
