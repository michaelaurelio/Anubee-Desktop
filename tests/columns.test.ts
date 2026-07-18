import { describe, it, expect } from 'vitest'
import { ALL_COLUMNS, DEFAULT_COLUMNS, serializeColumns, parseColumns, columnsForEngine, type ColumnKey } from '../src/renderer/columns'
import { columnCatalogue, SYSCALL_COLUMNS, FUNCS_COLUMNS, parseLayout, serializeLayout, engineDefaultColumns, engineColumnKeys, type ColumnLayout } from '../src/renderer/columns'

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

describe('parseLayout', () => {
  it('defaults a syscall run to the stacked call-site columns', () => {
    const l = parseLayout('syscall', null)
    expect(l.columns).toEqual(['id', 'syscall', 'callSite', 'arg', 'tags'])
    expect(l.callSite).toBe('stacked')
    expect(l.widths).toEqual({})
  })
  it('defaults a funcs run to the stacked funcs columns', () => {
    expect(parseLayout('func', null).columns).toEqual(['id', 'callSite', 'retval', 'elapsed', 'arg'])
  })
  it('reads a legacy bare-array string as columns with stacked mode + no widths', () => {
    const l = parseLayout('syscall', JSON.stringify(['id', 'syscall', 'arg']))
    expect(l.columns).toEqual(['id', 'syscall', 'arg'])
    expect(l.callSite).toBe('stacked')
  })
  it('round-trips a full layout and forces id present', () => {
    const src: ColumnLayout = { columns: ['syscall', 'callSite'], widths: { callSite: 260 }, callSite: 'split' }
    const l = parseLayout('syscall', serializeLayout(src))
    expect(l.columns[0]).toBe('id')
    expect(l.widths.callSite).toBe(260)
    expect(l.callSite).toBe('split')
  })
})

describe('columnCatalogue mode', () => {
  it('stacked syscall offers callSite, not the split java/native columns', () => {
    const keys = columnCatalogue('syscall', 'stacked').map(c => c.key)
    expect(keys).toContain('callSite')
    expect(keys).not.toContain('topJava')
  })
  it('split syscall offers topJava/topNative, not callSite', () => {
    const keys = columnCatalogue('syscall', 'split').map(c => c.key)
    expect(keys).toContain('topJava')
    expect(keys).not.toContain('callSite')
  })
  it('split funcs offers function/caller, stacked offers callSite', () => {
    expect(columnCatalogue('func', 'split').map(c => c.key)).toContain('fn')
    expect(columnCatalogue('func', 'stacked').map(c => c.key)).toContain('callSite')
  })
})

describe('tid/ret are offered but default-off (syscall)', () => {
  it('stacked catalogue offers tid and retval', () => {
    const keys = columnCatalogue('syscall', 'stacked').map(c => c.key)
    expect(keys).toContain('tid')
    expect(keys).toContain('retval')
  })
  it('split catalogue offers tid and retval', () => {
    const keys = columnCatalogue('syscall', 'split').map(c => c.key)
    expect(keys).toContain('tid')
    expect(keys).toContain('retval')
  })
  it('default-visible omits tid and retval in both modes', () => {
    expect(engineDefaultColumns('syscall', 'stacked')).toEqual(['id', 'syscall', 'callSite', 'arg', 'tags'])
    expect(engineDefaultColumns('syscall', 'split')).toEqual(['id', 'syscall', 'java', 'topJava', 'topNative', 'arg', 'tags'])
  })
  it('parseLayout default still omits tid/retval', () => {
    expect(parseLayout('syscall', null).columns).not.toContain('tid')
    expect(parseLayout('syscall', null).columns).not.toContain('retval')
  })
  it('a persisted layout with tid/retval round-trips (they are valid keys)', () => {
    const src: ColumnLayout = { columns: ['id', 'tid', 'syscall', 'retval', 'callSite', 'arg', 'tags'], widths: {}, callSite: 'stacked' }
    const l = parseLayout('syscall', serializeLayout(src))
    expect(l.columns).toContain('tid')
    expect(l.columns).toContain('retval')
  })
  it('funcs default-visible equals its catalogue (unchanged)', () => {
    expect(engineDefaultColumns('func', 'stacked')).toEqual(engineColumnKeys('func', 'stacked'))
    expect(engineDefaultColumns('func', 'split')).toEqual(engineColumnKeys('func', 'split'))
  })
})
