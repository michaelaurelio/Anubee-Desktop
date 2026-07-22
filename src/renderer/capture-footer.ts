// The Capture modal's action footer as a pure state machine: one accent
// (primary) action at a time. Preflight is mandatory, so Start never renders
// until every check has passed - there is no disabled Start to stare at.

export type PreflightState = 'none' | 'running' | 'failed' | 'passed' | 'stale'

export interface FooterState {
  configValid: boolean
  preflight: PreflightState
  running: boolean
  failReason?: string
  counters?: string
}

export interface FooterButton { id: string; label: string; disabled: boolean; primary: boolean }
export interface FooterSpec {
  left: { kind: 'none' | 'note' | 'rerun' | 'counters'; text: string }
  buttons: FooterButton[]   // rendered left to right; the primary is last
}

const btn = (id: string, label: string, primary = false, disabled = false): FooterButton =>
  ({ id, label, primary, disabled })

export function captureFooter(st: FooterState): FooterSpec {
  if (st.running) {
    return {
      left: { kind: 'counters', text: st.counters ?? '' },
      buttons: [btn('cap-stop-discard', 'Stop & discard'), btn('cap-stop-open', 'Stop & open run', true)],
    }
  }
  const cancel = btn('cap-cancel', 'Cancel')
  switch (st.preflight) {
    case 'running':
      return { left: { kind: 'none', text: '' }, buttons: [cancel, btn('cap-preflight', 'Checking…', true, true)] }
    case 'failed':
      return {
        left: { kind: 'note', text: st.failReason ?? 'preflight failed' },
        buttons: [cancel, btn('cap-rerun', 'Re-run preflight', true)],
      }
    case 'passed':
      return {
        left: { kind: 'rerun', text: 'Re-run preflight' },
        buttons: [cancel, btn('cap-start', 'Start capture', true)],
      }
    // 'stale' is a config edit after a pass: preflight both validated the
    // package and pushed the binary/specs, so the edit invalidates it.
    case 'stale':
    case 'none':
    default:
      return {
        left: { kind: 'none', text: '' },
        buttons: [cancel, btn('cap-preflight', 'Preflight', true, !st.configValid)],
      }
  }
}

export function renderCaptureFooter(
  host: HTMLElement,
  spec: FooterSpec,
  onClick: (id: string) => void,
): void {
  host.innerHTML = ''
  if (spec.left.kind === 'rerun') {
    const b = document.createElement('button')
    b.id = 'cap-rerun'; b.className = 'btn ghost'
    b.textContent = `↻ ${spec.left.text}`
    b.addEventListener('click', () => onClick('cap-rerun'))
    host.appendChild(b)
  } else if (spec.left.kind !== 'none') {
    const s = document.createElement('span')
    s.className = spec.left.kind === 'note' ? 'cap-foot-note' : 'cap-foot-counters'
    s.textContent = spec.left.text
    host.appendChild(s)
  }
  const spacer = document.createElement('span')
  spacer.className = 'cap-foot-spacer'
  host.appendChild(spacer)
  for (const b of spec.buttons) {
    const el = document.createElement('button')
    el.id = b.id
    el.className = b.primary ? 'btn pri' : 'btn'
    el.textContent = b.label
    el.disabled = b.disabled
    el.addEventListener('click', () => { if (!el.disabled) onClick(b.id) })
    host.appendChild(el)
  }
}
