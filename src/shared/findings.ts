import { targetLabel, type Tag } from './project-store'
import type { SyscallEvent } from './events'

// A finding = a confirmed tag joined to context from a representative event:
// the calling Java method, the syscall it reaches, and the path/arg it hits.
export interface Finding {
  target: string
  offset?: string
  category: string
  javaCaller: string | null
  syscall: string | null
  hitPath: string | null
  occurrences: number
  note?: string
}

// The most relevant path an event "hits": a suspicious string_arg, else a
// resolved fd path, else null. First value wins (openat/access have one path).
function hitPathOf(e: SyscallEvent): string | null {
  const s = Object.values(e.string_args)[0]
  if (s) return s
  const fd = Object.values(e.fd_args)[0]
  return fd ?? null
}

export function buildFindings(tags: Tag[], reps: Record<string, SyscallEvent[]>): Finding[] {
  return tags.map(t => {
    const events = reps[t.target] ?? []
    const rep = events[0]
    const f: Finding = {
      target: t.target,
      category: t.category,
      javaCaller: rep?.java_stack?.[0] ?? null,
      syscall: rep?.syscall ?? null,
      hitPath: rep ? hitPathOf(rep) : null,
      occurrences: events.length,
    }
    if (t.offset) f.offset = t.offset
    if (t.note) f.note = t.note
    return f
  })
}

// Human-readable block label: the tag target minus its "nat:"/"java:"/"sys:"
// prefix, plus an offset refinement when present. The offset is module-relative
// and bare ("0x88c", or "[unmapped]" when the call site could not be resolved),
// so it never names its library or symbol on its own - the target has to carry
// them or the exported report loses them. A synthetic rasp: target has no such
// prefix and never carries an offset (it has no call site), so it goes through
// targetLabel instead and renders as prose.
function blockLabel(f: Finding): string {
  const target = targetLabel(f.target).replace(/^(nat:|java:|sys:|edge:)/, '')
  return f.offset ? `${target} + ${f.offset}` : target
}

export function renderMarkdown(findings: Finding[]): string {
  if (findings.length === 0) return '# Anubee findings\n\nNo findings.\n'
  const lines = ['# Anubee findings', '']
  for (const f of findings) {
    const caller = f.javaCaller ? `, called from \`${f.javaCaller}\`` : ''
    const hit = f.syscall && f.hitPath ? `, hits \`${f.syscall}(${f.hitPath})\`` : ''
    const note = f.note ? ` - ${f.note}` : ''
    lines.push(`- \`${blockLabel(f)}\` = ${f.category} check${caller}${hit} (${f.occurrences}x)${note}`)
  }
  lines.push('')
  return lines.join('\n')
}

export function renderJSON(findings: Finding[]): string {
  return JSON.stringify(findings, null, 2)
}
