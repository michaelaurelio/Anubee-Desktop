import type { TraceEvent, SyscallEvent, FuncEvent } from './events'

export interface ParseError {
  line: number
  raw: string
  message: string
}

export interface ParseResult {
  events: TraceEvent[]
  errors: ParseError[]
}

export function isSyscall(e: TraceEvent): e is SyscallEvent {
  return e.type === 'syscall'
}

export function isCall(e: TraceEvent): e is FuncEvent {
  return e.type === 'call'
}

// Parse one JSONL line. Never throws: a malformed line or an object without a
// string `type` discriminator becomes a ParseError. Drops/truncation are
// expected in Anubee output, so the caller keeps going.
export function parseLine(raw: string, line: number): { event?: TraceEvent; error?: ParseError } {
  const trimmed = raw.trim()
  if (trimmed === '') return {}
  try {
    const obj = JSON.parse(trimmed)
    if (obj && typeof obj.type === 'string') return { event: obj as TraceEvent }
    return { error: { line, raw, message: 'missing string "type"' } }
  } catch (err) {
    return { error: { line, raw, message: (err as Error).message } }
  }
}

// Whole-text helper for tests and fixtures. Production ingest reads the file
// through DuckDB's read_json (Task 6), not this.
export function parseJsonl(text: string): ParseResult {
  const events: TraceEvent[] = []
  const errors: ParseError[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const { event, error } = parseLine(lines[i], i + 1)
    if (event) events.push(event)
    else if (error) errors.push(error)
  }
  return { events, errors }
}
