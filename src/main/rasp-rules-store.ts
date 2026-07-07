// Persisted global heuristic-rule library, under Electron userData so real paths
// never touch the repo. Mirrors tracer-config.ts. Tolerant load: any parse/shape
// failure yields an empty library rather than throwing.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { coerceRules, type RuleScope } from '@shared/rasp-heuristics'

const FILE = 'rasp-rules.json'

function coerceOverrides(v: unknown): Record<string, boolean> {
  if (typeof v !== 'object' || v === null) return {}
  const out: Record<string, boolean> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'boolean') out[k] = val
  }
  return out
}

export function loadRules(dir: string): RuleScope {
  const p = join(dir, FILE)
  if (!existsSync(p)) return { rules: [], enabledOverrides: {} }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (j.schemaVersion !== 1) return { rules: [], enabledOverrides: {} }
    const { rules } = coerceRules(Array.isArray(j.rules) ? j.rules : [], 'global')
    return { rules, enabledOverrides: coerceOverrides(j.enabledOverrides) }
  } catch {
    return { rules: [], enabledOverrides: {} }
  }
}

export function saveRules(dir: string, scope: RuleScope): void {
  const body = { schemaVersion: 1, rules: scope.rules, enabledOverrides: scope.enabledOverrides }
  writeFileSync(join(dir, FILE), JSON.stringify(body, null, 2))
}
