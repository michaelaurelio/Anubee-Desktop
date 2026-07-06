import type { SyscallEvent } from './events'
import type { RaspCategory } from './project-store'
import { chainOf } from './graph-shape'

// Rules over syscall events -> suggested RASP tags. Never auto-applied; the
// analyst confirms each. Grounded in real ARES output (see the Phase-2 spec):
// ptrace's request is NOT decoded to a name - it is raw args[0], and
// PTRACE_TRACEME === 0. Path checks read string_args (openat/access path) and
// fd_args (resolved fd path). Kept pure so the rules are unit-testable; the
// SQL pre-filter in graph-store uses INTERESTING_SYSCALLS/SUSPICIOUS_PATHS so
// the WHERE and the predicate cannot drift.

export interface Suggestion {
  target: string
  category: RaspCategory
  confidence: number
  rationale: string
  occurrences: number
}

export const INTERESTING_SYSCALLS = ['ptrace', 'openat', 'access', 'newfstatat', 'faccessat', 'read']

// su / magisk / known root paths. Case-insensitive.
export const SUSPICIOUS_PATHS = /(^|\/)su$|magisk|\/system\/xbin|\/sbin(\/|$)/i

// Parse a raw syscall arg ("0x0", "0", 16) to a number, or NaN.
function argNum(v: string | undefined): number {
  if (v === undefined) return NaN
  return v.startsWith('0x') || v.startsWith('0X') ? parseInt(v, 16) : Number(v)
}

// The native node id closest to the syscall (backtrace[0], innermost), or the
// syscall node when there is no resolvable native frame. Reuses chainOf so the
// id grammar matches the graph exactly.
function nativeTargetOf(e: SyscallEvent): string {
  const chain = chainOf(e)
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].kind === 'native') return chain[i].id
  }
  return `sys:${e.syscall}`
}

export function candidateWhere(): string {
  const list = INTERESTING_SYSCALLS.map(s => `'${s}'`).join(', ')
  return `syscall IN (${list})`
}

export function score(e: SyscallEvent): Suggestion[] {
  const out: Suggestion[] = []

  if (e.syscall === 'ptrace' && argNum(e.args[0]) === 0) {
    out.push({ target: `sys:ptrace`, category: 'debugger', confidence: 0.9,
      rationale: 'ptrace(PTRACE_TRACEME) - classic anti-debug self-attach', occurrences: 1 })
  }

  if (['openat', 'access', 'newfstatat', 'faccessat'].includes(e.syscall)) {
    const hit = Object.values(e.string_args).find(v => SUSPICIOUS_PATHS.test(v))
    if (hit) {
      out.push({ target: nativeTargetOf(e), category: 'root', confidence: 0.85,
        rationale: `${e.syscall} on root-indicator path ${hit}`, occurrences: 1 })
    }
  }

  if (e.syscall === 'read') {
    const status = Object.values(e.fd_args).find(v => v === '/proc/self/status')
    if (status) {
      out.push({ target: `sys:read`, category: 'debugger', confidence: 0.6,
        rationale: 'read of /proc/self/status - likely TracerPid debugger check', occurrences: 1 })
    }
  }

  return out
}

export function aggregate(suggestions: Suggestion[]): Suggestion[] {
  const byTarget = new Map<string, Suggestion>()
  for (const s of suggestions) {
    const cur = byTarget.get(s.target)
    if (!cur) {
      byTarget.set(s.target, { ...s })
    } else {
      cur.occurrences += s.occurrences
      if (s.confidence > cur.confidence) {
        cur.confidence = s.confidence
        cur.category = s.category
      }
      if (!cur.rationale.includes(s.rationale)) cur.rationale += `; ${s.rationale}`
    }
  }
  return [...byTarget.values()]
}
