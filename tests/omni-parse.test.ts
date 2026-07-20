import { describe, it, expect } from 'vitest'
import { splitWords, matchToken, filterFromParts, OMNI_KEYS } from '@shared/omni-parse'

describe('splitWords', () => {
  it('splits on whitespace', () => {
    expect(splitWords('a  b c')).toEqual(['a', 'b', 'c'])
  })
  it('keeps a quoted value span as one word', () => {
    expect(splitWords('symbol:"a b" x')).toEqual(['symbol:"a b"', 'x'])
  })
  it('returns [] for blank input', () => {
    expect(splitWords('   ')).toEqual([])
  })
})

describe('matchToken — dotted grammar', () => {
  it('recognizes every key', () => {
    expect(matchToken('syscall:openat')).toEqual({ key: 'syscall', value: 'openat' })
    expect(matchToken('tid:101')).toEqual({ key: 'tid', value: '101' })
    expect(matchToken('id:1500')).toEqual({ key: 'id', value: '1500' })
    expect(matchToken('id:1500-1600')).toEqual({ key: 'id', value: '1500-1600' })
    expect(matchToken('java.exist:true')).toEqual({ key: 'java.exist', value: 'true' })
    expect(matchToken('java.method:onCreate')).toEqual({ key: 'java.method', value: 'onCreate' })
    expect(matchToken('stack.lib:libc')).toEqual({ key: 'stack.lib', value: 'libc' })
    expect(matchToken('stack.sym:checkRoot')).toEqual({ key: 'stack.sym', value: 'checkRoot' })
    expect(matchToken('fn.lib:libexample')).toEqual({ key: 'fn.lib', value: 'libexample' })
    expect(matchToken('fn.sym:checkRoot')).toEqual({ key: 'fn.sym', value: 'checkRoot' })
    expect(matchToken('tag.exist:false')).toEqual({ key: 'tag.exist', value: 'false' })
    expect(matchToken('tag.name:root')).toEqual({ key: 'tag.name', value: 'root' })
  })
  it('rejects the removed legacy keys (become free text)', () => {
    expect(matchToken('lib:libc')).toBeNull()
    expect(matchToken('module:x')).toBeNull()
    expect(matchToken('symbol:x')).toBeNull()
    expect(matchToken('java:yes')).toBeNull()
  })
  it('validates value shapes', () => {
    expect(matchToken('tid:abc')).toBeNull()
    expect(matchToken('id:12ab')).toBeNull()
    expect(matchToken('id:1600-1500')).toBeNull() // descending range → free text
    expect(matchToken('java.exist:maybe')).toBeNull()
    expect(matchToken('java.exist:yes')).toBeNull() // yes/no no longer accepted; true/false only
    expect(matchToken('tag.exist:1')).toBeNull()
    expect(matchToken('tag.exist:no')).toBeNull()
    expect(matchToken('tag.name:bogus')).toBeNull()
    expect(matchToken('fn.bogus:x')).toBeNull()
    expect(matchToken('syscall:')).toBeNull()
  })
  it('unquotes a quoted value', () => {
    expect(matchToken('stack.sym:"a b"')).toEqual({ key: 'stack.sym', value: 'a b' })
  })
  it('treats an unterminated quote as free text', () => {
    expect(matchToken('stack.sym:"a')).toBeNull()
    expect(matchToken('stack.sym:"')).toBeNull()
  })
})

describe('filterFromParts — field mapping', () => {
  it('maps every key onto its Filter field', () => {
    const chips = [
      { key: 'syscall', value: 'openat' },
      { key: 'tid', value: '101' },
      { key: 'id', value: '1500-1600' },
      { key: 'java.exist', value: 'true' },
      { key: 'java.method', value: 'onCreate' },
      { key: 'stack.lib', value: 'libc' },
      { key: 'stack.sym', value: 'checkRoot' },
      { key: 'fn.lib', value: 'libexample' },
      { key: 'fn.sym', value: 'openImpl' },
      { key: 'tag.exist', value: 'true' },
    ] as const
    expect(filterFromParts([...chips] as never, '')).toEqual({
      syscall: 'openat', tid: 101, id: 1500, idMax: 1600,
      hasJavaStack: true, javaMethod: 'onCreate', library: 'libc',
      stackSymbol: 'checkRoot', module: 'libexample', symbol: 'openImpl', tagged: 'yes',
    })
  })
  it('id exact sets id without idMax', () => {
    expect(filterFromParts([{ key: 'id', value: '1500' }] as never, '')).toEqual({ id: 1500 })
  })
  it('tag.name sets tagName', () => {
    expect(filterFromParts([{ key: 'tag.name', value: 'root' }] as never, '')).toEqual({ tagName: 'root' })
  })
})

describe('OMNI_KEYS', () => {
  it('lists all keys once, in grouped order', () => {
    expect(OMNI_KEYS.map(k => k.key)).toEqual([
      'syscall', 'tid', 'id',
      'java.exist', 'java.method',
      'stack.lib', 'stack.sym',
      'fn.lib', 'fn.sym',
      'tag.exist', 'tag.name',
    ])
  })
})
