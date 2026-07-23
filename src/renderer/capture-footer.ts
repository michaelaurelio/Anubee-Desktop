// The Capture modal's action footer as a pure state machine: one accent
// (primary) action at a time. Preflight is mandatory, so Start never renders
// until every check has passed - there is no disabled Start to stare at.

export type PreflightState = 'none' | 'running' | 'failed' | 'passed' | 'stale'

export interface FooterState {
  configValid: boolean
  preflight: PreflightState
  running: boolean
  // True once the device-side process has exited and pull+ingest is in
  // flight (main's 'finishing' phase - see run-lifecycle.ts). Only meaningful
  // while running is true. There is no live process left to signal at this
  // point, so the footer drops to a non-interactive busy note instead of
  // offering Stop buttons that can no longer act.
  finishing?: boolean
  // True from the moment Stop is clicked until main reports the run has moved
  // on. Stopping a device process takes seconds (SIGINT, then anubee drains its
  // queue), and without this the footer sat unchanged the whole time, so the
  // click looked ignored - the complaint that prompted this state.
  stopping?: boolean
  failReason?: string
  counters?: string
}

export interface FooterButton { id: string; label: string; disabled: boolean; primary: boolean }
export interface FooterSpec {
  // 'busy' is 'note' plus a spinner: the work is ongoing rather than a result
  // to read, and a static line alone did not read as "something is happening".
  left: { kind: 'none' | 'note' | 'rerun' | 'counters' | 'busy'; text: string }
  buttons: FooterButton[]   // rendered left to right; the primary is last
}

const btn = (id: string, label: string, primary = false, disabled = false): FooterButton =>
  ({ id, label, primary, disabled })

export function captureFooter(st: FooterState): FooterSpec {
  if (st.running) {
    if (st.finishing) {
      return { left: { kind: 'busy', text: 'Pulling & ingesting…' }, buttons: [] }
    }
    // Acknowledge the click immediately. The device still has to take the
    // signal and drain, which is seconds; leaving the Stop buttons up through
    // that reads as "nothing happened" and invites a second click.
    if (st.stopping) {
      return { left: { kind: 'busy', text: 'Stopping the capture…' }, buttons: [] }
    }
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
  } else if (spec.left.kind === 'busy') {
    const wrap = document.createElement('span')
    wrap.className = 'cap-foot-busy'
    const spin = document.createElement('span')
    spin.className = 'cap-spinner'
    const s = document.createElement('span')
    s.textContent = spec.left.text
    wrap.append(spin, s)
    host.appendChild(wrap)
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

// Fast path for the running state's per-line counter: a capture can emit
// thousands of lines per second, and renderCaptureFooter's full teardown/
// rebuild (recreating every button and re-attaching every click listener) on
// each one pegs the renderer. Only the counters text actually changes per
// line, so update that node directly. A no-op outside the running state,
// where '.cap-foot-counters' is not in the DOM - callers do not need to
// guard on state before calling this.
export function setFooterCounters(host: HTMLElement, text: string): void {
  const el = host.querySelector<HTMLElement>('.cap-foot-counters')
  if (el) el.textContent = text
}
