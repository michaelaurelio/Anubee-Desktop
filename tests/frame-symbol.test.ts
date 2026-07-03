import { describe, it, expect } from 'vitest'
import { parseFrameSymbol } from '@shared/frame-symbol'

describe('parseFrameSymbol', () => {
  it('parses module!name+offset', () => {
    expect(parseFrameSymbol('libexample.so!check+0x10')).toEqual({
      module: 'libexample.so', symbol: 'check', offset: 0x10, raw: 'libexample.so!check+0x10',
    })
  })

  it('parses module!name without offset', () => {
    const p = parseFrameSymbol('libexample.so!check')
    expect(p.module).toBe('libexample.so')
    expect(p.symbol).toBe('check')
    expect(p.offset).toBeNull()
  })

  it('parses module+offset with no symbol', () => {
    const p = parseFrameSymbol('libexample.so+0x2a0')
    expect(p.module).toBe('libexample.so')
    expect(p.symbol).toBeNull()
    expect(p.offset).toBe(0x2a0)
  })

  it('parses [anon]+offset', () => {
    const p = parseFrameSymbol('[anon]+0x40')
    expect(p.module).toBe('[anon]')
    expect(p.symbol).toBeNull()
    expect(p.offset).toBe(0x40)
  })

  it('treats a bare address as unresolved (module null)', () => {
    const p = parseFrameSymbol('0x7fabc [unmapped]')
    expect(p.module).toBeNull()
    expect(p.symbol).toBeNull()
    expect(p.offset).toBeNull()
  })

  it('keeps an APK-embedded module path intact', () => {
    const p = parseFrameSymbol('base.apk -> libexample.so!check+0x4')
    expect(p.module).toBe('base.apk -> libexample.so')
    expect(p.symbol).toBe('check')
    expect(p.offset).toBe(0x4)
  })
})
