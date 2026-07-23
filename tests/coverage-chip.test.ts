import { describe, it, expect } from 'vitest'
import { coverageChipText } from '../src/renderer/coverage-chip'
import type { CoverageEvent } from '@shared/events'

describe('coverageChipText', () => {
  it('empty chip when there is no coverage record at all', () => {
    expect(coverageChipText(undefined)).toBe('')
  })

  it('full snapshot data: snaps + cfi', () => {
    const cov: CoverageEvent = {
      type: 'coverage', engine: 'syscalls',
      snaps: { total: 42, truncated: 3 },
      cfi: { walks: 40, stops: { no_fde: 2 } },
    }
    expect(coverageChipText(cov)).toBe('42 snapshots · 3 truncated · CFI walks 40')
  })

  it('exempt: shows the reason, not a fabricated zero', () => {
    const cov: CoverageEvent = { type: 'coverage', engine: 'lib', exempt: true, reason: 'no coverage surface' }
    expect(coverageChipText(cov)).toBe('coverage: not applicable (no coverage surface)')
  })

  it('exempt with no reason field: falls back to a generic phrase', () => {
    const cov: CoverageEvent = { type: 'coverage', engine: 'dump', exempt: true }
    expect(coverageChipText(cov)).toBe('coverage: not applicable (no coverage surface)')
  })

  it('clean: no degradation signal fired', () => {
    const cov: CoverageEvent = { type: 'coverage', engine: 'funcs', clean: true }
    expect(coverageChipText(cov)).toBe('coverage: full - no truncation, drops, or blind spots')
  })

  it('clean with returns: funcs returns mode with full capture still states the count', () => {
    const cov: CoverageEvent = {
      type: 'coverage', engine: 'funcs', clean: true, returns: { spans: 50, captured: 50 },
    }
    expect(coverageChipText(cov)).toBe('50/50 returns captured')
  })

  it('a record missing both snaps and cfi (e.g. captured without --snapshot, nothing else to report): empty chip, not a misleading zero', () => {
    const cov: CoverageEvent = { type: 'coverage', engine: 'syscalls' }
    expect(coverageChipText(cov)).toBe('')
  })

  it('degraded: drops only, no snaps/cfi present', () => {
    const cov: CoverageEvent = { type: 'coverage', engine: 'syscalls', drops: { ring: 5, queue: 0 } }
    expect(coverageChipText(cov)).toBe('5 ring drops')
  })

  it('degraded: drops with both ring and queue', () => {
    const cov: CoverageEvent = { type: 'coverage', engine: 'syscalls', drops: { ring: 5, queue: 2 } }
    expect(coverageChipText(cov)).toBe('5 ring drops, 2 queue drops')
  })

  it('degraded: managed_naming_off, prearm_drops, depth_capped, decode_partial all compose', () => {
    const cov: CoverageEvent = {
      type: 'coverage', engine: 'funcs',
      managed_naming_off: true, prearm_drops: 7, depth_capped: 1, decode_partial: true,
    }
    expect(coverageChipText(cov)).toBe('Java naming off · 7 pre-arm drops · 1 depth-capped · args not decoded')
  })

  it('degraded: returns mode with a shortfall', () => {
    const cov: CoverageEvent = {
      type: 'coverage', engine: 'funcs', returns: { spans: 100, captured: 80 },
    }
    expect(coverageChipText(cov)).toBe('80/100 returns captured')
  })

  it('does not throw on an unrecognized future shape (extra unknown fields)', () => {
    const cov = { type: 'coverage', engine: 'syscalls', somethingNew: true } as unknown as CoverageEvent
    expect(() => coverageChipText(cov)).not.toThrow()
    expect(coverageChipText(cov)).toBe('')
  })
})
