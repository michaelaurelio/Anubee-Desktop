import { describe, it, expect } from 'vitest'
import {
  parseHexAddr, moduleRelative, copyText, rowJson, blobJson,
  type OffsetRow, type OriginBlob,
} from '@shared/origins'

describe('parseHexAddr', () => {
  it('parses a 0x-prefixed hex string', () => {
    expect(parseHexAddr('0x1a0')).toBe(0x1a0n)
  })
  it('parses without the 0x prefix', () => {
    expect(parseHexAddr('1a0')).toBe(0x1a0n)
  })
  it('returns null for garbage', () => {
    expect(parseHexAddr('0xZZ')).toBeNull()
    expect(parseHexAddr('')).toBeNull()
  })
})

describe('moduleRelative', () => {
  it('subtracts base and formats 0x-hex', () => {
    expect(moduleRelative(0x1a0n, 0x100n)).toBe('0xa0')
  })
  it('is 0x0 at the base itself', () => {
    expect(moduleRelative(0x1000n, 0x1000n)).toBe('0x0')
  })
})

const row: OffsetRow = {
  module: 'libexample.so', offset: '0x4a1c0', symbol: 'check_su',
  reaches: ['openat', 'read'], argsSample: { '1': '/system/bin/su' }, count: 12, sampleEventId: 1,
}

describe('copyText', () => {
  it('renders module + offset, ghidra-pasteable', () => {
    expect(copyText(row)).toBe('libexample.so + 0x4a1c0')
  })
})

describe('rowJson / blobJson', () => {
  it('rowJson round-trips the row fields', () => {
    expect(JSON.parse(rowJson(row))).toEqual(row)
  })
  it('blobJson nests the node id + offsets', () => {
    const blob: OriginBlob = { node: 'nat:libexample.so!check_su', offsets: [row] }
    expect(JSON.parse(blobJson(blob))).toEqual(blob)
  })
})
