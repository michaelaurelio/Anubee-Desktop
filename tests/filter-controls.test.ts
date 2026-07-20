// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { currentFilter, wireFilterControls, setTagResolver } from '../src/renderer/filter-controls'

function setup(): { input: HTMLInputElement; refresh: ReturnType<typeof vi.fn> } {
  document.body.innerHTML =
    '<div id="cmdbar"><div class="omni">' +
    '<span id="omni-chips"></span>' +
    '<input id="f-text" type="text" />' +
    '<div id="omni-ac" class="hidden"></div>' +
    '</div></div>'
  const refresh = vi.fn()
  wireFilterControls(refresh)
  return { input: document.getElementById('f-text') as HTMLInputElement, refresh }
}

function key(el: HTMLInputElement, k: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}

function type(el: HTMLInputElement, text: string): void {
  el.value = text
  el.setSelectionRange(text.length, text.length)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('chip creation', () => {
  it('space converts a complete token into a chip and strips it from the input', () => {
    const { input } = setup()
    type(input, 'syscall:openat')
    key(input, ' ')
    expect(document.querySelectorAll('#omni-chips .chip')).toHaveLength(1)
    expect(document.querySelector('#omni-chips .chip')?.textContent).toContain('syscall:')
    expect(input.value).toBe('')
    expect(currentFilter()).toEqual({ syscall: 'openat' })
  })

  it('space after a non-token does nothing', () => {
    const { input, refresh } = setup()
    type(input, '/proc/self')
    key(input, ' ')
    expect(document.querySelectorAll('#omni-chips .chip')).toHaveLength(0)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('a second chip with the same key replaces the first', () => {
    const { input } = setup()
    type(input, 'syscall:read')
    key(input, ' ')
    type(input, 'syscall:openat')
    key(input, ' ')
    expect(document.querySelectorAll('#omni-chips .chip')).toHaveLength(1)
    expect(currentFilter()).toEqual({ syscall: 'openat' })
  })

  it('space mid-quote does not chip - quoted value stays typeable', () => {
    const { input, refresh } = setup()
    type(input, 'symbol:"a')
    key(input, ' ')
    expect(document.querySelectorAll('#omni-chips .chip')).toHaveLength(0)
    expect(input.value).toBe('symbol:"a')
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('apply and removal', () => {
  it('Enter chips remaining tokens, keeps free text, and refreshes', () => {
    const { input, refresh } = setup()
    type(input, 'tid:101 /proc/self')
    key(input, 'Enter')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('/proc/self')
    expect(currentFilter()).toEqual({ tid: 101, text: '/proc/self' })
  })

  it('chip x removes the chip and refreshes', () => {
    const { input, refresh } = setup()
    type(input, 'java.exist:yes')
    key(input, ' ')
    ;(document.querySelector('#omni-chips .chip-x') as HTMLElement).click()
    expect(document.querySelectorAll('#omni-chips .chip')).toHaveLength(0)
    expect(currentFilter()).toEqual({})
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('Backspace in an empty input pops the last chip back as text, no refresh', () => {
    const { input, refresh } = setup()
    type(input, 'stack.lib:libc')
    key(input, ' ')
    type(input, '')
    key(input, 'Backspace')
    expect(document.querySelectorAll('#omni-chips .chip')).toHaveLength(0)
    expect(input.value).toBe('stack.lib:libc')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('pops a spaced value back re-quoted', () => {
    const { input } = setup()
    type(input, 'fn.sym:"a b"')
    key(input, ' ')
    type(input, '')
    key(input, 'Backspace')
    expect(input.value).toBe('fn.sym:"a b"')
  })
})

describe('autocomplete', () => {
  it('lists matching keys for the current word prefix', () => {
    const { input } = setup()
    type(input, 'st')
    const ac = document.getElementById('omni-ac')!
    expect(ac.classList.contains('hidden')).toBe(false)
    expect(ac.textContent).toContain('stack.lib:')
    expect(ac.textContent).toContain('stack.sym:')
  })

  it('Tab accepts the highlighted key', () => {
    const { input } = setup()
    type(input, 'sys')
    key(input, 'Tab')
    expect(input.value).toBe('syscall:')
    expect(document.getElementById('omni-ac')!.classList.contains('hidden')).toBe(true)
  })

  it('Enter accepts instead of applying while the dropdown is open', () => {
    const { input, refresh } = setup()
    type(input, 'ja')
    key(input, 'Enter')
    expect(input.value).toBe('java.exist:')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('hides once the word contains a colon', () => {
    const { input } = setup()
    type(input, 'syscall:op')
    expect(document.getElementById('omni-ac')!.classList.contains('hidden')).toBe(true)
  })

  it('Escape hides the dropdown', () => {
    const { input } = setup()
    type(input, 'li')
    key(input, 'Escape')
    expect(document.getElementById('omni-ac')!.classList.contains('hidden')).toBe(true)
  })

  it('ArrowDown/ArrowUp cycle the highlighted key', () => {
    const { input } = setup()
    type(input, 'st') // matches stack.lib + stack.sym
    key(input, 'ArrowDown')
    let on = document.querySelector('#omni-ac .ac-row.on b')
    expect(on?.textContent).toBe('stack.sym:')
    key(input, 'ArrowUp')
    on = document.querySelector('#omni-ac .ac-row.on b')
    expect(on?.textContent).toBe('stack.lib:')
    key(input, 'Tab')
    expect(input.value).toBe('stack.lib:')
  })
})

describe('currentFilter', () => {
  it('folds chips plus live free text', () => {
    const { input } = setup()
    type(input, 'syscall:openat')
    key(input, ' ')
    type(input, '/proc/self')
    expect(currentFilter()).toEqual({ syscall: 'openat', text: '/proc/self' })
  })
})

describe('tag resolver injection', () => {
  it('populates tagTargets for a tag.exist chip via the resolver', () => {
    const { input } = setup()
    setTagResolver(() => ({ syscalls: ['openat'], natFrames: [], javaMethods: [] }))
    type(input, 'tag.exist:yes')
    key(input, ' ')
    expect(currentFilter()).toEqual({
      tagged: 'yes', tagTargets: { syscalls: ['openat'], natFrames: [], javaMethods: [] },
    })
    setTagResolver(null)
  })
  it('passes the category to the resolver for tag.name', () => {
    const { input } = setup()
    const seen: (string | undefined)[] = []
    setTagResolver(cat => { seen.push(cat); return { syscalls: [], natFrames: [], javaMethods: [] } })
    type(input, 'tag.name:root')
    key(input, ' ')
    currentFilter()
    expect(seen).toContain('root')
    setTagResolver(null)
  })
  it('does not call the resolver when no tag chip is present', () => {
    const { input } = setup()
    let calls = 0
    setTagResolver(() => { calls++; return { syscalls: [], natFrames: [], javaMethods: [] } })
    type(input, 'syscall:openat')
    key(input, ' ')
    currentFilter()
    expect(calls).toBe(0)
    setTagResolver(null)
  })
})

describe('autocomplete — dotted keys', () => {
  it('typing "java." offers both java.* keys', () => {
    const { input } = setup()
    type(input, 'java.')
    const rows = [...document.querySelectorAll('#omni-ac .ac-row b')].map(b => b.textContent)
    expect(rows).toContain('java.exist:')
    expect(rows).toContain('java.method:')
  })
})
