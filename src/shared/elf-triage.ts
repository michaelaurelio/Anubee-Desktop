import type { ElfInfo } from './native-lib'

const INVALID: ElfInfo = { valid: false, bits: null, arch: null }
const MACHINES: Record<number, string> = { 0x28: 'arm', 0xb7: 'arm64', 0x03: 'x86', 0x3e: 'x86_64' }

// Parse an ELF file's identification + e_machine from its leading bytes.
// Needs at least the 20-byte prefix that covers e_machine (offset 0x12).
export function parseElfHeader(bytes: Uint8Array): ElfInfo {
  if (bytes.length < 20) return INVALID
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return INVALID
  const bits = bytes[4] === 2 ? 64 : bytes[4] === 1 ? 32 : null
  const le = bytes[5] !== 2 // EI_DATA: 2 = big-endian, else little
  const machine = le ? bytes[18] | (bytes[19] << 8) : (bytes[18] << 8) | bytes[19]
  const arch = MACHINES[machine] ?? `e_machine 0x${machine.toString(16)}`
  return { valid: true, bits, arch }
}
