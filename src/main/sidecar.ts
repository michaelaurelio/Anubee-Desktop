import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { parseSidecar, serializeSidecar, type Tag } from '@shared/project-store'

// The tag sidecar sits alongside the loaded run: <run>.ares-desktop.json.
export function sidecarPath(runFile: string): string {
  return `${runFile}.ares-desktop.json`
}

// Missing sidecar is normal (a run with no tags yet) - empty, no error.
export function loadTags(runFile: string): { tags: Tag[]; errors: string[] } {
  const p = sidecarPath(runFile)
  if (!existsSync(p)) return { tags: [], errors: [] }
  return parseSidecar(readFileSync(p, 'utf-8'))
}

export function saveTags(runFile: string, ingestedAt: string, tags: Tag[]): void {
  const text = serializeSidecar({ file: runFile, ingestedAt }, tags)
  writeFileSync(sidecarPath(runFile), text)
}
