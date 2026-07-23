// Pure, injectable run-lifecycle state for feature 9 (tracer control). Extracted
// out of index.ts's module-level activeRun/activeRunArgv/discardActive mutable
// trio so the sequencing bug class - state written after the only code that
// consumes it has already run - is unit-testable without an ipcMain harness.
//
// Phases:
//   idle      - nothing running; tracer:start may proceed.
//   device    - the device-side process is live; Stop can act on it for real.
//   finishing - the process exited and pull+ingest is in flight. There is
//               nothing left to stop here: this is the guard that replaces
//               the old `if (!activeRun) return` (activeRun stayed set through
//               this window on purpose, so that check always passed) and is
//               what stops a late Stop-and-discard click from writing
//               discardActive after markExited() already read and cleared it
//               for THIS run - the write used to survive into the NEXT one.
export type RunPhase = 'idle' | 'device' | 'finishing'

export interface StoppableRun {
  stop(): Promise<void>
}

export interface RunLifecycle {
  phase(): RunPhase
  argv(): string | null
  // Registers a new active run. Throws if one is already active - mirrors the
  // original tracer:start clobber guard, so a caller cannot silently orphan a
  // prior run. Call only once the run handle actually exists (i.e. after
  // startRun() returns), so a synchronous throw from startRun() itself can
  // never leave a stale argv registered here.
  start(argv: string, run: StoppableRun): void
  // The device-side process exited. Moves 'device' -> 'finishing' and, in the
  // same step, reads + clears discardActive - so nothing observed after this
  // point (including a Stop click that lands during the ensuing pull/ingest)
  // can change what THIS run does, or leak into the next one.
  markExited(): { wasDiscarded: boolean }
  // Requests a stop. Only meaningful in the 'device' phase: returns the run
  // handle to call .stop() on and records the discard flag. A no-op (returns
  // undefined, discardActive untouched) in every other phase - most notably
  // 'finishing', where there is no live process left to signal.
  requestStop(discard: boolean): StoppableRun | undefined
  // Always safe to call, always resets every field to its idle default - the
  // one place this run's state is guaranteed to end, so discardActive above
  // all cannot outlive the run that set it.
  finish(): void
}

export function createRunLifecycle(): RunLifecycle {
  let phase: RunPhase = 'idle'
  let run: StoppableRun | null = null
  let argv: string | null = null
  let discardActive = false

  return {
    phase: () => phase,
    argv: () => argv,
    start(a, r) {
      if (phase !== 'idle') throw new Error('a capture is already running')
      argv = a
      run = r
      phase = 'device'
    },
    markExited() {
      const wasDiscarded = discardActive
      discardActive = false
      phase = 'finishing'
      return { wasDiscarded }
    },
    requestStop(discard) {
      if (phase !== 'device') return undefined
      discardActive = discard
      return run ?? undefined
    },
    finish() {
      phase = 'idle'
      run = null
      argv = null
      discardActive = false
    },
  }
}
