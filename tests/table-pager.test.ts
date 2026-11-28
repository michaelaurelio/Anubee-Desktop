import { describe, it, expect } from 'vitest'
import { clampPosition, pageOffsetFor, lastPageOffset, parsePosition } from '../src/renderer/table-pager'

describe('pageOffsetFor', () => {
  it('rounds down to the page holding the row', () => {
    expect(pageOffsetFor(12345, 600000, 500)).toBe(12000)
    expect(pageOffsetFor(513560, 600000, 500)).toBe(513500)
  })
  it('keeps an exact multiple on its own page', () => {
    expect(pageOffsetFor(12000, 600000, 500)).toBe(11500)
    expect(pageOffsetFor(500, 600000, 500)).toBe(0)
    expect(pageOffsetFor(501, 600000, 500)).toBe(500)
  })
  it('clamps past the end to the last page', () => { expect(pageOffsetFor(999999, 514212, 500)).toBe(514000) })
  it('clamps zero and negatives to the first page', () => {
    expect(pageOffsetFor(0, 514212, 500)).toBe(0)
    expect(pageOffsetFor(-5, 514212, 500)).toBe(0)
  })
  it('is 0 on an empty table', () => { expect(pageOffsetFor(12345, 0, 500)).toBe(0) })
})

describe('lastPageOffset', () => {
  it('starts at the page holding the final row', () => { expect(lastPageOffset(514212, 500)).toBe(514000) })
  it('handles a total that is an exact multiple', () => { expect(lastPageOffset(1000, 500)).toBe(500) })
  it('is 0 for empty and single-page tables', () => {
    expect(lastPageOffset(0, 500)).toBe(0)
    expect(lastPageOffset(500, 500)).toBe(0)
  })
})

describe('clampPosition', () => {
  it('clamps into [1, total]', () => {
    expect(clampPosition(999999, 514212)).toBe(514212)
    expect(clampPosition(-3, 514212)).toBe(1)
    expect(clampPosition(42, 514212)).toBe(42)
  })
  it('is 0 on an empty table', () => { expect(clampPosition(5, 0)).toBe(0) })
})

describe('parsePosition', () => {
  it('reads plain and separated numbers', () => {
    expect(parsePosition('12345')).toBe(12345)
    expect(parsePosition(' 12,345 ')).toBe(12345)
    expect(parsePosition('12_345')).toBe(12345)
    expect(parsePosition('-5')).toBe(-5)
  })
  it('rejects anything else', () => {
    for (const s of ['', '   ', '12k', '1.5', '1e5', 'abc', '-']) expect(parsePosition(s)).toBeUndefined()
  })
})
