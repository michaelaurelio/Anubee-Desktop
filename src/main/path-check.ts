// Pure host-path validity checks for the Capture form's validity dots. No
// electron/node imports so this stays vitest-testable without a filesystem;
// the IO (reading the binary head, listing the specs dir) lives in index.ts.

export interface PathStatus {
  ok: boolean
  detail: string
}

export interface PathCheck {
  binary: PathStatus
  specs: PathStatus
}

// ELF magic: 0x7F 'E' 'L' 'F'. We only look at the first four bytes.
export function isElf(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46
}

// A valid Anubee specs dir carries at least one `.spec` file (see ../Anubee/specs).
export function hasSpecFile(entryNames: string[]): boolean {
  return entryNames.some(n => n.endsWith('.spec'))
}

// The .spec files among a directory's entry names, sorted ascending. Feeds the
// capture form's probe-spec dropdown.
export function specNames(entryNames: string[]): string[] {
  return entryNames.filter(n => n.endsWith('.spec')).sort()
}
