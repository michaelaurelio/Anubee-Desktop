// The master-table column catalogue and the persisted-visibility helpers.
// Pure (no DOM): the renderer chooses a subset, table.ts renders it, main.ts
// persists the choice to localStorage. `id` is always present.
export type ColumnKey = 'id' | 'tid' | 'syscall' | 'java' | 'topJava' | 'topNative' | 'arg' | 'tags'
  | 'fn' | 'caller' | 'retval' | 'elapsed'

export interface ColumnDef { key: ColumnKey; label: string; fixed?: boolean }

export const ALL_COLUMNS: ColumnDef[] = [
  { key: 'id', label: 'id', fixed: true },
  { key: 'tid', label: 'tid' },
  { key: 'syscall', label: 'syscall' },
  { key: 'java', label: 'java?' },
  { key: 'topJava', label: 'top java' },
  { key: 'topNative', label: 'top native' },
  { key: 'fn', label: 'function' },
  { key: 'caller', label: 'caller' },
  { key: 'retval', label: 'retval' },
  { key: 'elapsed', label: 'elapsed' },
  { key: 'arg', label: 'args' },
  { key: 'tags', label: 'tags' },
]

export const DEFAULT_COLUMNS: ColumnKey[] = ['id', 'syscall', 'topJava', 'topNative', 'arg', 'tags']
export const SYSCALL_COLUMNS: ColumnKey[] = ['id', 'syscall', 'java', 'topJava', 'topNative', 'arg', 'tags']
export const FUNCS_COLUMNS: ColumnKey[] = ['id', 'fn', 'caller', 'retval', 'elapsed', 'arg']

const ENGINE_KEYS: Record<'syscall' | 'func', ColumnKey[]> = { syscall: SYSCALL_COLUMNS, func: FUNCS_COLUMNS }

const VALID = new Set<ColumnKey>(ALL_COLUMNS.map(c => c.key))

export function serializeColumns(keys: ColumnKey[]): string {
  return JSON.stringify(keys)
}

export function parseColumns(raw: string | null): ColumnKey[] {
  if (!raw) return [...DEFAULT_COLUMNS]
  let arr: unknown
  try { arr = JSON.parse(raw) } catch { return [...DEFAULT_COLUMNS] }
  if (!Array.isArray(arr)) return [...DEFAULT_COLUMNS]
  const keys = (arr as unknown[]).filter((k): k is ColumnKey => typeof k === 'string' && VALID.has(k as ColumnKey))
  if (!keys.includes('id')) keys.unshift('id')
  return keys.length ? keys : [...DEFAULT_COLUMNS]
}

// The toggleable column defs for a run's engine, in catalogue order.
export function columnCatalogue(engine: 'syscall' | 'func'): ColumnDef[] {
  const keys = new Set(ENGINE_KEYS[engine])
  return ALL_COLUMNS.filter(c => keys.has(c.key))
}

// The visible columns for a run: the saved set restricted to the engine's own
// keys (foreign/stale keys dropped, `id` forced in), or the engine default when
// nothing valid is saved. `saved` is the raw string from the engine-scoped
// localStorage key (main.ts owns key selection + legacy migration).
export function columnsForEngine(engine: 'syscall' | 'func', saved: string | null): ColumnKey[] {
  const def = engine === 'func' ? FUNCS_COLUMNS : DEFAULT_COLUMNS
  if (!saved) return [...def]
  let arr: unknown
  try { arr = JSON.parse(saved) } catch { return [...def] }
  if (!Array.isArray(arr)) return [...def]
  const valid = new Set(ENGINE_KEYS[engine])
  const keys = (arr as unknown[]).filter((k): k is ColumnKey => typeof k === 'string' && valid.has(k as ColumnKey))
  if (!keys.includes('id')) keys.unshift('id')
  return keys.length ? keys : [...def]
}
