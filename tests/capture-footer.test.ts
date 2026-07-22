// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { captureFooter, renderCaptureFooter, type FooterState } from '../src/renderer/capture-footer'

const st = (o: Partial<FooterState>): FooterState =>
  ({ configValid: true, preflight: 'none', running: false, ...o })

const primary = (s: FooterState) => captureFooter(s).buttons.find(b => b.primary)!
const ids = (s: FooterState) => captureFooter(s).buttons.map(b => b.id)

describe('captureFooter state machine', () => {
  it('config incomplete: primary is a disabled Preflight', () => {
    const p = primary(st({ configValid: false }))
    expect(p.id).toBe('cap-preflight')
    expect(p.disabled).toBe(true)
  })

  it('config valid: primary is Preflight, enabled', () => {
    const p = primary(st({}))
    expect(p.id).toBe('cap-preflight')
    expect(p.disabled).toBe(false)
  })

  it('preflight running: primary is a disabled Checking', () => {
    const p = primary(st({ preflight: 'running' }))
    expect(p.label).toBe('Checking…')
    expect(p.disabled).toBe(true)
  })

  it('preflight failed: primary re-runs, the reason shows bottom-left, Start is absent', () => {
    const s = st({ preflight: 'failed', failReason: 'root check failed' })
    expect(primary(s).id).toBe('cap-rerun')
    expect(captureFooter(s).left).toEqual({ kind: 'note', text: 'root check failed' })
    expect(ids(s)).not.toContain('cap-start')
  })

  it('preflight passed: primary is Start, re-run demotes to a ghost bottom-left', () => {
    const s = st({ preflight: 'passed' })
    expect(primary(s).id).toBe('cap-start')
    expect(primary(s).disabled).toBe(false)
    expect(captureFooter(s).left.kind).toBe('rerun')
  })

  // Preflight validates the package AND pushes the binary/specs, so a config
  // edit genuinely invalidates it - Start must not survive.
  it('stale after a config edit: primary reverts to Preflight, no Start, no ghost re-run', () => {
    const s = st({ preflight: 'stale' })
    expect(primary(s).id).toBe('cap-preflight')
    expect(ids(s)).not.toContain('cap-start')
    expect(captureFooter(s).left.kind).toBe('none')
  })

  it('running: counters left, stop pair right, no Cancel', () => {
    const s = st({ running: true, counters: '3,517 events' })
    expect(captureFooter(s).left).toEqual({ kind: 'counters', text: '3,517 events' })
    expect(ids(s)).toEqual(['cap-stop-discard', 'cap-stop-open'])
    expect(primary(s).id).toBe('cap-stop-open')
  })

  it('exactly one primary in every state', () => {
    const states: FooterState[] = [
      st({ configValid: false }), st({}), st({ preflight: 'running' }),
      st({ preflight: 'failed' }), st({ preflight: 'passed' }),
      st({ preflight: 'stale' }), st({ running: true }),
    ]
    for (const s of states) {
      expect(captureFooter(s).buttons.filter(b => b.primary)).toHaveLength(1)
    }
  })

  it('Cancel is present in every non-running state', () => {
    for (const p of ['none', 'running', 'failed', 'passed', 'stale'] as const) {
      expect(ids(st({ preflight: p }))).toContain('cap-cancel')
    }
  })
})

describe('renderCaptureFooter', () => {
  it('paints buttons in order and reports clicks by id', () => {
    const host = document.createElement('div')
    const seen: string[] = []
    renderCaptureFooter(host, captureFooter(st({ preflight: 'passed' })), id => seen.push(id))
    const btns = [...host.querySelectorAll('button')]
    expect(btns.map(b => b.id)).toEqual(['cap-rerun', 'cap-cancel', 'cap-start'])
    expect(host.querySelector('#cap-start')!.classList.contains('pri')).toBe(true)
    btns.find(b => b.id === 'cap-start')!.click()
    expect(seen).toEqual(['cap-start'])
  })

  it('replaces prior content and does not fire for a disabled primary', () => {
    const host = document.createElement('div')
    const seen: string[] = []
    renderCaptureFooter(host, captureFooter(st({ preflight: 'passed' })), id => seen.push(id))
    renderCaptureFooter(host, captureFooter(st({ configValid: false })), id => seen.push(id))
    expect(host.querySelector('#cap-start')).toBeNull()
    host.querySelector<HTMLButtonElement>('#cap-preflight')!.click()
    expect(seen).toEqual([])
  })

  it('enforces the manual disabled guard against synthetic click events', () => {
    const host = document.createElement('div')
    const seen: string[] = []
    // config-incomplete state: primary button is disabled cap-preflight
    renderCaptureFooter(host, captureFooter(st({ configValid: false })), id => seen.push(id))
    const btn = host.querySelector<HTMLButtonElement>('#cap-preflight')!
    // Synthetic events bypass native disabled gating, so the manual guard must
    // catch them. This cannot use .click() which respects native disabled semantics.
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(seen).toEqual([])
  })
})
