import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const html = readFileSync(resolve(__dirname, '../src/renderer/index.html'), 'utf-8')

describe('brand accent recolor', () => {
  // Old war-red accent literals (accent group + comment) must all be gone.
  const bannedReds = ['#c8322b', '#d8443b', '#f08a80', '#b02a24', '#f6e7e5']
  for (const hex of bannedReds) {
    it(`no longer contains old accent literal ${hex}`, () => {
      expect(html.toLowerCase()).not.toContain(hex.toLowerCase())
    })
  }

  it('defines the gold accent in dark theme', () => {
    expect(html).toContain('--accent: #c9a24a')
  })
  it('defines the gold accent in light theme', () => {
    expect(html).toContain('--accent: #b0812e')
  })
  it('defines --accent-ink for text on gold fills', () => {
    expect(html).toContain('--accent-ink: #17140d')
  })
  it('primary button uses accent-ink, not white text', () => {
    const rule = html.match(/\.btn\.pri\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('var(--accent-ink)')
    expect(rule).not.toContain('#fff')
  })
})
