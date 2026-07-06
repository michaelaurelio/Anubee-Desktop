// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderCapabilityForm, appendConsoleLine } from '../src/renderer/capture-view'
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

  it('shows a loud warning for correlate', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('correlate')!, {}, () => {})
    expect(host.textContent).toMatch(/writes BRK/)
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
