import type { Tag, Dismissed } from './project-store'
import type { Rule } from './rasp-heuristics'

export interface ProjectBundle {
  formatVersion: 1
  savedAt: string
  run: { path: string; engine: 'syscall' | 'func'; eventCount: number }
  tags: Tag[]
  dismissed: Dismissed[]
  ruleOverrides: Rule[]
  layout?: unknown
}

export function serializeProject(b: ProjectBundle): string {
  return JSON.stringify(b, null, 2)
}

export function parseProject(raw: string): { bundle: ProjectBundle | null; error?: string } {
  let o: unknown
  try { o = JSON.parse(raw) } catch { return { bundle: null, error: 'not valid JSON' } }
  if (!o || typeof o !== 'object') return { bundle: null, error: 'not an object' }
  const b = o as Record<string, unknown>
  if (b.formatVersion !== 1) return { bundle: null, error: 'unsupported formatVersion' }
  const run = b.run as Record<string, unknown> | undefined
  if (!run || typeof run.path !== 'string' || !run.path) return { bundle: null, error: 'missing run.path' }
  return { bundle: {
    formatVersion: 1,
    savedAt: typeof b.savedAt === 'string' ? b.savedAt : new Date().toISOString(),
    run: { path: run.path, engine: run.engine === 'func' ? 'func' : 'syscall', eventCount: typeof run.eventCount === 'number' ? run.eventCount : 0 },
    tags: Array.isArray(b.tags) ? (b.tags as Tag[]) : [],
    dismissed: Array.isArray(b.dismissed) ? (b.dismissed as Dismissed[]) : [],
    ruleOverrides: Array.isArray(b.ruleOverrides) ? (b.ruleOverrides as Rule[]) : [],
    layout: b.layout,
  } }
}
