// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { suggestionToTag, renderSuggestions } from '../src/renderer/suggestions-view'
import type { Tag } from '@shared/project-store'

describe('suggestions-view', () => {
  it('mints a heuristic tag carrying confidence and rationale', () => {
    const s = { target: 'sys:ptrace', category: 'debugger' as const, confidence: 0.9,
      rationale: 'TRACEME', occurrences: 3, offsets: [] }
    expect(suggestionToTag(s, 'T')).toEqual({
      target: 'sys:ptrace', category: 'debugger', source: 'heuristic',
      confidence: 0.9, rationale: 'TRACEME', createdAt: 'T',
    })
  })

  it('renders one child row per call site', () => {
    const host = document.createElement('div')
    renderSuggestions(host, [{
      target: 'nat:libsentinel.so!chk', category: 'hook', confidence: 0.9,
      rationale: 'maps scan', occurrences: 3,
      offsets: [{ offset: '0x88c', occurrences: 2 }, { offset: '0xabc', occurrences: 1 }],
    }], () => {}, () => {})
    expect(host.querySelectorAll('.sug-offset')).toHaveLength(2)
  })

  it('confirming a call site mints a tag carrying that offset', () => {
    const host = document.createElement('div')
    const tags: Tag[] = []
    renderSuggestions(host, [{
      target: 'nat:libsentinel.so!chk', category: 'hook', confidence: 0.9,
      rationale: 'maps scan', occurrences: 1, offsets: [{ offset: '0x88c', occurrences: 1 }],
    }], t => tags.push(t), () => {})
    ;(host.querySelector('.sug-offset .sug-confirm') as HTMLButtonElement).click()
    expect(tags[0].offset).toBe('0x88c')
    expect(tags[0].category).toBe('hook')
  })

  it('confirming the row mints a symbol-level tag with no offset', () => {
    const host = document.createElement('div')
    const tags: Tag[] = []
    renderSuggestions(host, [{
      target: 'nat:libsentinel.so!chk', category: 'hook', confidence: 0.9,
      rationale: 'maps scan', occurrences: 1, offsets: [{ offset: '0x88c', occurrences: 1 }],
    }], t => tags.push(t), () => {})
    ;(host.querySelector('.sug-row > .sug-btns .sug-confirm') as HTMLButtonElement).click()
    expect(tags[0].offset).toBeUndefined()
  })
})
