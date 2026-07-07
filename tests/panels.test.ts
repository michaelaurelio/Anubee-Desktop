import { describe, it, expect } from 'vitest'
import { clampWidth, parseLayout, serializeLayout, DEFAULT_LAYOUT, MIN_W, MAX_W } from '../src/renderer/panels'

describe('panels layout math', () => {
  it('clampWidth bounds to [MIN_W, MAX_W]', () => {
    expect(clampWidth(10)).toBe(MIN_W)
    expect(clampWidth(9999)).toBe(MAX_W)
    expect(clampWidth(300)).toBe(300)
  })

  it('serialize/parse round-trips a full state', () => {
    const s = { tableW: 500, sideW: 240, tableCollapsed: true, sideCollapsed: false }
    expect(parseLayout(serializeLayout(s))).toEqual(s)
  })

  it('parseLayout returns defaults for null or corrupt input', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT)
    expect(parseLayout('{not json')).toEqual(DEFAULT_LAYOUT)
  })

  it('parseLayout fills missing fields from defaults and clamps widths', () => {
    const out = parseLayout(JSON.stringify({ tableW: 5, sideCollapsed: true }))
    expect(out.tableW).toBe(MIN_W)               // clamped
    expect(out.sideW).toBe(DEFAULT_LAYOUT.sideW) // filled
    expect(out.sideCollapsed).toBe(true)         // kept
    expect(out.tableCollapsed).toBe(false)       // filled
  })
})
