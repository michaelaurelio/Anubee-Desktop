import { describe, it, expect } from 'vitest'
import { makeBatcher } from '../src/shared/batcher'

// A time-aware fake clock: schedule(fn, ms) arms a timer for `now + ms` and
// returns a cancel that marks it dead. advance(ms) moves time forward and
// fires every live timer whose due time has been reached, in due order.
// This distinguishes "reset the timer on every call" from "arm once, ignore
// the rest" - a coarse fire-everything-at-once tick() cannot tell those apart.
function fakeClock() {
  let now = 0
  let timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: now + ms, fn, live: true }
    timers.push(t)
    return () => { t.live = false }
  }
  const advance = (ms: number) => {
    now += ms
    for (const t of timers.filter(t => t.live && t.at <= now).sort((a, b) => a.at - b.at)) {
      if (!t.live) continue
      t.live = false
      t.fn()
    }
  }
  return { schedule, advance }
}

describe('makeBatcher', () => {
  it('coalesces a burst into one flush after the quiet window', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.add(1); b.add(2); b.add(3)
    expect(flushes).toEqual([])   // nothing yet - timer keeps resetting
    c.advance(300)
    expect(flushes).toEqual([[1, 2, 3]])
  })

  it('a later add after a flush starts a fresh batch', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.add(1); c.advance(300)
    b.add(2); c.advance(300)
    expect(flushes).toEqual([[1], [2]])
  })

  it('flushNow fires immediately and clears the queue', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.add(1); b.flushNow()
    expect(flushes).toEqual([[1]])
    c.advance(300)                 // the cancelled timer must not double-fire
    expect(flushes).toEqual([[1]])
  })

  it('cancel drops the pending batch without flushing', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.add(1); b.cancel(); c.advance(300)
    expect(flushes).toEqual([])
  })

  it('cancel clears the queue, not just the timer - a later add starts empty', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.add(1); b.cancel(); b.add(2); c.advance(300)
    expect(flushes).toEqual([[2]])   // not [2, 1] or [1, 2] - the 1 must be gone
  })

  it('does not flush an empty batch', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.flushNow(); c.advance(300)
    expect(flushes).toEqual([])
  })

  it('each add resets the debounce window rather than arming it once', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.add(1)
    c.advance(200)                 // 200 since add(1) - short of the 300 window
    b.add(2)                       // this must push the deadline out again
    c.advance(200)                 // 400 since add(1), but only 200 since add(2)
    expect(flushes).toEqual([])    // must NOT have fired yet
    c.advance(100)                 // 300 since add(2)
    expect(flushes).toEqual([[1, 2]])
  })

  it('deduplicates items on flush, preserving insertion order (not sorted order)', () => {
    const c = fakeClock(); const flushes: string[][] = []
    const b = makeBatcher<string>(300, items => flushes.push(items), c.schedule)
    // '0x20' before '0x10': insertion order differs from sorted order, so a
    // stray .sort() on the deduped result would be caught by this fixture.
    b.add('0x20'); b.add('0x10'); b.add('0x20')
    expect(flushes).toEqual([])   // nothing yet - timer keeps resetting
    c.advance(300)
    expect(flushes).toEqual([['0x20', '0x10']])  // duplicate removed, insertion order kept
  })
})
