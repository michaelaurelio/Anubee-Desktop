import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { parseSidecar, serializeSidecar, type Tag } from '@shared/project-store'
import type { RuleScope } from '@shared/rasp-heuristics'

// The tag sidecar sits alongside the loaded run: <run>.ares-desktop.json.
export function sidecarPath(runFile: string): string {
  return `${runFile}.ares-desktop.json`
}

// Missing sidecar is normal (a run with no tags yet) - empty, no error.
export function loadTags(runFile: string): { tags: Tag[]; errors: string[] } {
  const p = sidecarPath(runFile)
  if (!existsSync(p)) return { tags: [], errors: [] }
  const { tags, errors } = parseSidecar(readFileSync(p, 'utf-8'))
  return { tags, errors }
}

// The project-scope rule override for this run (empty when absent).
export function loadSidecarRules(runFile: string): RuleScope {
  const p = sidecarPath(runFile)
  if (!existsSync(p)) return { rules: [], enabledOverrides: {} }
  const { rules, enabledOverrides } = parseSidecar(readFileSync(p, 'utf-8'))
  return { rules, enabledOverrides }
}

// Writing tags must not drop authored project rules: re-read and carry them.
export function saveTags(runFile: string, ingestedAt: string, tags: Tag[]): void {
  const existing = loadSidecarRules(runFile)
  const text = serializeSidecar({ file: runFile, ingestedAt }, tags, existing.rules, existing.enabledOverrides)
  writeFileSync(sidecarPath(runFile), text)
}
