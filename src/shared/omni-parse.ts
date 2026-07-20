import type { Filter } from './filter'
import { CATEGORIES, type RaspCategory } from './project-store'

// The omni-bar grammar: `key:value` tokens (quoted values allowed) plus free
// text. Keys map onto the shared Filter; parsing never throws - anything that
// is not a well-formed token stays free text.
export type OmniKey =
  | 'syscall' | 'tid' | 'id'
  | 'java.exist' | 'java.method'
  | 'stack.lib' | 'stack.sym'
  | 'fn.lib' | 'fn.sym'
  | 'tag.exist' | 'tag.name'

export interface OmniToken {
  key: OmniKey
  value: string
}

// Autocomplete display order (grouped: identifiers, java.*, stack.*, fn.*, tag.*).
export const OMNI_KEYS: ReadonlyArray<{ key: OmniKey; hint: string }> = [
  { key: 'syscall', hint: 'syscall name substring, e.g. syscall:openat' },
  { key: 'tid', hint: 'exact thread id, e.g. tid:101' },
  { key: 'id', hint: 'record id or range, e.g. id:1500 or id:1500-1600' },
  { key: 'java.exist', hint: 'java.exist:true / java.exist:false - record has a Java stack' },
  { key: 'java.method', hint: 'Java-stack method substring, e.g. java.method:onCreate' },
  { key: 'stack.lib', hint: 'backtrace library substring, e.g. stack.lib:libc' },
  { key: 'stack.sym', hint: 'backtrace symbol substring, e.g. stack.sym:checkRoot' },
  { key: 'fn.lib', hint: 'funcs callee library substring, e.g. fn.lib:libexample' },
  { key: 'fn.sym', hint: 'funcs callee function substring, e.g. fn.sym:checkRoot' },
  { key: 'tag.exist', hint: 'tag.exist:true / tag.exist:false - record reaches a confirmed tag' },
  { key: 'tag.name', hint: 'tagged rule name, e.g. tag.name:root' },
]

const KEYS = new Set<string>(OMNI_KEYS.map(k => k.key))

// Whitespace split that keeps `key:"quoted value"` spans intact. An unmatched
// quote falls through to the plain \S+ alternative and stays free text.
export function splitWords(input: string): string[] {
  return input.match(/[^\s"]*"[^"]*"[^\s"]*|\S+/g) ?? []
}

function idOk(v: string): boolean {
  const m = /^(\d+)(?:-(\d+))?$/.exec(v)
  if (!m) return false
  if (m[2] === undefined) return true
  return Number(m[1]) <= Number(m[2]) // ascending range only
}

// Recognize one completed `key:value` word. Returns null (leave as free text)
// for unknown keys, empty values, or a value that fails its key's validation.
export function matchToken(word: string): OmniToken | null {
  const m = /^([a-z][a-z.]*):(?:"(.*)"|(.+))$/.exec(word)
  if (!m) return null
  const key = m[1]
  if (!KEYS.has(key)) return null
  if (m[3] !== undefined && m[3].startsWith('"')) return null // unterminated quote stays free text
  const value = m[2] ?? m[3] ?? ''
  if (!value) return null
  if (key === 'tid' && !/^\d+$/.test(value)) return null
  if (key === 'id' && !idOk(value)) return null
  if ((key === 'java.exist' || key === 'tag.exist') && value !== 'true' && value !== 'false') return null
  if (key === 'tag.name' && !CATEGORIES.includes(value as RaspCategory)) return null
  return { key: key as OmniKey, value }
}

// Fold chips plus the input's free text into a Filter. A later chip wins on a
// duplicate key (the Filter interface is single-value per field).
export function filterFromParts(chips: OmniToken[], text: string): Filter {
  const f: Filter = {}
  for (const c of chips) {
    switch (c.key) {
      case 'syscall': f.syscall = c.value; break
      case 'tid': f.tid = Number(c.value); break
      case 'id': {
        const [lo, hi] = c.value.split('-')
        f.id = Number(lo)
        if (hi !== undefined) f.idMax = Number(hi)
        break
      }
      case 'java.exist': f.hasJavaStack = c.value === 'true'; break
      case 'java.method': f.javaMethod = c.value; break
      case 'stack.lib': f.library = c.value; break
      case 'stack.sym': f.stackSymbol = c.value; break
      case 'fn.lib': f.module = c.value; break
      case 'fn.sym': f.symbol = c.value; break
      case 'tag.exist': f.tagged = c.value === 'true' ? 'yes' : 'no'; break
      case 'tag.name': f.tagName = c.value as RaspCategory; break
    }
  }
  const t = text.trim()
  if (t) f.text = t
  return f
}
