import type { Filter } from '@shared/filter'
import { splitWords, matchToken, filterFromParts, OMNI_KEYS, type OmniToken } from '@shared/omni-parse'

// Chip state is the source of truth for structured filters; whatever is left
// in the input is free text. currentFilter() folds both - its signature is
// unchanged, so every consumer in main.ts stays untouched.
let chips: OmniToken[] = []
let acIndex = 0

function input(): HTMLInputElement | null {
  return document.getElementById('f-text') as HTMLInputElement | null
}

export function currentFilter(): Filter {
  return filterFromParts(chips, input()?.value ?? '')
}

function renderChips(refresh: () => void): void {
  const host = document.getElementById('omni-chips')
  if (!host) return
  host.innerHTML = ''
  chips.forEach((c, i) => {
    const el = document.createElement('span')
    el.className = 'chip'
    const key = document.createElement('b')
    key.textContent = c.key + ':'
    const x = document.createElement('button')
    x.className = 'chip-x'
    x.textContent = '×'
    x.title = 'remove filter'
    x.addEventListener('click', () => {
      chips.splice(i, 1)
      renderChips(refresh)
      refresh()
    })
    el.append(key, document.createTextNode(c.value), x)
    host.appendChild(el)
  })
}

function addChip(t: OmniToken, refresh: () => void): void {
  chips = chips.filter(c => c.key !== t.key) // one chip per key - replace
  chips.push(t)
  renderChips(refresh)
}

// The word the caret is inside of (empty when the caret follows whitespace).
function wordAtCaret(el: HTMLInputElement): string {
  const upto = el.value.slice(0, el.selectionStart ?? el.value.length)
  if (!upto || /\s$/.test(upto)) return ''
  const words = splitWords(upto)
  return words[words.length - 1] ?? ''
}

function acMatches(el: HTMLInputElement): typeof OMNI_KEYS[number][] {
  const w = wordAtCaret(el)
  if (!w || w.includes(':')) return []
  return OMNI_KEYS.filter(k => k.key.startsWith(w))
}

function hideAc(): void {
  document.getElementById('omni-ac')?.classList.add('hidden')
  acIndex = 0
}

function renderAc(el: HTMLInputElement): void {
  const host = document.getElementById('omni-ac')
  if (!host) return
  const items = acMatches(el)
  host.innerHTML = ''
  host.classList.toggle('hidden', items.length === 0)
  if (!items.length) {
    acIndex = 0
    return
  }
  acIndex = Math.min(acIndex, items.length - 1)
  items.forEach((k, i) => {
    const row = document.createElement('div')
    row.className = 'ac-row' + (i === acIndex ? ' on' : '')
    const key = document.createElement('b')
    key.textContent = k.key + ':'
    const hint = document.createElement('span')
    hint.textContent = k.hint
    row.append(key, hint)
    // mousedown, not click: fires before the input's blur hides the dropdown.
    row.addEventListener('mousedown', e => {
      e.preventDefault()
      acceptKey(el, k.key)
    })
    host.appendChild(row)
  })
}

function acceptKey(el: HTMLInputElement, key: string): void {
  const caret = el.selectionStart ?? el.value.length
  const upto = el.value.slice(0, caret)
  const w = wordAtCaret(el)
  el.value = upto.slice(0, upto.length - w.length) + key + ':' + el.value.slice(caret)
  const pos = upto.length - w.length + key.length + 1
  el.setSelectionRange(pos, pos)
  hideAc()
}

function acOpen(): boolean {
  return !(document.getElementById('omni-ac')?.classList.contains('hidden') ?? true)
}

// Bind the omni input: chips on space/Enter, apply on Enter and chip removal,
// backspace-pop, key autocomplete. Resets chip state (tests re-wire per case).
export function wireFilterControls(refresh: () => void): void {
  chips = []
  acIndex = 0
  const el = input()
  if (!el) return
  renderChips(refresh)
  el.addEventListener('input', () => renderAc(el))
  el.addEventListener('blur', () => hideAc())
  el.addEventListener('keydown', ev => {
    const k = (ev as KeyboardEvent).key
    if (acOpen()) {
      const n = acMatches(el).length
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        acIndex = (acIndex + (k === 'ArrowDown' ? 1 : n - 1)) % n
        renderAc(el)
        ev.preventDefault()
        return
      }
      if (k === 'Tab' || k === 'Enter') {
        const pick = acMatches(el)[acIndex]
        if (pick) {
          acceptKey(el, pick.key)
          ev.preventDefault()
          return
        }
      }
      if (k === 'Escape') {
        hideAc()
        ev.preventDefault()
        return
      }
    }
    if (k === ' ') {
      const caret = el.selectionStart ?? el.value.length
      const upto = el.value.slice(0, caret)
      const w = wordAtCaret(el)
      const t = w ? matchToken(w) : null
      if (t) {
        addChip(t, refresh)
        el.value = upto.slice(0, upto.length - w.length) + el.value.slice(caret)
        const pos = upto.length - w.length
        el.setSelectionRange(pos, pos)
        hideAc()
        ev.preventDefault()
      }
      return
    }
    if (k === 'Enter') {
      const rest: string[] = []
      for (const w of splitWords(el.value)) {
        const t = matchToken(w)
        if (t) addChip(t, refresh)
        else rest.push(w)
      }
      el.value = rest.join(' ')
      hideAc()
      refresh()
      return
    }
    if (k === 'Backspace' && el.value === '' && chips.length) {
      const c = chips.pop()!
      renderChips(refresh)
      el.value = c.key + ':' + (c.value.includes(' ') ? '"' + c.value + '"' : c.value)
      ev.preventDefault()
    }
  })
}
