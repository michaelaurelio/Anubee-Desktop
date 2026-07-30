import { describe, it, expect } from 'vitest'
import { raspNodeStates } from '../src/renderer/rasp-node-state'
import type { Suggestion } from '@shared/rasp-heuristics'
import type { Tag, RaspCategory } from '@shared/project-store'

const sug = (target: string, category: Suggestion['category']): Suggestion =>
  ({ target, category, confidence: 0.8, rationale: 'x', occurrences: 1, offsets: [] })
const tag = (target: string, category: Tag['category']): Tag =>
  ({ target, category, source: 'manual', createdAt: '2026-07-08T00:00:00Z' })

describe('raspNodeStates', () => {
  it('maps a suggestion to suggested state', () => {
    const m = raspNodeStates([sug('nat:libexample.so!check_su', 'root')], [])
    expect(m.get('nat:libexample.so!check_su')).toEqual({ category: 'root', state: 'suggested' })
  })
  it('a confirmed tag overrides a suggestion on the same node', () => {
    const m = raspNodeStates(
      [sug('nat:libexample.so!check_su', 'root')],
      [tag('nat:libexample.so!check_su', 'debugger')],
    )
    expect(m.get('nat:libexample.so!check_su')).toEqual({ category: 'debugger', state: 'confirmed' })
  })
  it('last confirmed tag wins on one node', () => {
    const m = raspNodeStates([], [
      tag('nat:x', 'root'), tag('nat:x', 'hook'),
    ])
    expect(m.get('nat:x')).toEqual({ category: 'hook', state: 'confirmed' })
  })
  it('picks the highest-confidence suggestion when a node has several', () => {
    const s = (category: RaspCategory, confidence: number) =>
      ({ target: 'n', category, confidence, rationale: 'r', occurrences: 1, offsets: [] })
    const m = raspNodeStates([s('hook', 0.4), s('root', 0.85)], [])
    expect(m.get('n')).toEqual({ category: 'root', state: 'suggested' })
  })
  it('never seeds the graph-colouring map with a synthetic target', () => {
    const m = raspNodeStates([
      { target: 'rasp:unattributed:root', category: 'root', confidence: 0.9, rationale: 'r', occurrences: 3, offsets: [] },
      { target: 'nat:libsentinel.so!chk', category: 'hook', confidence: 0.8, rationale: 'r', occurrences: 1, offsets: [] },
    ], [])
    expect(m.has('rasp:unattributed:root')).toBe(false)
    expect(m.get('nat:libsentinel.so!chk')).toEqual({ category: 'hook', state: 'suggested' })
  })
})
