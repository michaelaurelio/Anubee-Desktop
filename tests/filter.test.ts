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

  it('text is bound across syscall, java_stack, and backtrace symbols', () => {
    const r = filterToSql({ text: 'su' })
    expect(r.params).toEqual(['%su%', '%su%', '%su%'])
    // The raw user text must be bound, never inlined into the SQL.
    expect(r.where).not.toContain('su')
    expect(r.where).toContain('?')
  })

  it('ANDs all present fields, params in field order', () => {
    const r = filterToSql({ syscall: 'openat', tid: 101 })
    expect(r.where).toContain(' AND ')
    expect(r.params).toEqual(['%openat%', 101])
  })

  it('ignores empty strings', () => {
    expect(filterToSql({ syscall: '', library: '', text: '' })).toEqual({ where: 'TRUE', params: [] })
  })
})
