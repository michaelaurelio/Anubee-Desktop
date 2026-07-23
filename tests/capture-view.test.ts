// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import {
  renderCapabilityForm, renderEngineSegments, specsDirRow,
  appendConsoleLine, appendConsoleLines, CONSOLE_LINE_CAP,
  applyFieldErrors, renderDot, applySpecChoices,
} from '../src/renderer/capture-view'
import { capById, CAPABILITIES } from '../src/shared/tracer-caps'

const addChip = (host: HTMLElement, text: string): void => {
  const inp = host.querySelector<HTMLInputElement>('.chip-add')!
  inp.value = text
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

describe('renderEngineSegments', () => {
  it('renders one segment per engine and marks the current one', () => {
    const host = document.createElement('div')
    renderEngineSegments(host, CAPABILITIES, 'syscalls', () => {})
    const segs = [...host.querySelectorAll<HTMLElement>('[data-engine]')]
    expect(segs.map(s => s.dataset.engine)).toEqual(['syscalls', 'funcs'])
    expect(segs[0].classList.contains('on')).toBe(true)
    expect(segs[1].classList.contains('on')).toBe(false)
  })

  it('reports a pick and does not re-fire for the current engine', () => {
    const host = document.createElement('div')
    const picks: string[] = []
    renderEngineSegments(host, CAPABILITIES, 'syscalls', id => picks.push(id))
    host.querySelector<HTMLElement>('[data-engine="funcs"]')!.click()
    host.querySelector<HTMLElement>('[data-engine="syscalls"]')!.click()
    expect(picks).toEqual(['funcs'])
  })

  it('describes each engine and badges the stealthy one', () => {
    const host = document.createElement('div')
    renderEngineSegments(host, CAPABILITIES, 'syscalls', () => {})
    expect(host.querySelector('.engine-desc')!.textContent!.toLowerCase()).toContain('syscall')
    expect(host.querySelector('.engine-badge')!.textContent).toBe('injectionless')
    renderEngineSegments(host, CAPABILITIES, 'funcs', () => {})
    expect(host.querySelector('.engine-badge')!.textContent).toBe('detectable')
  })
})

describe('renderCapabilityForm', () => {
  it('renders one control per input and reports changes', () => {
    const host = document.createElement('div')
    let latest = {}
    renderCapabilityForm(host, capById('syscalls')!, {}, v => { latest = v })
    const pkg = host.querySelector<HTMLInputElement>('[data-key="pkg"]')!
    expect(pkg).toBeTruthy()
    pkg.value = 'dev.anubee.detector'
    pkg.dispatchEvent(new Event('input'))
    expect(latest).toMatchObject({ pkg: 'dev.anubee.detector' })
  })

  it('renders a chip list, not a checkbox, for the library filter', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, {}, () => {})
    expect(host.querySelector('.chip-list[data-key="libs"]')).not.toBeNull()
    expect(host.querySelector('[data-key="all"]')).toBeNull()
    expect(host.querySelector('[data-key="lib"]')).toBeNull()
  })

  it('shows the capture-all hint when no selector is set', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, {}, () => {})
    expect(host.querySelector('.chip-empty')!.textContent).toContain('every library')
  })

  it('adds a chip on Enter and reports it newline-joined', () => {
    const host = document.createElement('div')
    let latest: Record<string, unknown> = {}
    renderCapabilityForm(host, capById('syscalls')!, {}, v => { latest = v })
    addChip(host, 'libsentinel.so')
    addChip(host, 'e_*')
    expect(latest.libs).toBe('libsentinel.so\ne_*')
    expect([...host.querySelectorAll('.chip')].map(c => (c as HTMLElement).dataset.chip))
      .toEqual(['libsentinel.so', 'e_*'])
    expect(host.querySelector('.chip-empty')).toBeNull()
    expect(host.querySelector<HTMLInputElement>('.chip-add')!.value).toBe('')
  })

  it('removes a chip and restores the hint when the last one goes', () => {
    const host = document.createElement('div')
    let latest: Record<string, unknown> = {}
    renderCapabilityForm(host, capById('syscalls')!, { libs: 'libsentinel.so' }, v => { latest = v })
    host.querySelector<HTMLButtonElement>('.chip [data-role="chipdel"]')!.click()
    expect(latest.libs).toBe('')
    expect(host.querySelector('.chip-empty')).not.toBeNull()
  })

  it('ignores a blank or duplicate chip', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, {}, () => {})
    addChip(host, '   ')
    addChip(host, 'libsentinel.so')
    addChip(host, 'libsentinel.so')
    expect(host.querySelectorAll('.chip')).toHaveLength(1)
  })

  it('seeds chips from existing values', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, { libs: 'a.so\nb.so' }, () => {})
    expect(host.querySelectorAll('.chip')).toHaveLength(2)
  })

  it('does not commit a chip when blur moves focus to a chip delete button', () => {
    const host = document.createElement('div')
    let latest: Record<string, unknown> = {}
    renderCapabilityForm(host, capById('syscalls')!, { libs: 'libsentinel.so' }, v => { latest = v })
    const add = host.querySelector<HTMLInputElement>('.chip-add')!
    add.value = 'e_*'
    const del = host.querySelector<HTMLButtonElement>('.chip [data-role="chipdel"]')!
    add.dispatchEvent(new FocusEvent('blur', { relatedTarget: del }))
    expect(host.querySelectorAll('.chip')).toHaveLength(1)
    expect(latest.libs).toBeUndefined()
    expect(add.value).toBe('e_*')
  })

  it('commits a chip on blur when focus moves outside the chip list', () => {
    const host = document.createElement('div')
    let latest: Record<string, unknown> = {}
    renderCapabilityForm(host, capById('syscalls')!, {}, v => { latest = v })
    const add = host.querySelector<HTMLInputElement>('.chip-add')!
    add.value = 'libsentinel.so'
    add.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }))
    expect(latest.libs).toBe('libsentinel.so')
    expect(host.querySelectorAll('.chip')).toHaveLength(1)
    expect(add.value).toBe('')
  })

  it('no longer injects the specs-dir row into the argument form', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('funcs')!, {}, () => {})
    expect(host.querySelector('[data-config="specsDir"]')).toBeNull()
    expect(host.querySelector('select[data-key="spec"]')).not.toBeNull()
  })

  it('reserves a fixed-height error slot per row so errors never reflow', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, {}, () => {})
    const slots = host.querySelectorAll('.cap-input-err')
    expect(slots.length).toBeGreaterThan(0)
    for (const s of slots) expect((s as HTMLElement).dataset.err).toBeTruthy()
  })

  it('renders an error span for the chip list', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, {}, () => {})
    applyFieldErrors(host, { libs: 'too many' })
    expect(host.querySelector('[data-err="libs"]')!.textContent).toBe('too many')
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
})

describe('specsDirRow', () => {
  it('is exported for the host-setup block and keeps its markers', () => {
    const row = specsDirRow('/host/specs')
    expect(row.querySelector<HTMLInputElement>('[data-config="specsDir"]')!.value).toBe('/host/specs')
    expect(row.querySelector('[data-role="specsBrowse"]')).not.toBeNull()
    expect(row.querySelector('[data-role="specsDot"]')).not.toBeNull()
    expect(row.querySelector('[data-err="specsDir"]')).not.toBeNull()
  })
})

describe('applyFieldErrors', () => {
  it('fills the matching error span and clears the rest', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('syscalls')!, {}, () => {})
    applyFieldErrors(host, { pkg: 'is required' })
    expect((host.querySelector('[data-err="pkg"]') as HTMLElement).textContent).toBe('is required')
    expect((host.querySelector('[data-err="libs"]') as HTMLElement).textContent).toBe('')
  })
})

describe('renderDot', () => {
  it('marks ok and bad with the right class and title', () => {
    const dot = document.createElement('span')
    renderDot(dot, { ok: true, detail: 'anubee' })
    expect(dot.className).toContain('preflight-ok')
    renderDot(dot, { ok: false, detail: 'not set' })
    expect(dot.className).toContain('preflight-bad')
    expect(dot.title).toBe('not set')
  })
})

describe('renderCapabilityForm spec engine', () => {
  it('renders the spec input as a select seeded from vals', () => {
    const host = document.createElement('div')
    renderCapabilityForm(host, capById('funcs')!, { spec: 'b.spec' }, () => {},
      { specNames: ['a.spec', 'b.spec'], specsDir: '/host/specs' })
    const sel = host.querySelector<HTMLSelectElement>('select[data-key="spec"]')!
    expect(sel).not.toBeNull()
    expect(sel.disabled).toBe(false)
    expect(Array.from(sel.options).map(o => o.value)).toEqual(['', 'a.spec', 'b.spec'])
    expect(sel.value).toBe('b.spec')
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

  it('caps the console DOM, dropping the oldest lines first', () => {
    const host = document.createElement('div')
    for (let i = 0; i < 5010; i++) appendConsoleLine(host, `line ${i}`)
    expect(host.children.length).toBe(5000)
    // Oldest lines were dropped, newest survive.
    expect(host.firstElementChild!.textContent).toBe('line 10')
    expect(host.lastElementChild!.textContent).toBe('line 5009')
  }, 20000)
})

describe('appendConsoleLines', () => {
  it('appends a whole batch in order', () => {
    const host = document.createElement('div')
    appendConsoleLines(host, ['a', 'b', 'c'])
    expect([...host.children].map(e => e.textContent)).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op for an empty batch', () => {
    const host = document.createElement('div')
    appendConsoleLines(host, [])
    expect(host.children.length).toBe(0)
  })

  // A batch larger than the cap would be evicted down to it anyway, so the
  // surplus is never painted - building those nodes is pure waste.
  it('never builds more nodes than the cap, even for an oversized batch', () => {
    const host = document.createElement('div')
    const created: string[] = []
    const realCreate = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      created.push(tag)
      return realCreate(tag)
    }) as typeof document.createElement)
    appendConsoleLines(host, Array.from({ length: CONSOLE_LINE_CAP + 500 }, (_, i) => `line ${i}`))
    spy.mockRestore()
    expect(created.filter(t => t === 'div').length).toBe(CONSOLE_LINE_CAP)
    expect(host.children.length).toBe(CONSOLE_LINE_CAP)
    // The newest lines are the ones kept.
    expect(host.lastElementChild!.textContent).toBe(`line ${CONSOLE_LINE_CAP + 499}`)
  }, 20000)

  // Reading scrollHeight per line forced a synchronous layout and starved the
  // event loop on a chatty capture; a batch must touch it a bounded number of
  // times regardless of how many lines it carries.
  it('does not scale scroll reads with batch size', () => {
    const host = document.createElement('div')
    let reads = 0
    Object.defineProperty(host, 'scrollHeight', { get() { reads += 1; return 0 } })
    appendConsoleLines(host, Array.from({ length: 500 }, (_, i) => `line ${i}`))
    expect(reads).toBeLessThanOrEqual(2)
  })
})
