// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { wireRangeEdit } from '../src/renderer/table-pager'

function setup(total = 48213) {
  document.body.innerHTML =
    '<span id="pager-range" class="rng">1–500 / 48213</span>' +
    '<span id="pager-edit" class="hidden"><input id="pager-input" /><span id="pager-total"></span></span>'
  const range = document.getElementById('pager-range')!
  const editor = document.getElementById('pager-edit')!
  const input = document.getElementById('pager-input') as HTMLInputElement
  const totalLabel = document.getElementById('pager-total')!
  const onJump = vi.fn()
  wireRangeEdit({ range, editor, input, totalLabel, total: () => total, onJump })
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
    expect(input.value).toBe('')
  })
})
