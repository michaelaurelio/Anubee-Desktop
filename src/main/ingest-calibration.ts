// Persisted ingest throughput (bytes/ms) for the progress estimator. Stored under
// Electron userData so it calibrates to the user's machine across restarts and
// never touches the repo. Mirrors tracer-config.ts.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SEED_THROUGHPUT } from '@shared/ingest-estimate'

const FILE = 'ingest-calibration.json'

export function loadThroughput(dir: string): number {
  const p = join(dir, FILE)
  if (!existsSync(p)) return SEED_THROUGHPUT
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const v = Number(j.throughputBytesPerMs)
    return Number.isFinite(v) && v > 0 ? v : SEED_THROUGHPUT
  } catch {
    return SEED_THROUGHPUT
  }
}

export function saveThroughput(dir: string, throughput: number): void {
  writeFileSync(join(dir, FILE), JSON.stringify({ throughputBytesPerMs: throughput }, null, 2))
}
