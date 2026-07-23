import { describe, it, expect } from 'vitest'
import { suggestionToTag } from '../src/renderer/suggestions-view'

describe('suggestions-view', () => {
  it('mints a heuristic tag carrying confidence and rationale', () => {
    const s = { target: 'sys:ptrace', category: 'debugger' as const, confidence: 0.9,
      rationale: 'TRACEME', occurrences: 3, offsets: [] }
    expect(suggestionToTag(s, 'T')).toEqual({
      target: 'sys:ptrace', category: 'debugger', source: 'heuristic',
      confidence: 0.9, rationale: 'TRACEME', createdAt: 'T',
    })
  })
})
