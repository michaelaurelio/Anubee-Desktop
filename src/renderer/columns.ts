// The master-table column catalogue and the persisted-visibility helpers.
// Pure (no DOM): the renderer chooses a subset, table.ts renders it, main.ts
// persists the choice to localStorage. `id` is always present.
export type ColumnKey = 'id' | 'tid' | 'syscall' | 'java' | 'topJava' | 'topNative' | 'arg' | 'tags'

export interface ColumnDef { key: ColumnKey; label: string; fixed?: boolean }

export const ALL_COLUMNS: ColumnDef[] = [
  { key: 'id', label: 'id', fixed: true },
  { key: 'tid', label: 'tid' },
  { key: 'syscall', label: 'syscall' },
  { key: 'java', label: 'java?' },
  { key: 'topJava', label: 'top java' },
  { key: 'topNative', label: 'top native' },
  { key: 'arg', label: 'args' },
  { key: 'tags', label: 'tags' },
]

export const DEFAULT_COLUMNS: ColumnKey[] = ['id', 'syscall', 'topJava', 'topNative', 'arg', 'tags']

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
