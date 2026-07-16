import { describe, it, expect } from 'vitest'
import { clampHeight, serializeDock, parseDock, DEFAULT_DOCK, MIN_H, MAX_H } from '../src/renderer/lib-dock-layout'

describe('clampHeight', () => {
  it('bounds height to [MIN_H, MAX_H]', () => {
    expect(clampHeight(MIN_H - 50)).toBe(MIN_H)
    expect(clampHeight(MAX_H + 50)).toBe(MAX_H)
    expect(clampHeight(200)).toBe(200)
  })
})

describe('parseDock', () => {
  it('returns the default for null / corrupt input', () => {
    expect(parseDock(null)).toEqual(DEFAULT_DOCK)
    expect(parseDock('{not json')).toEqual(DEFAULT_DOCK)
  })
  it('round-trips a valid layout', () => {
    const s = { height: 240, collapsed: true, activeTab: 'log' as const }
    expect(parseDock(serializeDock(s))).toEqual(s)
  })
  it('clamps a persisted out-of-range height', () => {
    expect(parseDock(JSON.stringify({ height: 99999, collapsed: false, activeTab: 'artifacts' })).height).toBe(MAX_H)
  })
  it('falls back per-field: a bad activeTab does not corrupt the rest', () => {
    const p = parseDock(JSON.stringify({ height: 240, collapsed: true, activeTab: 'bogus' }))
    expect(p.height).toBe(240)
    expect(p.collapsed).toBe(true)
    expect(p.activeTab).toBe(DEFAULT_DOCK.activeTab)   // invalid tab -> default, not 'bogus'
  })
})
