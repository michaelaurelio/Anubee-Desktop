// Predictability engine for the ingest progress bar. Pure + Electron-free so it
// unit-tests in the node vitest env. Time-to-load tracks file bytes; throughput
// (bytes/ms) is noisy (~7x cold-vs-warm), so we never show a number - only a
// proportional, self-calibrating, asymptotic bar. See the loading-feedback spec.

export const SEED_THROUGHPUT = 80_000  // bytes/ms - median of the 137MB-run benchmark
export const MIN_THROUGHPUT = 10_000   // bytes/ms - floor, stops one cold load poisoning the EWMA
export const MAX_THROUGHPUT = 1_000_000 // bytes/ms - ceiling

const ALPHA = 0.4 // EWMA weight on the newest sample: responsive but not jumpy

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// Fold one completed load into the running throughput estimate. A non-positive
// actualMs (impossible timing) is ignored so it can't divide-by-zero or poison.
export function updateThroughput(prev: number, fileBytes: number, actualMs: number): number {
  if (actualMs <= 0 || fileBytes <= 0) return prev
  const sample = fileBytes / actualMs
  const next = (1 - ALPHA) * prev + ALPHA * sample
  return clamp(next, MIN_THROUGHPUT, MAX_THROUGHPUT)
}

// Predicted total load time in ms. Guard a zero-byte file so the estimate stays
// positive (the curve divides by estMs/3).
export function estimateMs(fileBytes: number, throughput: number): number {
  return Math.max(1, fileBytes) / throughput
}

// Asymptotic fill: approaches 0.9 over the estimate, never reaches it. An
// underestimate decelerates instead of stalling at 100%; the real completion
// event snaps the remaining 10%. Pure function of elapsed time - the renderer
// samples it per animation frame and writes the bar width. No number is shown.
export function shownFraction(elapsedMs: number, estMs: number): number {
  if (elapsedMs <= 0) return 0
  const tau = estMs / 3
  return 0.9 * (1 - Math.exp(-elapsedMs / tau))
}
