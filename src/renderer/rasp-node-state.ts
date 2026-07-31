// Fold heuristic suggestions + confirmed tags into a per-node RASP category+state
// for graph coloring. Suggestions target the attributed node (attributionOf); a
// confirmed tag on the same node wins. See spec Phase 1b s3.3.
import type { Suggestion } from '@shared/rasp-heuristics'
import type { Tag, RaspCategory } from '@shared/project-store'

export type RaspState = 'suggested' | 'confirmed'
export interface NodeRasp { category: RaspCategory; state: RaspState }

export function raspNodeStates(suggestions: Suggestion[], tags: Tag[]): Map<string, NodeRasp> {
  const m = new Map<string, NodeRasp>()
  const best = new Map<string, number>()
  for (const s of suggestions) {
    // A synthetic target has no graph node; seeding it would be dead weight in a
    // map the graph reads on every repaint.
    if (s.target.startsWith('rasp:')) continue
    if ((best.get(s.target) ?? -1) >= s.confidence) continue
    best.set(s.target, s.confidence)
    m.set(s.target, { category: s.category, state: 'suggested' })
  }
  for (const t of tags) m.set(t.target, { category: t.category, state: 'confirmed' })
  return m
}
