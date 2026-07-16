import { describe, it, expect } from 'vitest'
import { makeBatcher } from '../src/shared/batcher'

// A fake clock: schedule returns a cancel; tick() fires everything due.
function fakeClock() {
  let pending: Array<{ fn: () => void }> = []
  const schedule = (fn: () => void) => { const e = { fn }; pending.push(e); return () => { pending = pending.filter(p => p !== e) } }
  const tick = () => { const due = pending; pending = []; due.forEach(e => e.fn()) }
  return { schedule, tick }
}

describe('makeBatcher', () => {
  it('coalesces a burst into one flush after the quiet window', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.add(1); b.add(2); b.add(3)
    expect(flushes).toEqual([])   // nothing yet - timer keeps resetting
    c.tick()
    expect(flushes).toEqual([[1, 2, 3]])
  })

  it('a later add after a flush starts a fresh batch', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.add(1); c.tick()
    b.add(2); c.tick()
    expect(flushes).toEqual([[1], [2]])
  })

  it('flushNow fires immediately and clears the queue', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.add(1); b.flushNow()
    expect(flushes).toEqual([[1]])
    c.tick()                       // the cancelled timer must not double-fire
    expect(flushes).toEqual([[1]])
  })

  it('cancel drops the pending batch without flushing', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.add(1); b.cancel(); c.tick()
    expect(flushes).toEqual([])
  })

  it('does not flush an empty batch', () => {
    const c = fakeClock(); const flushes: number[][] = []
    const b = makeBatcher<number>(300, items => flushes.push(items), c.schedule)
    b.flushNow(); c.tick()
    expect(flushes).toEqual([])
  })

  it('deduplicates items on flush, preserving insertion order', () => {
    const c = fakeClock(); const flushes: string[][] = []
    const b = makeBatcher<string>(300, items => flushes.push(items), c.schedule)
    b.add('a'); b.add('b'); b.add('a')  // duplicate 'a' at the end
    expect(flushes).toEqual([])   // nothing yet - timer keeps resetting
    c.tick()
    expect(flushes).toEqual([['a', 'b']])  // duplicate 'a' removed, insertion order preserved
  })
})
