import { describe, it, expect } from 'vitest'
import { presenceOf } from '../src/shared/diff'

describe('presenceOf', () => {
  it('A-only when B count is zero', () => expect(presenceOf(3, 0)).toBe('A-only'))
  it('B-only when A count is zero', () => expect(presenceOf(0, 5)).toBe('B-only'))
  it('both when present in each', () => expect(presenceOf(2, 4)).toBe('both'))
})
