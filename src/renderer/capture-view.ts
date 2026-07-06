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

  if (cap.loud) {
    const warn = document.createElement('div')
    warn.className = 'loud-warn'
    warn.textContent = 'Loud engine - writes BRK into the target (detectable).'
    host.appendChild(warn)
  }

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
    row.append(caption, ctrl)
    host.appendChild(row)
  }
}

export function appendConsoleLine(host: HTMLElement, line: string): void {
  const div = document.createElement('div')
  div.className = 'console-line'
  div.textContent = line
  host.appendChild(div)
  host.scrollTop = host.scrollHeight
}
