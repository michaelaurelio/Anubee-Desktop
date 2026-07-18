import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { parseSidecar, serializeSidecar, type Tag, type Dismissed } from '@shared/project-store'
import type { RuleScope, Rule } from '@shared/rasp-heuristics'

// The tag sidecar sits alongside the loaded run: <run>.anubee-desktop.json.
// Writes always target the current extension; reads fall back to the pre-rename
// `.ares-desktop.json` so sidecars authored (or shared) before the Anubee rename
// keep loading and migrate forward on the next save.
const SIDECAR_EXT = '.anubee-desktop.json'
const LEGACY_SIDECAR_EXT = '.ares-desktop.json'

export function sidecarPath(runFile: string): string {
  return `${runFile}${SIDECAR_EXT}`
}

// The sidecar to read from: the current one if present, else a legacy
// `.ares-desktop.json`, else the current path (which loaders treat as absent).
function readableSidecarPath(runFile: string): string {
  const current = sidecarPath(runFile)
  if (existsSync(current)) return current
  const legacy = `${runFile}${LEGACY_SIDECAR_EXT}`
  return existsSync(legacy) ? legacy : current
}

// Missing sidecar is normal (a run with no tags yet) - empty, no error.
export function loadTags(runFile: string): { tags: Tag[]; errors: string[] } {
  const p = readableSidecarPath(runFile)
  if (!existsSync(p)) return { tags: [], errors: [] }
  const { tags, errors } = parseSidecar(readFileSync(p, 'utf-8'))
  return { tags, errors }
}

// The project-scope rule override for this run (empty when absent).
export function loadSidecarRules(runFile: string): RuleScope {
  const p = readableSidecarPath(runFile)
  if (!existsSync(p)) return { rules: [], enabledOverrides: {} }
  const { rules, enabledOverrides } = parseSidecar(readFileSync(p, 'utf-8'))
  return { rules, enabledOverrides }
}

// The rejected-suggestion list for this run (empty when absent).
export function loadDismissed(runFile: string): Dismissed[] {
  const p = readableSidecarPath(runFile)
  if (!existsSync(p)) return []
  return parseSidecar(readFileSync(p, 'utf-8')).dismissed
}

// Writing tags must not drop authored project rules or dismissals: carry them.
export function saveTags(runFile: string, ingestedAt: string, tags: Tag[]): void {
  const existing = loadSidecarRules(runFile)
  const text = serializeSidecar({ file: runFile, ingestedAt }, tags, existing.rules, existing.enabledOverrides, loadDismissed(runFile))
  writeFileSync(sidecarPath(runFile), text)
}

// Persist the rejected-suggestion list, carrying tags + rules.
export function saveDismissed(runFile: string, ingestedAt: string, dismissed: Dismissed[]): void {
  const tags = loadTags(runFile).tags
  const rules = loadSidecarRules(runFile)
  const text = serializeSidecar({ file: runFile, ingestedAt }, tags, rules.rules, rules.enabledOverrides, dismissed)
  writeFileSync(sidecarPath(runFile), text)
}

// Writing project rules must not drop authored tags: re-read and carry them.
export function saveSidecarRules(
  runFile: string,
  ingestedAt: string,
  rules: Rule[],
  enabledOverrides: Record<string, boolean>,
): void {
  const existingTags = loadTags(runFile).tags
  const text = serializeSidecar({ file: runFile, ingestedAt }, existingTags, rules, enabledOverrides, loadDismissed(runFile))
  writeFileSync(sidecarPath(runFile), text)
}
