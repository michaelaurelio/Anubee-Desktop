import type { Tag, RaspCategory } from './project-store'
import type { TagTargets } from './filter'

// Split confirmed tags into the per-record-testable target buckets used by the
// tag: filter. sys:/nat:/java: are node targets a single record can reach;
// edge:/fn: targets are out of scope (see BACKLOG) and ignored here.
export function resolveTagTargets(tags: Tag[], category?: RaspCategory): TagTargets {
  const out: TagTargets = { syscalls: [], natFrames: [], javaMethods: [] }
  for (const t of tags) {
    if (category && t.category !== category) continue
    if (t.target.startsWith('sys:')) out.syscalls.push(t.target.slice(4))
    else if (t.target.startsWith('nat:')) out.natFrames.push(t.target.slice(4))
    else if (t.target.startsWith('java:')) out.javaMethods.push(t.target.slice(5))
  }
  return out
}
