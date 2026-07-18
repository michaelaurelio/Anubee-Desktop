// Persisted host-side tracer config (paths to the pre-built anubee binary + specs
// dir). Stored under Electron userData so real paths never touch the repo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TracerConfig } from './tracer-control'

const FILE = 'tracer-config.json'

export function loadConfig(dir: string): TracerConfig {
  const p = join(dir, FILE)
  if (!existsSync(p)) return { anubeeBinary: '', specsDir: '' }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return { anubeeBinary: String(j.anubeeBinary ?? ''), specsDir: String(j.specsDir ?? '') }
  } catch {
    return { anubeeBinary: '', specsDir: '' }
  }
}

export function saveConfig(dir: string, cfg: TracerConfig): void {
  writeFileSync(join(dir, FILE), JSON.stringify(cfg, null, 2))
}
