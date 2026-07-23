import { describe, it, expect, vi } from 'vitest'
import { createRunLifecycle, type StoppableRun } from '../src/main/run-lifecycle'

const fakeRun = (): StoppableRun & { stop: ReturnType<typeof vi.fn> } => ({
  stop: vi.fn(async () => {}),
})

describe('createRunLifecycle', () => {
  it('starts idle, start() moves to device phase and records argv', () => {
    const lc = createRunLifecycle()
    expect(lc.phase()).toBe('idle')
    expect(lc.argv()).toBeNull()
    const run = fakeRun()
    lc.start('su -c \'...\'', run)
    expect(lc.phase()).toBe('device')
    expect(lc.argv()).toBe('su -c \'...\'')
  })

  it('start() throws (clobber guard) when a run is already active, in any non-idle phase', () => {
    const lc = createRunLifecycle()
    lc.start('argv1', fakeRun())
    expect(() => lc.start('argv2', fakeRun())).toThrow('a capture is already running')
    lc.markExited()
    expect(() => lc.start('argv2', fakeRun())).toThrow('a capture is already running')
  })

  it('markExited moves device -> finishing and hands back + clears discardActive in one step', () => {
    const lc = createRunLifecycle()
    lc.start('argv', fakeRun())
    lc.requestStop(true) // discard requested while still in 'device'
    const { wasDiscarded } = lc.markExited()
    expect(wasDiscarded).toBe(true)
    expect(lc.phase()).toBe('finishing')
    // A second markExited (should not happen in practice, but the flag must
    // not resurrect itself) reports false - it was already consumed.
    expect(lc.markExited().wasDiscarded).toBe(false)
  })

  it('requestStop acts (returns the handle, records discard) only in the device phase', () => {
    const lc = createRunLifecycle()
    expect(lc.requestStop(true)).toBeUndefined() // idle: nothing to stop
    const run = fakeRun()
    lc.start('argv', run)
    expect(lc.requestStop(false)).toBe(run) // device: real stop
  })

  // The F1 regression this whole module exists to make testable: a Stop click
  // that lands during the pull/ingest window (phase 'finishing') must be a
  // total no-op - it must not set discardActive, because the only code that
  // consumes discardActive for THIS run (markExited) already ran, and a write
  // here would otherwise sit untouched until the NEXT run's markExited reads
  // it, silently discarding a capture the analyst never asked to discard.
  //
  // This test fails without the fix: swap requestStop's `phase !== 'device'`
  // guard back to the old `!activeRun`-shaped check (i.e. only reject in
  // 'idle') and run1's late discard leaks into run2 - run2Discarded flips to
  // true below.
  it('F1: a stop-and-discard click during the pull window (finishing) does not leak into the next run', () => {
    const lc = createRunLifecycle()

    // --- run 1: "Stop & open run", then a late "Stop & discard" click while
    // pull/ingest is still in flight (activeRun-equivalent state is still
    // non-idle, matching the real widened-activeRun window). ---
    const run1 = fakeRun()
    lc.start('argv1', run1)
    lc.requestStop(false) // Stop & open run: do not discard
    const { wasDiscarded: run1Discarded } = lc.markExited() // device -> finishing
    expect(run1Discarded).toBe(false) // run1 pulls/ingests normally

    // The user's late "Stop & discard" click arrives here, mid pull/ingest -
    // i.e. while lc.phase() === 'finishing'. With the guard fixed, this must
    // be entirely inert.
    const stopResult = lc.requestStop(true)
    expect(stopResult).toBeUndefined() // nothing to stop - no live process
    expect(lc.phase()).toBe('finishing') // unchanged by the inert click

    lc.finish() // run1's IPC handler finally: always clears everything

    // --- run 2: a fresh capture. If the late click above had leaked
    // discardActive=true past run1's finish(), run2's own markExited would
    // report wasDiscarded=true and its result would be silently dropped. ---
    const run2 = fakeRun()
    lc.start('argv2', run2)
    const { wasDiscarded: run2Discarded } = lc.markExited()
    expect(run2Discarded).toBe(false)
  })

  it('finish() always resets to idle regardless of phase, and is itself idempotent', () => {
    const lc = createRunLifecycle()
    lc.finish() // idle -> idle: must not throw
    expect(lc.phase()).toBe('idle')

    lc.start('argv', fakeRun())
    lc.finish()
    expect(lc.phase()).toBe('idle')
    expect(lc.argv()).toBeNull()
    expect(lc.requestStop(true)).toBeUndefined()
  })
})
