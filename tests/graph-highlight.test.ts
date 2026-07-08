import { describe, it, expect } from 'vitest'
import cytoscape from 'cytoscape'
import { litNeighborhood, highlightNeighborhood, clearHighlight } from '../src/renderer/graph-highlight'

// java J1 -> native N1 -> syscall S1 ; and a second branch J2 -> N2 -> S1.
function graph() {
  return cytoscape({
    headless: true,
    elements: [
      { data: { id: 'J1', kind: 'java' } }, { data: { id: 'N1', kind: 'native' } },
      { data: { id: 'J2', kind: 'java' } }, { data: { id: 'N2', kind: 'native' } },
      { data: { id: 'S1', kind: 'syscall' } },
      { data: { id: 'e1', source: 'J1', target: 'N1' } },
      { data: { id: 'e2', source: 'N1', target: 'S1' } },
      { data: { id: 'e3', source: 'J2', target: 'N2' } },
      { data: { id: 'e4', source: 'N2', target: 'S1' } },
    ],
  })
}

describe('litNeighborhood', () => {
  it('native node lights fan-in and fan-out', () => {
    const cy = graph()
    const ids = litNeighborhood(cy.$('#N1')).nodes().map(n => n.id()).sort()
    expect(ids).toEqual(['J1', 'N1', 'S1'])
  })
  it('syscall node lights fan-in only (both branches)', () => {
    const cy = graph()
    const ids = litNeighborhood(cy.$('#S1')).nodes().map(n => n.id()).sort()
    expect(ids).toEqual(['J1', 'J2', 'N1', 'N2', 'S1'])
  })
  it('java node lights its subtree', () => {
    const cy = graph()
    const ids = litNeighborhood(cy.$('#J1')).nodes().map(n => n.id()).sort()
    expect(ids).toEqual(['J1', 'N1', 'S1'])
  })
})

describe('highlightNeighborhood / clearHighlight', () => {
  it('adds highlighted to the lit set and dimmed to the rest', () => {
    const cy = graph()
    highlightNeighborhood(cy, cy.$('#N1'))
    expect(cy.$('#N1').hasClass('highlighted')).toBe(true)
    expect(cy.$('#S1').hasClass('highlighted')).toBe(true)
    expect(cy.$('#J2').hasClass('dimmed')).toBe(true)   // off-path
    expect(cy.$('#J2').hasClass('highlighted')).toBe(false)
  })
  it('clearHighlight removes both classes', () => {
    const cy = graph()
    highlightNeighborhood(cy, cy.$('#N1'))
    clearHighlight(cy)
    expect(cy.$('#N1').hasClass('highlighted')).toBe(false)
    expect(cy.$('#J2').hasClass('dimmed')).toBe(false)
  })
})
