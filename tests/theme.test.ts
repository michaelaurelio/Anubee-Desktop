import { describe, it, expect } from 'vitest'
import { themeColors, parseTheme, serializeTheme, categoryColors, type KindColors } from '../src/renderer/theme'

describe('theme', () => {
  it('themeColors returns a full color set for both themes', () => {
    for (const t of ['dark', 'light'] as const) {
      const c = themeColors(t)
      for (const k of ['java', 'native', 'syscall', 'func', 'check', 'labelBacking', 'edge'] as (keyof KindColors)[]) {
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

describe('categoryColors', () => {
  it('returns a distinct color for every RASP category in dark', () => {
    const c = categoryColors('dark')
    const cats = ['root', 'debugger', 'emulator', 'integrity', 'hook', 'custom'] as const
    for (const k of cats) expect(c[k]).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(new Set(Object.values(c)).size).toBe(cats.length) // all distinct
  })
  it('returns a full map in light too', () => {
    const c = categoryColors('light')
    expect(c.root).toMatch(/^#[0-9a-fA-F]{6}$/)
  })
})
