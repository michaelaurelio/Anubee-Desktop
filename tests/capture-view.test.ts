// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderCapabilityForm, appendConsoleLine, applyFieldErrors, renderDot } from '../src/renderer/capture-view'
import { capById } from '../src/shared/tracer-caps'

describe('renderCapabilityForm', () => {
  it('renders one control per input and reports changes', () => {
    const host = document.createElement('div')
    let latest = {}
    renderCapabilityForm(host, capById('syscalls')!, {}, v => { latest = v })
    const pkg = host.querySelector<HTMLInputElement>('[data-key="pkg"]')!
    expect(pkg).toBeTruthy()
    expect(host.querySelector('[data-key="lib"]')).toBeTruthy()
    expect(host.querySelector<HTMLInputElement>('[data-key="all"]')!.type).toBe('checkbox')
    pkg.value = 'com.android.deskclock'
    pkg.dispatchEvent(new Event('input'))
    expect(latest).toMatchObject({ pkg: 'com.android.deskclock' })
  })

  it('does NOT render a loud banner for correlate', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('correlate')!, {}, () => {})
    expect(host.querySelector('.loud-warn')).toBeNull()
  })

  it('renders an error span per input', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, {}, () => {})
    expect(host.querySelector('[data-err="pkg"]')).not.toBeNull()
  })
})

describe('applyFieldErrors', () => {
  it('fills the matching error span and clears the rest', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, {}, () => {})
    applyFieldErrors(host, { pkg: 'is required' })
    expect((host.querySelector('[data-err="pkg"]') as HTMLElement).textContent).toBe('is required')
    expect((host.querySelector('[data-err="lib"]') as HTMLElement).textContent).toBe('')
  })
})

describe('renderDot', () => {
  it('marks ok and bad with the right class and title', () => {
    const dot = document.createElement('span')
    renderDot(dot, { ok: true, detail: 'ares' })
    expect(dot.className).toContain('preflight-ok')
    renderDot(dot, { ok: false, detail: 'not set' })
    expect(dot.className).toContain('preflight-bad')
    expect(dot.title).toBe('not set')
  })
})

describe('appendConsoleLine', () => {
  it('appends lines to the console host', () => {
    const host = document.createElement('div')
    appendConsoleLine(host, '[lib] bionic/libc.so')
    appendConsoleLine(host, 'attached')
    expect(host.children.length).toBe(2)
    expect(host.textContent).toContain('[lib] bionic/libc.so')
  })
})
