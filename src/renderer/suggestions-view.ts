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

// Render the suggestions list into the popup. Each row: category chip, target,
// confidence + rationale, and Confirm / Reject buttons. Confirm persists a tag,
// Reject records a dismissal; either removes the row and updates the count.
export function renderSuggestions(
  host: HTMLElement,
  suggestions: Suggestion[],
  onConfirm: (tag: Tag) => void,
  onReject: (s: Suggestion) => void,
): void {
  host.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'sug-head'
  const setCount = () => { head.textContent = `Suggestions (${host.querySelectorAll('.sug-row').length})` }
  host.appendChild(head)

  if (suggestions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'sug-empty'
    empty.textContent = 'No suggestions - the heuristics found nothing, or all were confirmed / rejected.'
    setCount()
    host.appendChild(empty)
    return
  }

  for (const s of suggestions) {
    const row = document.createElement('div')
    row.className = 'sug-row'

    const info = document.createElement('div')
    info.className = 'sug-info'
    const line1 = document.createElement('div')
    line1.className = 'sug-line1'
    const cat = document.createElement('span')
    cat.className = `cat-chip cat-${s.category}`
    cat.textContent = s.category.toUpperCase()
    const tgt = document.createElement('span')
    tgt.className = 'sug-target'
    tgt.textContent = s.target
    const conf = document.createElement('span')
    conf.className = 'sug-conf'
    conf.textContent = `${(s.confidence * 100).toFixed(0)}% · ${s.occurrences}x`
    line1.append(cat, tgt, conf)
    const line2 = document.createElement('div')
    line2.className = 'sug-rationale'
    line2.textContent = s.rationale
    info.append(line1, line2)

    const btns = document.createElement('div')
    btns.className = 'sug-btns'
    const confirm = document.createElement('button')
    confirm.className = 'btn sug-confirm'
    confirm.textContent = 'Confirm'
    confirm.onclick = () => { onConfirm(suggestionToTag(s, new Date().toISOString())); row.remove(); setCount() }
    const reject = document.createElement('button')
    reject.className = 'btn sug-reject'
    reject.textContent = 'Reject'
    reject.onclick = () => { onReject(s); row.remove(); setCount() }
    btns.append(confirm, reject)

    row.append(info, btns)
    host.appendChild(row)
  }
  setCount()
}
