// The coverage chip (main.ts, shown once a run is loaded): a one-line health
// summary built from whichever CoverageEvent fields are actually present.
// CoverageEvent has three shapes (see the comment on it in @shared/events) -
// exempt, clean, and degraded with any mix of fields - so this composes
// defensively rather than assuming any one of them.
import type { CoverageEvent } from '@shared/events'

export function coverageChipText(cov: CoverageEvent | undefined): string {
  if (!cov) return ''
  if (cov.exempt) return `coverage: not applicable (${cov.reason ?? 'no coverage surface'})`
  if (cov.clean) return 'coverage: full - no truncation, drops, or blind spots'

  const parts: string[] = []
  if (cov.snaps) parts.push(`${cov.snaps.total} snapshots · ${cov.snaps.truncated} truncated`)
  if (cov.cfi) parts.push(`CFI walks ${cov.cfi.walks}`)
  if (cov.drops) {
    parts.push(cov.drops.queue
      ? `${cov.drops.ring} ring drops, ${cov.drops.queue} queue drops`
      : `${cov.drops.ring} ring drops`)
  }
  if (cov.managed_naming_off) parts.push('Java naming off')
  if (cov.prearm_drops) parts.push(`${cov.prearm_drops} pre-arm drops`)
  if (cov.depth_capped) parts.push(`${cov.depth_capped} depth-capped`)
  if (cov.decode_partial) parts.push('args not decoded')
  if (cov.returns) parts.push(`${cov.returns.captured}/${cov.returns.spans} returns captured`)

  // Neither exempt, clean, nor any degraded signal present (e.g. a run
  // captured without --snapshot and nothing else to report): no chip rather
  // than a misleading "0 snapshots".
  return parts.join(' · ')
}
