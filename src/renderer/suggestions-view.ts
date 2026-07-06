import type { Tag } from '@shared/project-store'
import type { Suggestion } from '@shared/rasp-heuristics'

// A confirmed suggestion becomes a heuristic-sourced tag (keeps its confidence
// + rationale so the export can cite why it was flagged).
export function suggestionToTag(s: Suggestion, now: string): Tag {
  return {
    target: s.target, category: s.category, source: 'heuristic',
    confidence: s.confidence, rationale: s.rationale, createdAt: now,
  }
}

// Render the suggestions panel. Each row shows the target, category,
// confidence, rationale, and a Confirm button that persists the tag via onConfirm.
export function renderSuggestions(
  host: HTMLElement,
  suggestions: Suggestion[],
  onConfirm: (tag: Tag) => void,
): void {
  host.innerHTML = ''
  const head = document.createElement('div')
  head.style.fontWeight = 'bold'
  head.textContent = `Suggestions (${suggestions.length})`
  host.appendChild(head)

  for (const s of suggestions) {
    const row = document.createElement('div')
    row.style.padding = '2px 0'
    row.textContent = `${s.category} ${(s.confidence * 100).toFixed(0)}% - ${s.target} - ${s.rationale} (${s.occurrences}x)`
    const btn = document.createElement('button')
    btn.textContent = 'Confirm'
    btn.style.marginLeft = '6px'
    btn.onclick = () => onConfirm(suggestionToTag(s, new Date().toISOString()))
    row.appendChild(btn)
    host.appendChild(row)
  }
}
