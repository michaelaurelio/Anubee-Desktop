// The Capture modal's preflight pane. main's preflight() already streams
// structured checks; render that structure (dot / label / dimmed detail)
// instead of flattening each one to a string. Pure DOM (jsdom-testable).

// Mirrors main's tracer-control.PreflightCheck; the renderer cannot import a
// main-process type, so it is restated here. Shared by Capture and the
// Libraries live modal.
export interface PreflightCheck {
  id: string
  label: string
  ok: boolean
  detail: string
}

export function resetPreflightPane(host: HTMLElement): void {
  host.innerHTML = ''
  host.classList.remove('pf-stale')
  const empty = document.createElement('div')
  empty.className = 'pf-empty'
  empty.textContent = 'Not run yet. Preflight checks the device, root, and the pushed binary.'
  host.appendChild(empty)
}

export function appendPreflightCheck(host: HTMLElement, c: PreflightCheck): void {
  host.querySelector('.pf-empty')?.remove()
  const row = document.createElement('div')
  row.className = 'pf-row'
  row.dataset.check = c.id
  const dot = document.createElement('span')
  dot.className = `pf-dot ${c.ok ? 'preflight-ok' : 'preflight-bad'}`
  dot.textContent = '●'
  const label = document.createElement('span')
  label.className = 'pf-label'; label.textContent = c.label
  const detail = document.createElement('span')
  detail.className = 'pf-detail'; detail.textContent = c.detail
  detail.title = c.detail   // long details are ellipsised by CSS
  row.append(dot, label, detail)
  host.appendChild(row)
}

// A config edit invalidates a passed preflight (it validated the package and
// pushed the binary/specs). Keep the rows visible but neutral so the analyst
// can see what WAS true, badged as no longer current.
export function markPreflightStale(host: HTMLElement, reason: string): void {
  if (host.querySelector('.pf-empty')) return
  host.classList.add('pf-stale')
  if (!host.querySelector('.pf-stale-badge')) {
    const badge = document.createElement('span')
    badge.className = 'pf-stale-badge'; badge.textContent = 'stale'
    host.prepend(badge)
  }
  let why = host.querySelector<HTMLElement>('.pf-stale-reason')
  if (!why) {
    why = document.createElement('div')
    why.className = 'pf-stale-reason'
    host.appendChild(why)
  }
  why.textContent = reason
}

export function preflightSummary(checks: PreflightCheck[]): { passed: number; total: number; firstFail?: string } {
  const failed = checks.find(c => !c.ok)
  return {
    passed: checks.filter(c => c.ok).length,
    total: checks.length,
    firstFail: failed ? `${failed.label} - ${failed.detail}` : undefined,
  }
}
