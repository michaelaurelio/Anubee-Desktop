import { describe, it, expect } from 'vitest'
import { filterToSql } from '@shared/filter'

describe('filterToSql', () => {
  it('an empty filter matches everything with no params', () => {
    expect(filterToSql({})).toEqual({ where: 'TRUE', params: [] })
  })

  it('syscall is a bound case-insensitive substring', () => {
    const r = filterToSql({ syscall: 'openat' })
    expect(r.where).toContain('ILIKE ?')
    expect(r.where).toContain('syscall')
    expect(r.params).toEqual(['%openat%'])
  })

  it('tid is an exact bound match', () => {
    expect(filterToSql({ tid: 101 })).toEqual({ where: 'tid = ?', params: [101] })
  })

  it('hasJavaStack true tests a non-empty java_stack, false negates it, no params', () => {
    const t = filterToSql({ hasJavaStack: true })
    expect(t.params).toEqual([])
    expect(t.where).toContain('java_stack')
    expect(t.where).toContain('len(java_stack)')
    const f = filterToSql({ hasJavaStack: false })
    expect(f.where.startsWith('NOT ')).toBe(true)
  })

  it('library is a bound substring over parsed backtrace modules', () => {
    const r = filterToSql({ library: 'libexample' })
    expect(r.where).toContain('backtrace')
    expect(r.params).toEqual(['%libexample%'])
  })

  it('text is bound across syscall, stacks, and all arg fields', () => {
    const r = filterToSql({ text: 'su' })
    expect(r.params).toEqual(Array(10).fill('%su%'))
    // The raw user text must be bound, never inlined into the SQL.
    expect(r.where).not.toContain('su')
    for (const col of ['args', 'string_args', 'fd_args', 'decoded_args', 'sock_args', 'out_args', 'sock_addr']) {
      expect(r.where).toContain(col)
    }
  })

  it('ANDs all present fields, params in field order', () => {
    const r = filterToSql({ syscall: 'openat', tid: 101 })
    expect(r.where).toContain(' AND ')
    expect(r.params).toEqual(['%openat%', 101])
  })

  it('ignores empty strings', () => {
    expect(filterToSql({ syscall: '', library: '', text: '' })).toEqual({ where: 'TRUE', params: [] })
  })

  it('filters by module and symbol (funcs)', () => {
    const { where, params } = filterToSql({ module: 'libc', symbol: 'getProp' })
    expect(where).toContain('module ILIKE ?')
    expect(where).toContain('symbol ILIKE ?')
    expect(params).toEqual(['%libc%', '%getProp%'])
  })

  it('id exact is a bound equality', () => {
    expect(filterToSql({ id: 1500 })).toEqual({ where: 'id = ?', params: [1500] })
  })
  it('id range is an inclusive BETWEEN', () => {
    expect(filterToSql({ id: 1500, idMax: 1600 })).toEqual({ where: 'id BETWEEN ? AND ?', params: [1500, 1600] })
  })
  it('javaMethod is a bound substring over java_stack frames', () => {
    const r = filterToSql({ javaMethod: 'onCreate' })
    expect(r.where).toContain('java_stack')
    expect(r.where).toContain('ILIKE ?')
    expect(r.params).toEqual(['%onCreate%'])
  })
  it('stackSymbol is a bound substring over backtrace symbols', () => {
    const r = filterToSql({ stackSymbol: 'checkRoot' })
    expect(r.where).toContain('backtrace')
    expect(r.where).toContain('b.symbol')
    expect(r.params).toEqual(['%checkRoot%'])
  })

  const TT = { syscalls: ['openat'], natFrames: ['libexample.so!checkRoot'], javaMethods: ['com.x.Y.isRooted'] }

  it('tag.exist:true ORs the three bucket predicates with bound IN lists', () => {
    const r = filterToSql({ tagged: 'yes', tagTargets: TT })
    expect(r.where).toContain('syscall IN (?)')
    expect(r.where).toContain('backtrace')
    expect(r.where).toContain('java_stack')
    expect(r.where.startsWith('NOT ')).toBe(false)
    expect(r.params).toEqual(['openat', 'libexample.so!checkRoot', 'com.x.Y.isRooted'])
  })
  it('tag.exist:false negates the predicate', () => {
    const r = filterToSql({ tagged: 'no', tagTargets: TT })
    expect(r.where.startsWith('NOT ')).toBe(true)
    expect(r.params).toEqual(['openat', 'libexample.so!checkRoot', 'com.x.Y.isRooted'])
  })
  it('an empty tagTargets matches nothing (FALSE), not everything', () => {
    const r = filterToSql({ tagged: 'yes', tagTargets: { syscalls: [], natFrames: [], javaMethods: [] } })
    expect(r.where).toBe('FALSE')
    expect(r.params).toEqual([])
  })
  it('tagName reuses the predicate (renderer pre-scopes the targets)', () => {
    const r = filterToSql({ tagName: 'root', tagTargets: { syscalls: ['openat'], natFrames: [], javaMethods: [] } })
    expect(r.where).toContain('syscall IN (?)')
    expect(r.params).toEqual(['openat'])
  })
  it('tag.exist:false with an all-empty tagTargets matches everything (NOT FALSE)', () => {
    expect(filterToSql({ tagged: 'no', tagTargets: { syscalls: [], natFrames: [], javaMethods: [] } })).toEqual({ where: 'NOT FALSE', params: [] })
  })
})
