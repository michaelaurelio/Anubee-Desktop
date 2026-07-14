// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { currentFilter, wireFilterControls } from '../src/renderer/filter-controls'

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
    type(input, 'java:yes')
    key(input, ' ')
    ;(document.querySelector('#omni-chips .chip-x') as HTMLElement).click()
    expect(document.querySelectorAll('#omni-chips .chip')).toHaveLength(0)
    expect(currentFilter()).toEqual({})
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('Backspace in an empty input pops the last chip back as text, no refresh', () => {
    const { input, refresh } = setup()
    type(input, 'lib:libc')
    key(input, ' ')
    type(input, '')
    key(input, 'Backspace')
    expect(document.querySelectorAll('#omni-chips .chip')).toHaveLength(0)
    expect(input.value).toBe('lib:libc')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('pops a spaced value back re-quoted', () => {
    const { input } = setup()
    type(input, 'symbol:"a b"')
    key(input, ' ')
    type(input, '')
    key(input, 'Backspace')
    expect(input.value).toBe('symbol:"a b"')
  })
})

describe('autocomplete', () => {
  it('lists matching keys for the current word prefix', () => {
    const { input } = setup()
    type(input, 'sy')
    const ac = document.getElementById('omni-ac')!
    expect(ac.classList.contains('hidden')).toBe(false)
    expect(ac.textContent).toContain('syscall:')
    expect(ac.textContent).toContain('symbol:')
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
    expect(input.value).toBe('java:')
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
