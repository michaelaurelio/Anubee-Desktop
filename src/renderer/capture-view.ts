// Feature 9 capture panel: renders a capability's input form and a live console.
// Pure DOM (jsdom-testable); the main.ts wiring (Task 8) owns IPC + preflight.
import type { Capability, CapValues } from '@shared/tracer-caps'

export function renderCapabilityForm(
  host: HTMLElement,
  cap: Capability,
  vals: CapValues,
  onChange: (vals: CapValues) => void,
): void {
  host.innerHTML = ''
  const current: CapValues = { ...vals }

  for (const inp of cap.inputs) {
    const row = document.createElement('label')
    row.className = 'cap-input'
    const caption = document.createElement('span')
    caption.textContent = inp.required ? `${inp.label} *` : inp.label
    const ctrl = document.createElement('input')
    ctrl.dataset.key = inp.key
    if (inp.kind === 'bool') {
      ctrl.type = 'checkbox'
      ctrl.checked = Boolean(current[inp.key])
      ctrl.addEventListener('change', () => { current[inp.key] = ctrl.checked; onChange({ ...current }) })
    } else {
      ctrl.type = 'text'
      ctrl.value = String(current[inp.key] ?? '')
      ctrl.placeholder = inp.label
      ctrl.addEventListener('input', () => { current[inp.key] = ctrl.value; onChange({ ...current }) })
    }
    const err = document.createElement('span')
    err.className = 'cap-input-err'
    err.dataset.err = inp.key
    row.append(caption, ctrl, err)
    host.appendChild(row)
  }
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

export function appendConsoleLine(host: HTMLElement, line: string): void {
  const div = document.createElement('div')
  div.className = 'console-line'
  div.textContent = line
  host.appendChild(div)
  host.scrollTop = host.scrollHeight
}
