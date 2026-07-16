// A debounce that accumulates items and flushes the batch after `delayMs` of
// quiet. Pure: the clock is injected (default setTimeout) so tests drive it with
// a fake. Used to coalesce a library-map burst into one dump --now --check pass.
export interface Batcher<T> {
  add(item: T): void
  flushNow(): void
  cancel(): void
}

export function makeBatcher<T>(
  delayMs: number,
  flush: (items: T[]) => void,
  schedule: (fn: () => void, ms: number) => () => void =
    (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
): Batcher<T> {
  let queue: T[] = []
  let cancelTimer: (() => void) | null = null

  const clearTimer = (): void => { if (cancelTimer) { cancelTimer(); cancelTimer = null } }
  const fire = (): void => {
    clearTimer()
    if (queue.length === 0) return
    const items = [...new Set(queue)]; queue = []
    flush(items)
  }
  return {
    add(item) { queue.push(item); clearTimer(); cancelTimer = schedule(fire, delayMs) },
    flushNow() { fire() },
    cancel() { clearTimer(); queue = [] },
  }
}
