// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { suggestionToTag, renderSuggestions, renderSuggestionsLoading } from '../src/renderer/suggestions-view'
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

describe('renderSuggestionsLoading', () => {
  const sug = (target: string) => ({
    target, category: 'root' as const, confidence: 0.9, rationale: 'r',
    occurrences: 3, offsets: [{ offset: '0x10', occurrences: 3 }],
  })

  it('paints shimmer placeholders shaped like real rows', () => {
    const host = document.createElement('div')
    renderSuggestionsLoading(host)
    expect(host.querySelectorAll('.sug-skel-row').length).toBeGreaterThan(0)
    // Reuses the shared .sk shimmer rather than defining its own.
    expect(host.querySelectorAll('.sk').length).toBeGreaterThan(0)
    // The head shimmers rather than repeating the modal's own "Suggestions"
    // title: the count is not known until the scan resolves.
    expect(host.querySelector('.sug-head .sk')).not.toBeNull()
    expect(host.querySelector('.sug-head')?.textContent).toBe('')
    expect(host.querySelector('.sug-note')?.textContent).toContain('Scoring')
  })

  it('shows no empty-state text, so a slow scan never reads as "found nothing"', () => {
    const host = document.createElement('div')
    renderSuggestionsLoading(host)
    expect(host.querySelector('.sug-empty')).toBeNull()
    expect(host.textContent).not.toContain('No suggestions')
  })

  // The real failure mode if the skeleton were appended rather than replacing:
  // placeholders would sit above the results forever.
  it('is fully replaced by the real list, leaving no placeholders behind', () => {
    const host = document.createElement('div')
    renderSuggestionsLoading(host)
    renderSuggestions(host, [sug('nat:libexample.so!chk')], () => {}, () => {})
    expect(host.querySelectorAll('.sug-skel-row').length).toBe(0)
    expect(host.querySelectorAll('.sk').length).toBe(0)
    expect(host.querySelectorAll('.sug-row').length).toBe(1)
  })

  it('is fully replaced by the empty state when the scan finds nothing', () => {
    const host = document.createElement('div')
    renderSuggestionsLoading(host)
    renderSuggestions(host, [], () => {}, () => {})
    expect(host.querySelectorAll('.sug-skel-row').length).toBe(0)
    expect(host.querySelector('.sug-empty')).not.toBeNull()
  })
})
