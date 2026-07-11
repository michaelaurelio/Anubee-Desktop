// A monotonic selection epoch. Every user selection action (row click, node
// tap, canvas-clear) bumps it; an async continuation captures the token at
// dispatch and checks isCurrent before painting shared DOM, so a slow IPC
// round-trip for a superseded selection is discarded instead of repainting a
// stale target.
export function makeEpoch(): { bump: () => number; isCurrent: (t: number) => boolean } {
  let cur = 0
  return {
    bump: () => ++cur,
    isCurrent: (t: number) => t === cur,
  }
}
