// The renderer's single in-memory activity log. Pure (no DOM): action sites
// append entries, the log modal renders + subscribes, the file save serializes.
export type LogLevel = 'info' | 'success' | 'warn' | 'error'
export interface LogEntry { ts: number; level: LogLevel; label: string; message: string }

export const LOG_CAP = 5000

const buffer: LogEntry[] = []
const subscribers = new Set<(e: LogEntry) => void>()

export function logAppend(level: LogLevel, label: string, message: string): LogEntry {
  const entry: LogEntry = { ts: Date.now(), level, label, message }
  buffer.push(entry)
  if (buffer.length > LOG_CAP) buffer.shift()
  for (const fn of subscribers) fn(entry)
  return entry
}

export function logGetAll(): LogEntry[] {
  return buffer.slice()
}

export function logClear(): void {
  buffer.length = 0
  for (const fn of subscribers) fn({ ts: Date.now(), level: 'info', label: '', message: '' })
}

export function logSubscribe(fn: (e: LogEntry) => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

// Full-timestamp plain-text dump for the file save. One line per entry.
export function formatLog(entries: LogEntry[]): string {
  return entries.map(e => {
    const d = new Date(e.ts)
    const iso = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
      `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
    return `${iso}  [${e.level.toUpperCase()}]  ${e.label}: ${e.message}`
  }).join('\n')
}

function p2(n: number): string {
  return String(n).padStart(2, '0')
}
