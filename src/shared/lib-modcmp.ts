// Pure parser for anubee dump --check's {"type":"modcmp",...} records (Phase 1
// emitter: ../Anubee/src/dump/dump_emit.h). Shared by the main-process check path
// and the renderer's tag logic; no Electron, no fs.
import type { ModcmpState, Modcmp } from './native-lib'

const STATES: readonly ModcmpState[] = ['match', 'differ', 'nofile', 'apk', 'unreadable']

// One JSONL line -> a Modcmp, or null for anything that is not a well-formed
// modcmp record (a dump record on the same channel, an unknown state, a
// truncated device write). Never throws.
export function parseModcmpLine(line: string): Modcmp | null {
  const t = line.trim()
  if (!t) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(t) as Record<string, unknown> } catch { return null }
  if (o.type !== 'modcmp') return null
  const state = o.state
  if (typeof state !== 'string' || !STATES.includes(state as ModcmpState)) return null
  if (typeof o.module !== 'string' || typeof o.path !== 'string' ||
      typeof o.base !== 'string' || typeof o.pid !== 'number') return null
  const digest = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  return {
    module: o.module, path: o.path, base: o.base, pid: o.pid,
    state: state as ModcmpState,
    memSha256: digest(o.mem_sha256), fileSha256: digest(o.file_sha256),
  }
}

export function parseModcmpJsonl(text: string): Modcmp[] {
  const out: Modcmp[] = []
  for (const line of text.split('\n')) {
    const r = parseModcmpLine(line)
    if (r) out.push(r)
  }
  return out
}
