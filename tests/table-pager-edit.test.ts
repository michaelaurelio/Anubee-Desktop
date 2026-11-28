// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { wireRangeEdit, renderPager, flashTableRow } from '../src/renderer/table-pager'

function setup(total = 48213, current = 1) {
  document.body.innerHTML =
    '<span id="pager-range" class="rng">1–500 / 48213</span>' +
    '<span id="pager-edit" class="hidden"><input id="pager-input" /><span id="pager-total"></span></span>'
  const range = document.getElementById('pager-range')!
  const editor = document.getElementById('pager-edit')!
  const input = document.getElementById('pager-input') as HTMLInputElement
  const totalLabel = document.getElementById('pager-total')!
  const onJump = vi.fn()
  wireRangeEdit({ range, editor, input, totalLabel, total: () => total, current: () => current, onJump })
  return { range, editor, input, totalLabel, onJump }
}

const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
const blur = (el: HTMLElement) => el.dispatchEvent(new FocusEvent('blur'))

describe('wireRangeEdit', () => {
  it('click opens the editor', () => {
    const { range, editor, input, totalLabel } = setup()
    range.click()
    expect(range.classList.contains('hidden')).toBe(true)
    expect(editor.classList.contains('hidden')).toBe(false)
    expect(totalLabel.textContent).toBe('/ 48213')
    expect(document.activeElement).toBe(input)
  })

  it('opens pre-filled with the current page start, selected', () => {
    const { range, input } = setup(48213, 20001)
    range.click()
    expect(input.value).toBe('20001')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
  })

  it('Enter jumps once', () => {
    const { range, editor, input, onJump } = setup()
    range.click()
    input.value = '12345'
    key(input, 'Enter')
    blur(input)
    expect(onJump).toHaveBeenCalledTimes(1)
    expect(onJump).toHaveBeenCalledWith(12345)
    expect(editor.classList.contains('hidden')).toBe(true)
    expect(range.classList.contains('hidden')).toBe(false)
  })

  it('Escape cancels', () => {
    const { range, input, onJump } = setup()
    range.click()
    input.value = '12345'
    key(input, 'Escape')
    expect(onJump).not.toHaveBeenCalled()
    expect(range.classList.contains('hidden')).toBe(false)
  })

  it('blur cancels', () => {
    const { range, input, onJump } = setup()
    range.click()
    input.value = '12345'
    blur(input)
    expect(onJump).not.toHaveBeenCalled()
    expect(range.classList.contains('hidden')).toBe(false)
  })

  it('non-number cancels', () => {
    const { range, input, onJump } = setup()
    range.click()
    input.value = '12k'
    key(input, 'Enter')
    expect(onJump).not.toHaveBeenCalled()
    expect(range.classList.contains('hidden')).toBe(false)
  })

  it('empty table does not open', () => {
    const { range, editor } = setup(0)
    range.click()
    expect(editor.classList.contains('hidden')).toBe(true)
  })

  it('reopens after a jump', () => {
    const { range, editor, input } = setup()
    range.click()
    input.value = '5'
    key(input, 'Enter')
    range.click()
    expect(editor.classList.contains('hidden')).toBe(false)
    expect(input.value).toBe('1')
  })
})

function pagerSetup() {
  document.body.innerHTML =
    '<button id="pager-first"></button><button id="pager-prev"></button>' +
    '<span id="pager-range"></span>' +
    '<button id="pager-next"></button><button id="pager-last"></button>'
  const b = (id: string) => document.getElementById(id) as HTMLButtonElement
  return { first: b('pager-first'), prev: b('pager-prev'), next: b('pager-next'), last: b('pager-last'), range: document.getElementById('pager-range')! }
}

describe('renderPager', () => {
  it('first page', () => {
    const p = pagerSetup()
    renderPager(0, 500, 48213, 500)
    expect(p.range.textContent).toBe('1–500 / 48213')
    expect([p.first.disabled, p.prev.disabled, p.next.disabled, p.last.disabled]).toEqual([true, true, false, false])
  })
  it('last page, exact multiple', () => {
    const p = pagerSetup()
    renderPager(500, 500, 1000, 500)
    expect(p.range.textContent).toBe('501–1000 / 1000')
    expect([p.first.disabled, p.prev.disabled, p.next.disabled, p.last.disabled]).toEqual([false, false, true, true])
  })
  it('empty', () => {
    const p = pagerSetup()
    renderPager(0, 0, 0, 500)
    expect(p.range.textContent).toBe('0 / 0')
    expect([p.first.disabled, p.prev.disabled, p.next.disabled, p.last.disabled]).toEqual([true, true, true, true])
  })
})

describe('flashTableRow', () => {
  function tableSetup() {
    document.body.innerHTML = '<div id="host"><table><tr><th>id</th></tr><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></table></div>'
    const scroll = vi.fn()
    HTMLElement.prototype.scrollIntoView = scroll
    const host = document.getElementById('host')!
    return { host, rows: host.querySelector('table')!.rows, scroll }
  }
  it('flashes and centres the row at the page index', () => {
    const { host, rows, scroll } = tableSetup()
    flashTableRow(host, 1)
    expect(rows[2].classList.contains('flash')).toBe(true)
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    rows[2].dispatchEvent(new Event('animationend'))
    expect(rows[2].classList.contains('flash')).toBe(false)
  })
  it('ignores an out-of-range index', () => {
    const { host, rows } = tableSetup()
    flashTableRow(host, 7)
    flashTableRow(host, -1)
    expect([...rows].some(r => r.classList.contains('flash'))).toBe(false)
  })
})
