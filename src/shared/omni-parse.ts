import type { Filter } from './filter'

// The omni-bar grammar: `key:value` tokens (quoted values allowed) plus free
// text. Keys map onto the shared Filter; parsing never throws - anything that
// is not a well-formed token stays free text.
export type OmniKey = 'syscall' | 'lib' | 'tid' | 'java' | 'module' | 'symbol'

export interface OmniToken {
  key: OmniKey
  value: string
}

// Autocomplete display order.
export const OMNI_KEYS: ReadonlyArray<{ key: OmniKey; hint: string }> = [
  { key: 'syscall', hint: 'syscall name substring, e.g. syscall:openat' },
  { key: 'lib', hint: 'backtrace library substring, e.g. lib:libc' },
  { key: 'tid', hint: 'exact thread id, e.g. tid:101' },
  { key: 'java', hint: 'java:yes / java:no - event has a java stack' },
  { key: 'module', hint: 'funcs module substring, e.g. module:libexample' },
  { key: 'symbol', hint: 'funcs symbol substring, e.g. symbol:checkRoot' },
]

const KEYS = new Set<string>(OMNI_KEYS.map(k => k.key))

// Whitespace split that keeps `key:"quoted value"` spans intact. An unmatched
// quote falls through to the plain \S+ alternative and stays free text.
export function splitWords(input: string): string[] {
  return input.match(/[^\s"]*"[^"]*"[^\s"]*|\S+/g) ?? []
}

// Recognize one completed `key:value` word. Returns null (leave as free text)
// for unknown keys, empty values, a non-integer tid, or java other than yes/no.
export function matchToken(word: string): OmniToken | null {
  const m = /^([a-z]+):(?:"(.*)"|(.+))$/.exec(word)
  if (!m) return null
  const key = m[1]
  if (!KEYS.has(key)) return null
  const value = m[2] ?? m[3] ?? ''
  if (!value) return null
  if (key === 'tid' && !/^\d+$/.test(value)) return null
  if (key === 'java' && value !== 'yes' && value !== 'no') return null
  return { key: key as OmniKey, value }
}

// Fold chips plus the input's free text into a Filter. A later chip wins on a
// duplicate key (the Filter interface is single-value per field).
export function filterFromParts(chips: OmniToken[], text: string): Filter {
  const f: Filter = {}
  for (const c of chips) {
    if (c.key === 'syscall') f.syscall = c.value
    else if (c.key === 'lib') f.library = c.value
    else if (c.key === 'tid') f.tid = Number(c.value)
    else if (c.key === 'java') f.hasJavaStack = c.value === 'yes'
    else if (c.key === 'module') f.module = c.value
    else f.symbol = c.value
  }
  const t = text.trim()
  if (t) f.text = t
  return f
}
