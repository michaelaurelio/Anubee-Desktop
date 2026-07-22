// Feature 9 capture panel: renders a capability's input form and a live console.
// Pure DOM (jsdom-testable); the main.ts wiring owns IPC + preflight.
import { libList, type Capability, type CapValues, type CapInput } from '@shared/tracer-caps'
import type { PreflightCheck } from './capture-preflight-view'

export interface FormOpts {
  specNames?: string[]
  specsDir?: string
}

// One short line per engine, so the choice is legible without leaving the modal.
// Wording follows ../Anubee/docs/engines.md.
const ENGINE_DESC: Record<string, { desc: string; badge: string }> = {
  syscalls: {
    desc: 'Every syscall a library makes, with decoded args and backtraces. Nothing is written into the target.',
    badge: 'injectionless',
  },
  funcs: {
    desc: 'Individual function calls with typed args and return values. Inserts a BRK into the target.',
    badge: 'detectable',
  },
}

// Two engines: a dropdown would hide half the choice, so render both.
export function renderEngineSegments(
  host: HTMLElement,
  caps: Capability[],
  currentId: string,
  onPick: (id: string) => void,
): void {
  host.innerHTML = ''
  const row = document.createElement('div')
  row.className = 'engine-row'
  const seg = document.createElement('div')
  // NOT `.seg`: index.html:461 already defines `.seg.cs-mode .btn` for the
  // call-site mode switcher, and a bare `.seg button` rule would restyle it.
  seg.className = 'cap-seg'
  for (const c of caps) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = c.id === currentId ? 'on' : ''
    b.dataset.engine = c.id
    b.textContent = c.engine
    b.addEventListener('click', () => { if (c.id !== currentId) onPick(c.id) })
    seg.appendChild(b)
  }
  const badge = document.createElement('span')
  badge.className = 'engine-badge'
  badge.textContent = ENGINE_DESC[currentId]?.badge ?? ''
  row.append(seg, badge)
  const desc = document.createElement('div')
  desc.className = 'engine-desc'
  desc.textContent = ENGINE_DESC[currentId]?.desc ?? ''
  host.append(row, desc)
}

export function renderCapabilityForm(
  host: HTMLElement,
  cap: Capability,
  vals: CapValues,
  onChange: (vals: CapValues) => void,
  opts: FormOpts = {},
): void {
  host.innerHTML = ''
  const current: CapValues = { ...vals }

  let advBody: HTMLElement | null = null
  for (const inp of cap.inputs) {
    if (inp.advanced) {
      if (!advBody) advBody = appendAdvanced(host)
      advBody.appendChild(buildRow(inp, current, onChange, opts))
    } else {
      host.appendChild(buildRow(inp, current, onChange, opts))
      // The OR'd/glob explanation sits under the chip row, not inside it, so
      // it stays put while chips come and go (see mockup).
      if (inp.kind === 'globlist') host.appendChild(globlistHint())
    }
  }
}

// The chip list's substring/glob explanation, shown once below the row.
function globlistHint(): HTMLElement {
  const hint = document.createElement('div')
  hint.className = 'hint'
  hint.textContent = "Substring or glob, OR'd. Empty = capture every library."
  return hint
}

// Create (once) the collapsed Advanced disclosure and return its body container.
function appendAdvanced(host: HTMLElement): HTMLElement {
  const details = document.createElement('details')
  details.className = 'cap-advanced'
  const summary = document.createElement('summary')
  summary.textContent = 'Advanced'
  const body = document.createElement('div')
  body.className = 'cap-advanced-body'
  details.append(summary, body)
  host.appendChild(details)
  return body
}

// Build one input row (caption + control + error span) for any input kind.
function buildRow(
  inp: CapInput,
  current: CapValues,
  onChange: (vals: CapValues) => void,
  opts: FormOpts,
): HTMLElement {
  const row = document.createElement('label')
  row.className = 'cap-input'
  const caption = document.createElement('span')
  caption.textContent = inp.required ? `${inp.label} *` : inp.label

  let ctrl: HTMLElement
  if (inp.kind === 'globlist') {
    ctrl = buildChipList(inp, current, onChange)
  } else if (inp.kind === 'spec') {
    const sel = document.createElement('select')
    sel.dataset.key = inp.key
    fillSpecOptions(sel, opts.specNames ?? [], String(current[inp.key] ?? ''))
    sel.addEventListener('change', () => { current[inp.key] = sel.value; onChange({ ...current }) })
    ctrl = sel
  } else if (inp.kind === 'bool') {
    const cb = document.createElement('input')
    cb.type = 'checkbox'; cb.dataset.key = inp.key
    cb.checked = Boolean(current[inp.key])
    cb.addEventListener('change', () => { current[inp.key] = cb.checked; onChange({ ...current }) })
    ctrl = cb
  } else if (inp.kind === 'int') {
    const num = document.createElement('input')
    num.type = 'number'; num.dataset.key = inp.key
    num.min = String(inp.min ?? 1)
    if (inp.default !== undefined) num.placeholder = String(inp.default)
    num.value = String(current[inp.key] ?? '')
    num.addEventListener('input', () => { current[inp.key] = num.value; onChange({ ...current }) })
    ctrl = num
  } else {
    const tx = document.createElement('input')
    tx.type = 'text'; tx.dataset.key = inp.key
    tx.value = String(current[inp.key] ?? ''); tx.placeholder = inp.label
    tx.addEventListener('input', () => { current[inp.key] = tx.value; onChange({ ...current }) })
    ctrl = tx
  }

  const err = document.createElement('span')
  err.className = 'cap-input-err'; err.dataset.err = inp.key
  row.append(caption, ctrl, err)
  return row
}

// A repeatable -l selector list. anubee accepts up to 64, OR'd, each a
// substring or a glob; an empty list is capture-all, which is why the empty
// state states that rather than looking like a missing value.
function buildChipList(
  inp: CapInput,
  current: CapValues,
  onChange: (vals: CapValues) => void,
): HTMLElement {
  const box = document.createElement('div')
  box.className = 'chip-list'
  box.dataset.key = inp.key

  const add = document.createElement('input')
  add.type = 'text'; add.className = 'chip-add'; add.placeholder = 'add filter…'

  const commit = (list: string[]): void => {
    current[inp.key] = list.join('\n')
    paint(list)
    onChange({ ...current })
  }

  const paint = (list: string[]): void => {
    for (const el of [...box.querySelectorAll('.chip, .chip-empty')]) el.remove()
    if (list.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'chip-empty'
      empty.textContent = 'no filter - every library captured'
      box.insertBefore(empty, add)
      return
    }
    for (const sel of list) {
      const chip = document.createElement('span')
      chip.className = 'chip'; chip.dataset.chip = sel
      const text = document.createElement('span')
      text.textContent = sel
      const del = document.createElement('button')
      del.type = 'button'; del.dataset.role = 'chipdel'
      del.textContent = '×'; del.title = `remove ${sel}`
      del.addEventListener('click', () => commit(libList(current[inp.key]).filter(x => x !== sel)))
      chip.append(text, del)
      box.insertBefore(chip, add)
    }
  }

  const addCurrent = (): void => {
    const v = add.value.trim()
    if (!v) return
    const list = libList(current[inp.key])
    // Duplicates are silently OR'd by anubee, so dropping them loses nothing.
    if (!list.includes(v)) commit([...list, v])
    add.value = ''
  }
  add.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addCurrent() }
  })
  add.addEventListener('blur', e => {
    // Browsers fire blur during mousedown on the new target, before its click.
    // Committing here would turn "delete that chip" into "delete that chip and
    // also add whatever I was half-way through typing".
    const to = (e as FocusEvent).relatedTarget
    if (to instanceof Node && box.contains(to)) return
    addCurrent()
  })

  box.appendChild(add)
  paint(libList(current[inp.key]))
  return box
}

// The host specs-dir config row shown for spec engines. Structure + markers only;
// main.ts binds the value, Browse, dot, and error.
export function specsDirRow(value: string): HTMLElement {
  const row = document.createElement('label')
  row.className = 'cap-input'
  const caption = document.createElement('span')
  caption.textContent = 'specs dir *'
  const input = document.createElement('input')
  input.type = 'text'; input.dataset.config = 'specsDir'
  input.value = value; input.placeholder = '/host/specs'
  const browse = document.createElement('button')
  browse.className = 'btn'; browse.dataset.role = 'specsBrowse'; browse.textContent = 'Browse…'
  const dot = document.createElement('span')
  dot.className = 'path-dot'; dot.dataset.role = 'specsDot'
  const err = document.createElement('span')
  err.className = 'cap-input-err'; err.dataset.err = 'specsDir'
  row.append(caption, input, browse, dot, err)
  return row
}

// (Re)fill a spec <select>'s options, disabling it when the list is empty.
function fillSpecOptions(sel: HTMLSelectElement, names: string[], current: string): void {
  sel.innerHTML = ''
  const ph = document.createElement('option')
  ph.value = ''
  ph.textContent = names.length ? '- select spec -' : '- no specs - set a specs dir -'
  sel.appendChild(ph)
  for (const n of names) {
    const o = document.createElement('option')
    o.value = n; o.textContent = n
    if (n === current) o.selected = true
    sel.appendChild(o)
  }
  sel.disabled = names.length === 0
}

// Repopulate the spec select in place (no form rebuild) after the specs dir
// changes, so editing the specs-dir field never rebuilds/refocuses the form.
export function applySpecChoices(host: HTMLElement, names: string[], current: string): void {
  const sel = host.querySelector<HTMLSelectElement>('select[data-key="spec"]')
  if (sel) fillSpecOptions(sel, names, current)
}

// Set each per-field error span from a key->message map; missing keys clear.
export function applyFieldErrors(host: HTMLElement, fields: Record<string, string>): void {
  for (const span of host.querySelectorAll<HTMLElement>('[data-err]')) {
    const key = span.dataset.err ?? ''
    span.textContent = fields[key] ?? ''
  }
}

// Paint a host-path validity dot from a checkPaths status.
export function renderDot(dot: HTMLElement, status: { ok: boolean; detail: string }): void {
  dot.className = status.ok ? 'path-dot preflight-ok' : 'path-dot preflight-bad'
  dot.textContent = '●' // ●
  dot.title = status.detail
}

// The preflight pane owns this shape now; re-exported so the Libraries live
// modal keeps its existing import path.
export type { PreflightCheck }

export function renderPreflightRow(host: HTMLElement, c: PreflightCheck): void {
  const row = document.createElement('div')
  row.className = c.ok ? 'preflight-ok' : 'preflight-bad'
  row.textContent = `${c.ok ? 'OK' : 'FAIL'}  ${c.label} - ${c.detail}`
  host.appendChild(row)
}

// A chatty unfiltered capture can emit thousands of lines; without a cap the
// console DOM grows unbounded for the life of the run. Drop the oldest lines
// past this limit - recent output is what an analyst watching a live capture
// actually needs.
const CONSOLE_LINE_CAP = 5000

export function appendConsoleLine(host: HTMLElement, line: string): void {
  const div = document.createElement('div')
  div.className = 'console-line'
  div.textContent = line
  host.appendChild(div)
  while (host.childElementCount > CONSOLE_LINE_CAP) host.firstElementChild!.remove()
  host.scrollTop = host.scrollHeight
}
