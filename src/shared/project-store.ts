// The tag sidecar model. Pure and fs-free: main reads/writes the file, this
// module only parses, validates, serialises, and edits the in-memory tag list.
// A tag's identity is (target, offset, category) - the graph node id, an
// optional block refinement, and the RASP behaviour it implements. Node/edge
// id grammar comes from graph-shape.

import { coerceRules, type Rule, type Suggestion, type OffsetHit } from './rasp-heuristics'

export type RaspCategory = 'root' | 'debugger' | 'emulator' | 'integrity' | 'hook' | 'custom'

export interface Tag {
  target: string // "nat:<mod>!<sym>" | "java:<method>" | "sys:<name>" | "edge:<src>=><target>"
  // Optional block refinement: a bare module-relative offset, e.g. "0x1234", or
  // "[unmapped]" when the call site could not be resolved. Bare (not module-
  // qualified) so a heuristic tag and one authored from the node inspector's
  // offset popup share the same identity for the same call site.
  offset?: string
  category: RaspCategory
  note?: string
  source: 'manual' | 'heuristic'
  confidence?: number // heuristic-sourced only
  rationale?: string // heuristic-sourced only
  createdAt: string // ISO
}

// A rejected heuristic suggestion. Identity is (target, category, offset), where an
// absent offset is row-level and suppresses every call site. The field is optional
// so sidecars written before call-site rejection existed read as row-level.
export interface Dismissed {
  target: string
  category: RaspCategory
  offset?: string
}

export interface Sidecar {
  schemaVersion: 1 | 2
  run: { file: string; ingestedAt: string }
  tags: Tag[]
  rules?: Rule[]
  enabledOverrides?: Record<string, boolean>
  dismissed?: Dismissed[]
}

export const CATEGORIES: RaspCategory[] = ['root', 'debugger', 'emulator', 'integrity', 'hook', 'custom']

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

function coerceOverrides(v: unknown): Record<string, boolean> {
  if (typeof v !== 'object' || v === null) return {}
  const out: Record<string, boolean> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'boolean') out[k] = val
  }
  return out
}

function coerceDismissed(v: unknown): Dismissed[] {
  if (!Array.isArray(v)) return []
  const out: Dismissed[] = []
  for (const e of v) {
    if (typeof e !== 'object' || e === null) continue
    const o = e as Record<string, unknown>
    if (typeof o.target === 'string' && typeof o.category === 'string' && CATEGORIES.includes(o.category as RaspCategory)) {
      const entry: Dismissed = { target: o.target, category: o.category as RaspCategory }
      if (typeof o.offset === 'string') entry.offset = o.offset
      out.push(entry)
    }
  }
  return out
}

export function parseSidecar(text: string): { tags: Tag[]; rules: Rule[]; enabledOverrides: Record<string, boolean>; dismissed: Dismissed[]; errors: string[] } {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (e) {
    return { tags: [], rules: [], enabledOverrides: {}, dismissed: [], errors: [`invalid JSON: ${(e as Error).message}`] }
  }
  const obj = root as { tags?: unknown; rules?: unknown; enabledOverrides?: unknown; dismissed?: unknown }
  const errors: string[] = []
  const tags: Tag[] = []
  if (!Array.isArray(obj.tags)) {
    errors.push('sidecar has no tags array')
  } else {
    obj.tags.forEach((entry, i) => {
      const t = coerceTag(entry)
      if (t) tags.push(t)
      else errors.push(`tag[${i}] is malformed`)
    })
  }
  const ruleArr = Array.isArray(obj.rules) ? obj.rules : []
  const { rules, errors: ruleErrors } = coerceRules(ruleArr, 'project')
  errors.push(...ruleErrors)
  return { tags, rules, enabledOverrides: coerceOverrides(obj.enabledOverrides), dismissed: coerceDismissed(obj.dismissed), errors }
}

export function serializeSidecar(
  run: { file: string; ingestedAt: string },
  tags: Tag[],
  rules: Rule[] = [],
  enabledOverrides: Record<string, boolean> = {},
  dismissed: Dismissed[] = [],
): string {
  const sidecar: Sidecar = { schemaVersion: 2, run, tags, rules, enabledOverrides, dismissed }
  return JSON.stringify(sidecar, null, 2)
}

export function isDismissed(list: Dismissed[], target: string, category: RaspCategory, offset?: string): boolean {
  return list.some(d =>
    d.target === target && d.category === category &&
    (d.offset === undefined || d.offset === offset))
}

export function addDismissed(
  list: Dismissed[], target: string, category: RaspCategory, offset?: string,
): Dismissed[] {
  if (list.some(d => d.target === target && d.category === category && d.offset === offset)) return list
  const entry: Dismissed = { target, category }
  if (offset !== undefined) entry.offset = offset
  return [...list, entry]
}

// A tag's identity is (target, offset, category): one node can implement several
// RASP behaviours, and one symbol can implement different behaviours at different
// call sites, so neither alone is enough to key on.
function sameIdentity(a: Tag, target: string, offset: string | undefined, category: RaspCategory): boolean {
  return a.target === target && (a.offset ?? undefined) === (offset ?? undefined) && a.category === category
}

export function upsertTag(tags: Tag[], tag: Tag): Tag[] {
  const rest = tags.filter(t => !sameIdentity(t, tag.target, tag.offset, tag.category))
  return [...rest, tag]
}

export function removeTag(tags: Tag[], target: string, offset: string | undefined, category: RaspCategory): Tag[] {
  return tags.filter(t => !sameIdentity(t, target, offset, category))
}

export function tagsByTarget(tags: Tag[], target: string): Tag[] {
  return tags.filter(t => t.target === target)
}

// Tags whose target no longer matches any node/edge in the active run - the
// caller supplies the orphaned-target set (computed against the live run).
export function orphanedTags(tags: Tag[], orphanTargets: Set<string>): Tag[] {
  return tags.filter(t => orphanTargets.has(t.target))
}

// The Suggestions popup's read-path filter. A row drops off the list once it
// is actioned at the symbol level: a symbol-level tag (no offset) exists, or
// the row itself was dismissed (isDismissed with no offset - row-level).
// Each surviving row's offsets are then pruned to the still-open call sites: an
// offset drops once it is confirmed to a tag carrying that exact offset, or is
// individually dismissed. A row whose every offset was pruned this way drops
// too: every hit contributes one occurrence to exactly one offset bucket, so a
// row whose call sites have all been actioned is by construction fully actioned.
// Leaving it would show an open, childless row with live buttons whose Confirm
// mints a second, symbol-level tag for a target and category already decided.
export function openSuggestions(all: Suggestion[], tags: Tag[], dismissed: Dismissed[]): Suggestion[] {
  return all
    .filter(s =>
      !isDismissed(dismissed, s.target, s.category) &&
      !tags.some(t => t.target === s.target && t.category === s.category && t.offset === undefined))
    .flatMap(s => {
      const offsets = s.offsets.filter((o: OffsetHit) =>
        !tags.some(t => t.target === s.target && t.category === s.category && t.offset === o.offset) &&
        !isDismissed(dismissed, s.target, s.category, o.offset))
      if (offsets.length === 0 && s.offsets.length > 0) return []
      return [{ ...s, offsets }]
    })
}
