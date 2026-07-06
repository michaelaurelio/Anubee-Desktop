// The tag sidecar model. Pure and fs-free: main reads/writes the file, this
// module only parses, validates, serialises, and edits the in-memory tag list.
// A tag's identity is (target, offset) - the graph node id plus an optional
// block refinement. Node/edge id grammar comes from graph-shape.

export type RaspCategory = 'root' | 'debugger' | 'emulator' | 'integrity' | 'hook' | 'custom'

export interface Tag {
  target: string // "nat:<mod>!<sym>" | "java:<method>" | "sys:<name>" | "edge:<src>=><target>"
  offset?: string // optional block refinement, e.g. "libexample.so+0x1234"
  category: RaspCategory
  note?: string
  source: 'manual' | 'heuristic'
  confidence?: number // heuristic-sourced only
  rationale?: string // heuristic-sourced only
  createdAt: string // ISO
}

export interface Sidecar {
  schemaVersion: 1
  run: { file: string; ingestedAt: string }
  tags: Tag[]
}

const CATEGORIES: RaspCategory[] = ['root', 'debugger', 'emulator', 'integrity', 'hook', 'custom']

// Validate one entry into a Tag, or return null (caller records the error).
function coerceTag(v: unknown): Tag | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.target !== 'string') return null
  if (typeof o.category !== 'string' || !CATEGORIES.includes(o.category as RaspCategory)) return null
  if (o.source !== 'manual' && o.source !== 'heuristic') return null
  if (typeof o.createdAt !== 'string') return null
  const t: Tag = {
    target: o.target, category: o.category as RaspCategory, source: o.source, createdAt: o.createdAt,
  }
  if (typeof o.offset === 'string') t.offset = o.offset
  if (typeof o.note === 'string') t.note = o.note
  if (typeof o.confidence === 'number') t.confidence = o.confidence
  if (typeof o.rationale === 'string') t.rationale = o.rationale
  return t
}

export function parseSidecar(text: string): { tags: Tag[]; errors: string[] } {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (e) {
    return { tags: [], errors: [`invalid JSON: ${(e as Error).message}`] }
  }
  const raw = (root as { tags?: unknown }).tags
  if (!Array.isArray(raw)) return { tags: [], errors: ['sidecar has no tags array'] }
  const tags: Tag[] = []
  const errors: string[] = []
  raw.forEach((entry, i) => {
    const t = coerceTag(entry)
    if (t) tags.push(t)
    else errors.push(`tag[${i}] is malformed`)
  })
  return { tags, errors }
}

export function serializeSidecar(run: { file: string; ingestedAt: string }, tags: Tag[]): string {
  const sidecar: Sidecar = { schemaVersion: 1, run, tags }
  return JSON.stringify(sidecar, null, 2)
}

function sameIdentity(a: Tag, target: string, offset?: string): boolean {
  return a.target === target && (a.offset ?? undefined) === (offset ?? undefined)
}

export function upsertTag(tags: Tag[], tag: Tag): Tag[] {
  const rest = tags.filter(t => !sameIdentity(t, tag.target, tag.offset))
  return [...rest, tag]
}

export function removeTag(tags: Tag[], target: string, offset?: string): Tag[] {
  return tags.filter(t => !sameIdentity(t, target, offset))
}

export function tagsByTarget(tags: Tag[], target: string): Tag[] {
  return tags.filter(t => t.target === target)
}

// Tags whose target no longer matches any node/edge in the active run - the
// caller supplies the orphaned-target set (computed against the live run).
export function orphanedTags(tags: Tag[], orphanTargets: Set<string>): Tag[] {
  return tags.filter(t => orphanTargets.has(t.target))
}
