import type { Tag } from '@shared/project-store'
import type { Suggestion } from '@shared/rasp-heuristics'

// A confirmed suggestion becomes a heuristic-sourced tag (keeps its confidence
// + rationale so the export can cite why it was flagged). An offset narrows the
// tag to one call site; omitting it tags the whole symbol.
export function suggestionToTag(s: Suggestion, now: string, offset?: string): Tag {
  const t: Tag = {
    target: s.target, category: s.category, source: 'heuristic',
    confidence: s.confidence, rationale: s.rationale, createdAt: now,
  }
  if (offset !== undefined) t.offset = offset
  return t
}

// Render the suggestions list into the popup. Each row: category chip, target,
// confidence + rationale, and Confirm / Reject buttons. Confirm persists a tag,
// Reject records a dismissal; either removes the row and updates the count.
export function renderSuggestions(
  host: HTMLElement,
  suggestions: Suggestion[],
  onConfirm: (tag: Tag) => void,
  onReject: (s: Suggestion, offset?: string) => void,
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

    // Call sites for this behaviour. Confirming a child tags that block only;
    // confirming the row above tags the whole symbol.
    for (const o of s.offsets) {
      const child = document.createElement('div')
      child.className = 'sug-offset'
      const label = document.createElement('span')
      label.className = 'sug-offset-label'
      label.textContent = `${o.offset} · ${o.occurrences}x`
      const cbtns = document.createElement('div')
      cbtns.className = 'sug-btns'
      const cconfirm = document.createElement('button')
      cconfirm.className = 'btn sug-confirm'
      cconfirm.textContent = 'Confirm'
      cconfirm.onclick = () => {
        onConfirm(suggestionToTag(s, new Date().toISOString(), o.offset))
        child.remove()
      }
      const creject = document.createElement('button')
      creject.className = 'btn sug-reject'
      creject.textContent = 'Reject'
      creject.onclick = () => { onReject(s, o.offset); child.remove() }
      cbtns.append(cconfirm, creject)
      child.append(label, cbtns)
      row.appendChild(child)
    }

    host.appendChild(row)
  }
  setCount()
}
