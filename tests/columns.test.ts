import { describe, it, expect } from 'vitest'
import { ALL_COLUMNS, DEFAULT_COLUMNS, serializeColumns, parseColumns, columnsForEngine, type ColumnKey } from '../src/renderer/columns'
import { columnCatalogue, SYSCALL_COLUMNS, FUNCS_COLUMNS } from '../src/renderer/columns'

describe('columns module', () => {
  it('default set is the six and every key is in the catalogue', () => {
    expect(DEFAULT_COLUMNS).toEqual(['id', 'syscall', 'topJava', 'topNative', 'arg', 'tags'])
    const keys = new Set(ALL_COLUMNS.map(c => c.key))
    for (const k of DEFAULT_COLUMNS) expect(keys.has(k)).toBe(true)
  })

  it('serialize/parse round-trips a chosen set', () => {
    const set: ColumnKey[] = ['id', 'tid', 'syscall', 'arg']
    expect(parseColumns(serializeColumns(set))).toEqual(set)
  })

  it('null / corrupt input falls back to defaults', () => {
    expect(parseColumns(null)).toEqual(DEFAULT_COLUMNS)
    expect(parseColumns('{not json')).toEqual(DEFAULT_COLUMNS)
  })

  it('drops unknown keys and always includes id', () => {
    expect(parseColumns(JSON.stringify(['syscall', 'bogus']))).toEqual(['id', 'syscall'])
  })

  it('uses funcs columns for a funcs run', () => {
    expect(columnsForEngine('func', null)).toEqual(['id', 'fn', 'caller', 'retval', 'elapsed', 'arg'])
  })
  it('uses the saved/default syscall columns for a syscall run', () => {
    expect(columnsForEngine('syscall', null)).toEqual(['id', 'syscall', 'topJava', 'topNative', 'arg', 'tags'])
  })
})

describe('columnCatalogue', () => {
  it('offers only syscall columns for a syscall run', () => {
    expect(columnCatalogue('syscall').map(c => c.key)).toEqual(SYSCALL_COLUMNS)
  })
  it('offers only funcs columns for a funcs run', () => {
    expect(columnCatalogue('func').map(c => c.key)).toEqual(FUNCS_COLUMNS)
  })
})

describe('columnsForEngine', () => {
  it('drops foreign-engine keys from a saved set and forces id in', () => {
    // a saved funcs set must never yield syscall columns
    const saved = serializeColumns(['fn', 'caller', 'syscall', 'tags'] as never)
    expect(columnsForEngine('func', saved)).toEqual(['id', 'fn', 'caller'])
  })
  it('falls back to the engine default when nothing is saved', () => {
    expect(columnsForEngine('func', null)).toEqual([...FUNCS_COLUMNS])
    expect(columnsForEngine('syscall', null)).toEqual(['id', 'syscall', 'topJava', 'topNative', 'arg', 'tags'])
  })
})
