import { describe, it, expect } from 'vitest'
import { makeEpoch } from '../src/renderer/selection-epoch'

describe('makeEpoch', () => {
  it('bump advances monotonically', () => {
    const e = makeEpoch()
    expect(e.bump()).toBe(1)
    expect(e.bump()).toBe(2)
    expect(e.bump()).toBe(3)
  })

  it('isCurrent is true only for the latest token', () => {
    const e = makeEpoch()
    const first = e.bump()
    const second = e.bump()
    expect(e.isCurrent(second)).toBe(true)
    expect(e.isCurrent(first)).toBe(false)
  })

  it('a captured token goes stale once a newer selection bumps', () => {
    const e = makeEpoch()
    const captured = e.bump() // dispatch A
    expect(e.isCurrent(captured)).toBe(true)
    e.bump()                  // user selects B before A resolves
    expect(e.isCurrent(captured)).toBe(false) // A's continuation must bail
  })

  it('two independent epochs do not share state', () => {
    const a = makeEpoch()
    const b = makeEpoch()
    a.bump()
    expect(b.isCurrent(1)).toBe(false)
    expect(b.bump()).toBe(1)
  })
})
