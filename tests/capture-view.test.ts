// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderCapabilityForm, appendConsoleLine, applyFieldErrors, renderDot, applySpecChoices } from '../src/renderer/capture-view'
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

  it('renders tuning inputs inside a collapsible Advanced section', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, {}, () => {})
    const adv = host.querySelector<HTMLDetailsElement>('details.cap-advanced')
    expect(adv).not.toBeNull()
    expect(adv!.open).toBe(false)
    expect(adv!.querySelector('summary')!.textContent).toBe('Advanced')
    // primary field stays outside the disclosure
    expect(host.querySelector('[data-key="pkg"]')!.closest('details.cap-advanced')).toBeNull()
    // tuning fields live inside it
    const buf = host.querySelector<HTMLInputElement>('[data-key="bufmb"]')!
    expect(buf.type).toBe('number')
    expect(buf.min).toBe('1')
    expect(buf.placeholder).toBe('4')
    expect(buf.closest('details.cap-advanced')).not.toBeNull()
  })

  it('emits no Advanced section for a cap without advanced inputs', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('lib')!, {}, () => {})
    expect(host.querySelector('details.cap-advanced')).toBeNull()
  })

  it('reports number-input changes through onChange', () => {
    const host = document.createElement('div')
    let latest: Record<string, unknown> = {}
    renderCapabilityForm(host, capById('syscalls')!, {}, v => { latest = v })
    const buf = host.querySelector<HTMLInputElement>('[data-key="bufmb"]')!
    buf.value = '8'
    buf.dispatchEvent(new Event('input'))
    expect(latest).toMatchObject({ bufmb: '8' })
  })

  it('renders the --snapshot checkbox inside Advanced for syscalls/funcs', () => {
    for (const id of ['syscalls', 'funcs']) {
      const host = document.createElement('div')
      renderCapabilityForm(host, capById(id)!, {}, () => {})
      const cb = host.querySelector<HTMLInputElement>('[data-key="snapshot"]')
      expect(cb).not.toBeNull()
      expect(cb!.type).toBe('checkbox')
      expect(cb!.closest('details.cap-advanced')).not.toBeNull()
    }
  })

  it('renders no --snapshot checkbox for correlate', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('correlate')!, {}, () => {})
    expect(host.querySelector('[data-key="snapshot"]')).toBeNull()
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

describe('renderCapabilityForm spec engine', () => {
  it('renders the spec input as a select seeded from vals, plus a specs-dir row', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('funcs')!, { spec: 'b.spec' }, () => {},
      { specNames: ['a.spec', 'b.spec'], specsDir: '/host/specs' })
    const sel = host.querySelector<HTMLSelectElement>('select[data-key="spec"]')!
    expect(sel).not.toBeNull()
    expect(sel.disabled).toBe(false)
    expect(Array.from(sel.options).map(o => o.value)).toEqual(['', 'a.spec', 'b.spec'])
    expect(sel.value).toBe('b.spec')
    const dir = host.querySelector<HTMLInputElement>('[data-config="specsDir"]')!
    expect(dir.value).toBe('/host/specs')
    expect(host.querySelector('[data-role="specsBrowse"]')).not.toBeNull()
    expect(host.querySelector('[data-role="specsDot"]')).not.toBeNull()
    expect(host.querySelector('[data-err="specsDir"]')).not.toBeNull()
  })

  it('disables the spec select with a placeholder when no specs are available', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('funcs')!, {}, () => {}, { specNames: [], specsDir: '' })
    const sel = host.querySelector<HTMLSelectElement>('select[data-key="spec"]')!
    expect(sel.disabled).toBe(true)
    expect(sel.options[0].textContent).toMatch(/no specs/i)
  })

  it('reports a spec selection through onChange', () => {
    const host = document.createElement('div')
    let got: Record<string, unknown> = {}
    renderCapabilityForm(host, capById('funcs')!, {}, v => { got = v }, { specNames: ['a.spec'], specsDir: '/host/specs' })
    const sel = host.querySelector<HTMLSelectElement>('select[data-key="spec"]')!
    sel.value = 'a.spec'
    sel.dispatchEvent(new Event('change'))
    expect(got.spec).toBe('a.spec')
  })
})

describe('renderCapabilityForm non-spec engine', () => {
  it('renders no specs-dir row and no select', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, {}, () => {})
    expect(host.querySelector('select[data-key="spec"]')).toBeNull()
    expect(host.querySelector('[data-config="specsDir"]')).toBeNull()
    expect(host.querySelector('[data-err="pkg"]')).not.toBeNull()
  })
})

describe('applySpecChoices', () => {
  it('repopulates the select options in place and keeps a valid selection', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('funcs')!, { spec: 'a.spec' }, () => {}, { specNames: ['a.spec'], specsDir: '/host/specs' })
    applySpecChoices(host, ['a.spec', 'c.spec'], 'a.spec')
    const sel = host.querySelector<HTMLSelectElement>('select[data-key="spec"]')!
    expect(Array.from(sel.options).map(o => o.value)).toEqual(['', 'a.spec', 'c.spec'])
    expect(sel.value).toBe('a.spec')
    expect(sel.disabled).toBe(false)
  })
  it('disables the select when the new list is empty', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('funcs')!, {}, () => {}, { specNames: ['a.spec'], specsDir: '/host/specs' })
    applySpecChoices(host, [], '')
    const sel = host.querySelector<HTMLSelectElement>('select[data-key="spec"]')!
    expect(sel.disabled).toBe(true)
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
