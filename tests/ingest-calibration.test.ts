import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadThroughput, saveThroughput } from '../src/main/ingest-calibration'
import { SEED_THROUGHPUT } from '@shared/ingest-estimate'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anubee-cal-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('ingest calibration store', () => {
  it('returns the seed when no file exists', () => {
    expect(loadThroughput(dir)).toBe(SEED_THROUGHPUT)
  })
  it('round-trips a saved value', () => {
    saveThroughput(dir, 123_456)
    expect(loadThroughput(dir)).toBe(123_456)
  })
  it('returns the seed on a corrupt file', () => {
    saveThroughput(dir, 100_000)
    // clobber with junk
    const fs = require('node:fs')
    fs.writeFileSync(join(dir, 'ingest-calibration.json'), '{not json')
    expect(loadThroughput(dir)).toBe(SEED_THROUGHPUT)
  })
})
