// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  resetPreflightPane, appendPreflightCheck, markPreflightStale, preflightSummary,
  type PreflightCheck,
} from '../src/renderer/capture-preflight-view'

const ok = (id: string, label: string, detail = ''): PreflightCheck => ({ id, label, ok: true, detail })
const bad = (id: string, label: string, detail: string): PreflightCheck => ({ id, label, ok: false, detail })

describe('capture preflight pane', () => {
  it('starts in an empty state that explains itself', () => {
    const host = document.createElement('div')
    resetPreflightPane(host)
    expect(host.querySelector('.pf-empty')!.textContent).toContain('Not run yet')
    expect(host.querySelectorAll('.pf-row')).toHaveLength(0)
  })

  it('renders label and detail as separate elements, not one flattened string', () => {
    const host = document.createElement('div')
    resetPreflightPane(host)
    appendPreflightCheck(host, ok('device', 'device reachable', 'emulator-5554'))
    expect(host.querySelector('.pf-empty')).toBeNull()
    const row = host.querySelector('.pf-row')!
    expect(row.querySelector('.pf-label')!.textContent).toBe('device reachable')
    expect(row.querySelector('.pf-detail')!.textContent).toBe('emulator-5554')
    expect(row.querySelector('.pf-dot')!.classList.contains('preflight-ok')).toBe(true)
  })

  it('marks a failing check red and keeps its detail', () => {
    const host = document.createElement('div')
    resetPreflightPane(host)
    appendPreflightCheck(host, bad('root', 'root available (su)', 'uid 2000'))
    const row = host.querySelector('.pf-row')!
    expect(row.querySelector('.pf-dot')!.classList.contains('preflight-bad')).toBe(true)
    expect(row.querySelector('.pf-detail')!.textContent).toBe('uid 2000')
  })

  it('appends rows in stream order', () => {
    const host = document.createElement('div')
    resetPreflightPane(host)
    appendPreflightCheck(host, ok('device', 'device reachable'))
    appendPreflightCheck(host, ok('root', 'root available (su)'))
    expect([...host.querySelectorAll('.pf-label')].map(e => e.textContent))
      .toEqual(['device reachable', 'root available (su)'])
  })

  it('dims every row and shows a badge with the reason when marked stale', () => {
    const host = document.createElement('div')
    resetPreflightPane(host)
    appendPreflightCheck(host, ok('device', 'device reachable'))
    markPreflightStale(host, 'engine changed since the last preflight')
    expect(host.classList.contains('pf-stale')).toBe(true)
    expect(host.querySelector('.pf-stale-badge')!.textContent).toBe('stale')
    expect(host.querySelector('.pf-stale-reason')!.textContent)
      .toBe('engine changed since the last preflight')
  })

  it('clears the stale mark on reset', () => {
    const host = document.createElement('div')
    resetPreflightPane(host)
    appendPreflightCheck(host, ok('device', 'device reachable'))
    markPreflightStale(host, 'engine changed')
    resetPreflightPane(host)
    expect(host.classList.contains('pf-stale')).toBe(false)
    expect(host.querySelector('.pf-stale-badge')).toBeNull()
  })

  it('summarises pass count and the first failure', () => {
    expect(preflightSummary([ok('a', 'A'), ok('b', 'B')]))
      .toEqual({ passed: 2, total: 2, firstFail: undefined })
    expect(preflightSummary([ok('a', 'A'), bad('b', 'root available (su)', 'uid 2000')]))
      .toEqual({ passed: 1, total: 2, firstFail: 'root available (su) - uid 2000' })
    expect(preflightSummary([])).toEqual({ passed: 0, total: 0, firstFail: undefined })
  })
})
