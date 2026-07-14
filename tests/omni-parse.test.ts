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

describe('matchToken', () => {
  it('recognizes every grammar key', () => {
    expect(matchToken('syscall:openat')).toEqual({ key: 'syscall', value: 'openat' })
    expect(matchToken('lib:libc')).toEqual({ key: 'lib', value: 'libc' })
    expect(matchToken('tid:101')).toEqual({ key: 'tid', value: '101' })
    expect(matchToken('java:yes')).toEqual({ key: 'java', value: 'yes' })
    expect(matchToken('java:no')).toEqual({ key: 'java', value: 'no' })
    expect(matchToken('module:libexample')).toEqual({ key: 'module', value: 'libexample' })
    expect(matchToken('symbol:checkRoot')).toEqual({ key: 'symbol', value: 'checkRoot' })
  })
  it('unquotes a quoted value', () => {
    expect(matchToken('symbol:"a b"')).toEqual({ key: 'symbol', value: 'a b' })
  })
  it('rejects unknown keys, empty values, bad tid, bad java', () => {
    expect(matchToken('bogus:x')).toBeNull()
    expect(matchToken('syscall:')).toBeNull()
    expect(matchToken('tid:abc')).toBeNull()
    expect(matchToken('java:maybe')).toBeNull()
    expect(matchToken('/proc/self')).toBeNull()
  })
  it('leaves an unterminated quote as free text', () => {
    expect(matchToken('symbol:"a')).toBeNull()
    expect(matchToken('symbol:"')).toBeNull()
  })
})

describe('filterFromParts', () => {
  it('maps chips onto the Filter fields', () => {
    expect(
      filterFromParts(
        [
          { key: 'syscall', value: 'openat' },
          { key: 'lib', value: 'libc' },
          { key: 'tid', value: '101' },
          { key: 'java', value: 'yes' },
          { key: 'module', value: 'libexample' },
          { key: 'symbol', value: 'checkRoot' },
        ],
        ' /proc/self ',
      ),
    ).toEqual({
      syscall: 'openat',
      library: 'libc',
      tid: 101,
      hasJavaStack: true,
      module: 'libexample',
      symbol: 'checkRoot',
      text: '/proc/self',
    })
  })
  it('java:no maps to hasJavaStack false', () => {
    expect(filterFromParts([{ key: 'java', value: 'no' }], '')).toEqual({ hasJavaStack: false })
  })
  it('later duplicate key wins', () => {
    expect(
      filterFromParts(
        [
          { key: 'syscall', value: 'read' },
          { key: 'syscall', value: 'openat' },
        ],
        '',
      ),
    ).toEqual({ syscall: 'openat' })
  })
  it('empty parts give an empty filter', () => {
    expect(filterFromParts([], '  ')).toEqual({})
  })
})

describe('OMNI_KEYS', () => {
  it('lists all six keys with hints', () => {
    expect(OMNI_KEYS.map(k => k.key)).toEqual(['syscall', 'lib', 'tid', 'java', 'module', 'symbol'])
    for (const k of OMNI_KEYS) expect(k.hint.length).toBeGreaterThan(0)
  })
})
