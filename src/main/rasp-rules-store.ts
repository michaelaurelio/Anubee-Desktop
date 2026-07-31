// Persisted global heuristic-rule library, under Electron userData so real paths
// never touch the repo. Mirrors tracer-config.ts. Tolerant load: any parse/shape
// failure yields an empty library rather than throwing.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { coerceRules, coerceOverrides, type RuleScope } from '@shared/rasp-heuristics'

const FILE = 'rasp-rules.json'
const SCHEMA_VERSION = 3
const READABLE = new Set([1, 2, 3]) // v1 stored a single `match`; v2 lacked mode/minOccurrences. validateRule upgrades both.

export function loadRules(dir: string): RuleScope {
  const p = join(dir, FILE)
  if (!existsSync(p)) return { rules: [], enabledOverrides: {} }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (!READABLE.has(j.schemaVersion)) return { rules: [], enabledOverrides: {} }
    const { rules } = coerceRules(Array.isArray(j.rules) ? j.rules : [], 'global')
    return { rules, enabledOverrides: coerceOverrides(j.enabledOverrides) }
  } catch {
    return { rules: [], enabledOverrides: {} }
  }
}

export function saveRules(dir: string, scope: RuleScope): void {
  const body = { schemaVersion: SCHEMA_VERSION, rules: scope.rules, enabledOverrides: scope.enabledOverrides }
  writeFileSync(join(dir, FILE), JSON.stringify(body, null, 2))
}
