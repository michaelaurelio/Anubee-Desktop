import { describe, it, expect } from 'vitest'
import {
  SEED_THROUGHPUT, MIN_THROUGHPUT, MAX_THROUGHPUT,
  updateThroughput, estimateMs, shownFraction,
} from '@shared/ingest-estimate'

describe('estimateMs', () => {
  it('is bytes / throughput', () => {
    expect(estimateMs(80_000_000, 80_000)).toBe(1000)
  })
  it('scales linearly with bytes', () => {
    const a = estimateMs(40_000_000, 80_000)
    const b = estimateMs(80_000_000, 80_000)
    expect(b).toBeCloseTo(a * 2, 5)
  })
  it('never returns a non-positive estimate', () => {
    expect(estimateMs(0, 80_000)).toBeGreaterThan(0)
  })
})

describe('updateThroughput (EWMA, alpha 0.4)', () => {
  it('blends previous and sampled throughput', () => {
    // sample = 100_000 / 1 ... use fileBytes=100_000, actualMs=1 => 100_000 bytes/ms
    const next = updateThroughput(80_000, 100_000, 1)
    expect(next).toBeCloseTo(0.6 * 80_000 + 0.4 * 100_000, 5) // 88_000
  })
  it('converges toward a steady sample over several loads', () => {
    let t = SEED_THROUGHPUT
    for (let i = 0; i < 20; i++) t = updateThroughput(t, 200_000, 1) // sample 200_000
    expect(t).toBeGreaterThan(150_000)
  })
  it('clamps a pathological fast sample to the ceiling', () => {
    expect(updateThroughput(MAX_THROUGHPUT, 9_000_000, 1)).toBe(MAX_THROUGHPUT)
  })
  it('clamps a pathological slow sample to the floor', () => {
    expect(updateThroughput(MIN_THROUGHPUT, 1, 1_000)).toBe(MIN_THROUGHPUT)
  })
  it('ignores a zero/negative actualMs (returns prev unchanged)', () => {
    expect(updateThroughput(80_000, 100_000, 0)).toBe(80_000)
  })
})

describe('shownFraction (asymptotic curve)', () => {
  it('is 0 at elapsed 0', () => {
    expect(shownFraction(0, 1000)).toBe(0)
  })
  it('is monotonic non-decreasing', () => {
    let prev = -1
    for (let t = 0; t <= 5000; t += 100) {
      const v = shownFraction(t, 1000)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
  it('never reaches 0.9 for any finite (realistic) elapsed', () => {
    expect(shownFraction(5_000, 1000)).toBeLessThan(0.9) // 5s >> typical load time
  })
  it('is near 0.9 once elapsed far exceeds the estimate', () => {
    expect(shownFraction(10_000, 1000)).toBeGreaterThan(0.88)
  })
})
