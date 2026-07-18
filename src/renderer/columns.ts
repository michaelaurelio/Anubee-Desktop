// The master-table column catalogue and the persisted-visibility helpers.
// Pure (no DOM): the renderer chooses a subset, table.ts renders it, main.ts
// persists the choice to localStorage. `id` is always present.
export type ColumnKey = 'id' | 'tid' | 'syscall' | 'java' | 'topJava' | 'topNative' | 'arg' | 'tags'
  | 'fn' | 'caller' | 'retval' | 'elapsed' | 'callSite'

export interface ColumnDef { key: ColumnKey; label: string; fixed?: boolean }

export const ALL_COLUMNS: ColumnDef[] = [
  { key: 'id', label: 'id', fixed: true },
  { key: 'callSite', label: 'call site' },
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
// With mode: returns the columns for a specific call-site mode.
// Without mode: returns the engine's default columns (legacy behavior).
export function columnCatalogue(engine: 'syscall' | 'func', mode?: CallSiteMode): ColumnDef[] {
  const keys = new Set(mode ? engineKeys(engine, mode) : ENGINE_KEYS[engine])
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

// --- New layout model (Task 2): stacked/split call-site mode + persisted widths ---

export type CallSiteMode = 'stacked' | 'split'

// Two roles per engine+mode:
//  - CATALOGUE: the keys the column picker OFFERS, in display order.
//  - DEFAULT-VISIBLE: the subset shown when nothing is persisted.
// They diverge for syscall so tid/retval are offer-able but off by default.
const SYSCALL_STACKED_CAT: ColumnKey[] = ['id', 'tid', 'syscall', 'callSite', 'retval', 'arg', 'tags']
const SYSCALL_SPLIT_CAT: ColumnKey[]   = ['id', 'tid', 'syscall', 'java', 'topJava', 'topNative', 'retval', 'arg', 'tags']
const SYSCALL_STACKED_DEF: ColumnKey[] = ['id', 'syscall', 'callSite', 'arg', 'tags']
const SYSCALL_SPLIT_DEF: ColumnKey[]   = ['id', 'syscall', 'java', 'topJava', 'topNative', 'arg', 'tags']
const FUNCS_STACKED: ColumnKey[] = ['id', 'callSite', 'retval', 'elapsed', 'arg']
const FUNCS_SPLIT: ColumnKey[]   = ['id', 'fn', 'caller', 'retval', 'elapsed', 'arg']

// Offered catalogue (picker list + column order).
function engineKeys(engine: 'syscall' | 'func', mode: CallSiteMode): ColumnKey[] {
  if (engine === 'func') return mode === 'split' ? FUNCS_SPLIT : FUNCS_STACKED
  return mode === 'split' ? SYSCALL_SPLIT_CAT : SYSCALL_STACKED_CAT
}

// Default-visible subset (funcs: identical to its catalogue).
function engineDefaultKeys(engine: 'syscall' | 'func', mode: CallSiteMode): ColumnKey[] {
  if (engine === 'func') return mode === 'split' ? FUNCS_SPLIT : FUNCS_STACKED
  return mode === 'split' ? SYSCALL_SPLIT_DEF : SYSCALL_STACKED_DEF
}

// The default-visible columns for an engine+mode (used for a fresh layout and
// the call-site mode-switch reset). Distinct from engineColumnKeys, which is the
// full offered catalogue.
export function engineDefaultColumns(engine: 'syscall' | 'func', mode: CallSiteMode): ColumnKey[] {
  return [...engineDefaultKeys(engine, mode)]
}

export interface ColumnLayout {
  columns: ColumnKey[]
  widths: Record<string, number> // keyed by ColumnKey, px; absent = auto/flex
  callSite: CallSiteMode
}

function defaultLayout(engine: 'syscall' | 'func'): ColumnLayout {
  return { columns: [...engineDefaultKeys(engine, 'stacked')], widths: {}, callSite: 'stacked' }
}

export function serializeLayout(layout: ColumnLayout): string {
  return JSON.stringify(layout)
}

function coerceColumns(arr: unknown, engine: 'syscall' | 'func', mode: CallSiteMode): ColumnKey[] {
  const valid = new Set(engineKeys(engine, mode))          // catalogue: tid/retval are valid
  const def = engineDefaultKeys(engine, mode)              // fallback: default-visible
  if (!Array.isArray(arr)) return [...def]
  const keys = (arr as unknown[]).filter((k): k is ColumnKey => typeof k === 'string' && valid.has(k as ColumnKey))
  if (!keys.includes('id')) keys.unshift('id')
  return keys.length ? keys : [...def]
}

// Parse a persisted layout string. Back-compatible: a bare array (the legacy
// anubee.columns format) becomes {columns, stacked, no widths}. Foreign/stale keys
// dropped against the resolved mode's key set; id forced present.
export function parseLayout(engine: 'syscall' | 'func', raw: string | null): ColumnLayout {
  if (!raw) return defaultLayout(engine)
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return defaultLayout(engine) }

  if (Array.isArray(parsed)) {
    const mode: CallSiteMode = 'stacked'
    return { columns: coerceColumns(parsed, engine, mode), widths: {}, callSite: mode }
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    const mode: CallSiteMode = o.callSite === 'split' ? 'split' : 'stacked'
    const cols = coerceColumns(o.columns, engine, mode)
    const widths: Record<string, number> = {}
    if (o.widths && typeof o.widths === 'object') {
      for (const [k, v] of Object.entries(o.widths as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) widths[k] = v
      }
    }
    return { columns: cols, widths, callSite: mode }
  }
  return defaultLayout(engine)
}

// The canonical column order for an engine in a given call-site mode (drives the
// picker list order and the post-toggle column rebuild, so callSite lands where
// the default layout puts it, not where ALL_COLUMNS lists it).
export function engineColumnKeys(engine: 'syscall' | 'func', mode: CallSiteMode): ColumnKey[] {
  return [...engineKeys(engine, mode)]
}
