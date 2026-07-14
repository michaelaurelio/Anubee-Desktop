import { describe, it, expect } from 'vitest'
import { parseElfHeader } from '@shared/elf-triage'

// Minimal 64-byte ELF header: magic, EI_CLASS, EI_DATA, then e_machine at 0x12.
function header(cls: number, data: number, machine: number): Uint8Array {
  const b = new Uint8Array(64)
  b.set([0x7f, 0x45, 0x4c, 0x46]) // \x7fELF
  b[4] = cls   // 1 = 32-bit, 2 = 64-bit
  b[5] = data  // 1 = little-endian
  if (data === 1) { b[18] = machine & 0xff; b[19] = (machine >> 8) & 0xff }
  else { b[18] = (machine >> 8) & 0xff; b[19] = machine & 0xff }
  return b
}

describe('parseElfHeader', () => {
  it('reads arm64 (little-endian, 64-bit)', () => {
    expect(parseElfHeader(header(2, 1, 0xb7))).toEqual({ valid: true, bits: 64, arch: 'arm64' })
  })
  it('reads arm (32-bit)', () => {
    expect(parseElfHeader(header(1, 1, 0x28))).toEqual({ valid: true, bits: 32, arch: 'arm' })
  })
  it('reads x86_64', () => {
    expect(parseElfHeader(header(2, 1, 0x3e))).toEqual({ valid: true, bits: 64, arch: 'x86_64' })
  })
  it('reads big-endian e_machine', () => {
    expect(parseElfHeader(header(2, 2, 0xb7))).toEqual({ valid: true, bits: 64, arch: 'arm64' })
  })
  it('reports an unknown machine as hex', () => {
    expect(parseElfHeader(header(2, 1, 0x99))).toEqual({ valid: true, bits: 64, arch: 'e_machine 0x99' })
  })
  it('rejects a non-ELF buffer', () => {
    expect(parseElfHeader(new Uint8Array([0, 1, 2, 3, 4, 5]))).toEqual({ valid: false, bits: null, arch: null })
  })
  it('rejects a truncated buffer', () => {
    expect(parseElfHeader(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toEqual({ valid: false, bits: null, arch: null })
  })
})
