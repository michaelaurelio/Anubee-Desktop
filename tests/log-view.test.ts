// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderLogModal } from '../src/renderer/log-view'
import { logAppend, logClear } from '../src/renderer/log-store'

beforeEach(() => { document.body.innerHTML = ''; logClear() })

describe('renderLogModal', () => {
  it('renders one line per entry with a per-level class', () => {
    logAppend('error', 'export', 'boom')
    logAppend('success', 'load', 'ok')
    const host = document.createElement('div')
    renderLogModal(host)
    const lines = host.querySelectorAll('.log-line')
    expect(lines).toHaveLength(2)
    expect(lines[0].classList.contains('log-error')).toBe(true)
    expect(lines[1].classList.contains('log-success')).toBe(true)
    expect(lines[0].textContent).toContain('export')
    expect(lines[0].textContent).toContain('boom')
  })

  it('live-appends new entries while open', () => {
    const host = document.createElement('div')
    renderLogModal(host)
    logAppend('info', 'tracer', 'line one')
    expect(host.querySelectorAll('.log-line')).toHaveLength(1)
  })

  it('cleanup stops further live updates', () => {
    const host = document.createElement('div')
    const cleanup = renderLogModal(host)
    cleanup()
    logAppend('info', 'tracer', 'ignored')
    expect(host.querySelectorAll('.log-line')).toHaveLength(0)
  })
})
