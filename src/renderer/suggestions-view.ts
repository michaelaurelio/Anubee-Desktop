import { targetLabel, type Tag } from '@shared/project-store'
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

// Painted into the popup before the scan starts. Scoring a run is a paged DuckDB
// pass plus the sequence matcher over every candidate event, so on a large
// capture it takes long enough that an unpainted panel reads as "found nothing"
// rather than "still working". Mirrors the table's skeleton idiom - placeholder
// rows shaped like the real ones, so the list does not jump when they land -
// rather than a spinner, which would say nothing about what is coming.
export function renderSuggestionsLoading(host: HTMLElement): void {
  host.innerHTML = ''
  // The head is loading content too - its text is "Suggestions (N)" and N is not
  // known yet - so it shimmers rather than repeating the modal's own title back
  // at the reader. Keeping it reserves the same vertical space the real head
  // takes, so the list does not shift when the rows land.
  const head = document.createElement('div')
  head.className = 'sug-head'
  const headBar = document.createElement('span')
  headBar.className = 'sk'
  headBar.style.width = '108px'
  headBar.style.height = '12px'
  head.appendChild(headBar)
  host.appendChild(head)

  // Widths vary per row so the placeholder reads as a list of differing findings
  // rather than a repeating pattern.
  const widths: [string, string, string][] = [
    ['54px', '38%', '46px'],
    ['62px', '52%', '46px'],
    ['48px', '30%', '46px'],
    ['58px', '44%', '46px'],
  ]
  for (const [chip, target, conf] of widths) {
    const row = document.createElement('div')
    row.className = 'sk-row sug-skel-row'

    const info = document.createElement('div')
    info.className = 'sug-skel-info'
    const line1 = document.createElement('div')
    line1.className = 'sug-skel-line'
    for (const w of [chip, target, conf]) {
      const b = document.createElement('span')
      b.className = 'sk'
      b.style.width = w
      line1.appendChild(b)
    }
    const line2 = document.createElement('span')
    line2.className = 'sk'
    line2.style.width = '68%'
    info.append(line1, line2)

    const btns = document.createElement('div')
    btns.className = 'sug-skel-btns'
    for (let i = 0; i < 2; i++) {
      const b = document.createElement('span')
      b.className = 'sk sug-skel-btn'
      btns.appendChild(b)
    }

    row.append(info, btns)
    host.appendChild(row)
  }

  const note = document.createElement('div')
  note.className = 'sug-note'
  note.textContent = 'Scoring this run against the rule library…'
  host.appendChild(note)
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
    tgt.textContent = targetLabel(s.target)
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
