// Feature 9 capture panel: renders a capability's input form and a live console.
// Pure DOM (jsdom-testable); the main.ts wiring owns IPC + preflight.
import type { Capability, CapValues, CapInput } from '@shared/tracer-caps'
import type { PreflightCheck } from './capture-preflight-view'

export interface FormOpts {
  specNames?: string[]
  specsDir?: string
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
      // A spec input renders the host specs-dir config row before its dropdown.
      if (inp.kind === 'spec') host.appendChild(specsDirRow(opts.specsDir ?? ''))
      host.appendChild(buildRow(inp, current, onChange, opts))
    }
  }
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
  if (inp.kind === 'spec') {
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

// The host specs-dir config row shown for spec engines. Structure + markers only;
// main.ts binds the value, Browse, dot, and error.
function specsDirRow(value: string): HTMLElement {
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

export function appendConsoleLine(host: HTMLElement, line: string): void {
  const div = document.createElement('div')
  div.className = 'console-line'
  div.textContent = line
  host.appendChild(div)
  host.scrollTop = host.scrollHeight
}
