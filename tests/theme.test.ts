import { describe, it, expect } from 'vitest'
import { themeColors, parseTheme, serializeTheme, type KindColors } from '../src/renderer/theme'

describe('theme', () => {
  it('themeColors returns a full color set for both themes', () => {
    for (const t of ['dark', 'light'] as const) {
      const c = themeColors(t)
      for (const k of ['java', 'native', 'syscall', 'labelBacking', 'edge'] as (keyof KindColors)[]) {
        expect(typeof c[k]).toBe('string')
        expect(c[k]).toMatch(/^#[0-9a-f]{3,8}$/i)
      }
    }
  })

  it('dark and light differ in the label backing', () => {
    expect(themeColors('dark').labelBacking).not.toBe(themeColors('light').labelBacking)
  })

  it('parseTheme defaults to dark and is corrupt-safe', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme(null)).toBe('dark')
    expect(parseTheme('garbage')).toBe('dark')
  })

  it('serializeTheme round-trips through parseTheme', () => {
    expect(parseTheme(serializeTheme('light'))).toBe('light')
    expect(parseTheme(serializeTheme('dark'))).toBe('dark')
  })
})
