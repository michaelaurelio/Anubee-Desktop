import { describe, it, expect } from 'vitest'
import { javaLeaf, nativeLeaf, formatDuration } from '../src/renderer/call-site'

describe('javaLeaf', () => {
  it('takes the final dotted segment', () => {
    expect(javaLeaf('dev.anubee.detector.ChecksKt.CHECK_REGISTRY')).toBe('CHECK_REGISTRY')
  })
  it('strips a trailing +0x offset before the split', () => {
    expect(javaLeaf('a.b.run+0x1c')).toBe('run')
  })
  it('returns the input when there is no dot', () => {
    expect(javaLeaf('runCheck')).toBe('runCheck')
  })
})

describe('nativeLeaf', () => {
  it('keeps module!symbol and strips the offset', () => {
    expect(nativeLeaf('libsentinel.so!maps_iterate+0x44')).toBe('libsentinel.so!maps_iterate')
  })
  it('is a no-op with no offset', () => {
    expect(nativeLeaf('libc.so!read')).toBe('libc.so!read')
  })
})

describe('formatDuration', () => {
  it('nanoseconds under 1us', () => { expect(formatDuration(340)).toBe('340 ns') })
  it('microseconds', () => { expect(formatDuration(1234)).toBe('1.2 µs') })
  it('milliseconds', () => { expect(formatDuration(2_100_000)).toBe('2.1 ms') })
  it('seconds', () => { expect(formatDuration(1_300_000_000)).toBe('1.30 s') })
})
