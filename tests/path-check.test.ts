import { describe, it, expect } from 'vitest'
import { isElf, hasSpecFile } from '../src/main/path-check'

describe('isElf', () => {
  it('accepts the ELF magic', () => {
    expect(isElf(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02]))).toBe(true)
  })
  it('rejects non-ELF bytes', () => {
    expect(isElf(new Uint8Array([0x23, 0x21, 0x2f, 0x62]))).toBe(false) // "#!/b"
  })
  it('rejects a head shorter than 4 bytes', () => {
    expect(isElf(new Uint8Array([0x7f, 0x45]))).toBe(false)
  })
})

describe('hasSpecFile', () => {
  it('accepts a directory containing a .spec file', () => {
    expect(hasSpecFile(['README.md', 'common-file.spec'])).toBe(true)
  })
  it('rejects a directory with no .spec file', () => {
    expect(hasSpecFile(['README.md', 'notes.txt'])).toBe(false)
  })
  it('rejects an empty directory', () => {
    expect(hasSpecFile([])).toBe(false)
  })
})
