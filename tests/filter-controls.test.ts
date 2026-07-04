import { describe, it, expect } from 'vitest'
import { readFilterFrom } from '../src/renderer/filter-controls'

describe('readFilterFrom', () => {
  it('omits empty fields', () => {
    expect(readFilterFrom({ text: '', syscall: '', library: '', tid: '', hasJava: false })).toEqual({})
  })

  it('includes present fields and parses tid', () => {
    expect(readFilterFrom({ text: 'su', syscall: 'openat', library: 'libexample', tid: '101', hasJava: true }))
      .toEqual({ text: 'su', syscall: 'openat', library: 'libexample', tid: 101, hasJavaStack: true })
  })

  it('ignores a non-numeric tid', () => {
    expect(readFilterFrom({ text: '', syscall: '', library: '', tid: 'abc', hasJava: false })).toEqual({})
  })

  it('trims whitespace and drops blank-after-trim fields', () => {
    expect(readFilterFrom({ text: '  ', syscall: ' openat ', library: '', tid: ' ', hasJava: false }))
      .toEqual({ syscall: 'openat' })
  })
})
