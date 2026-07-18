// Shared types for the Native Libraries feature (lib + dump engines). Pure,
// Electron-free: consumed by the main process, preload, and renderer alike.

// A parsed [lib]/[unlib] stdout line from a live `ares lib` stream.
export interface LibLine {
  kind: 'lib' | 'unlib'
  pid: number
  start: string // "0x..." (hex, as emitted)
  end: string
  pgoff?: number
  inode?: number
  ppid?: number
  library?: string // full on-disk path (lib only)
  soname?: string  // APK-embedded .so name (lib only, optional)
}

// One row of the loaded-run or live libraries table.
export interface LibRow {
  library: string
  soname: string | null
  base: string // "0x..." (start)
  end: string
  size: number // end - start, bytes
  pgoff: number
  inode: number
  pid: number
  tid: number | null
  ppid: number | null
  seq: number // ingest order (loaded) - first-seen
  unmapped: boolean
}

// Result of parsing a dumped .so's ELF header.
export interface ElfInfo {
  valid: boolean
  bits: 32 | 64 | null
  arch: string | null // 'arm64' | 'arm' | 'x86_64' | 'x86' | 'e_machine 0x..'
}

// One record of the dump manifest (dump_emit_module in ../Anubee/src/dump/dump_emit.c).
export interface DumpManifest {
  type: 'dump'
  module: string
  path: string
  base: string
  pid: number
  raw: boolean
}

// A triaged dumped artifact shown in the artifacts dock.
export interface Artifact {
  module: string
  path: string // host path to the pulled .so
  base: string
  pid: number
  size: number
  arch: string | null
  elfValid: boolean
  raw: boolean
  sha256: string
}

export type ModcmpState = 'match' | 'differ' | 'nofile' | 'apk' | 'unreadable'

// One `ares dump --check` verdict for a module, joined to a table row by
// pid+base (NOT module: an APK-embedded lib's module is "base.apk").
export interface Modcmp {
  module: string
  path: string
  base: string
  pid: number
  state: ModcmpState
  memSha256: string | null
  fileSha256: string | null
}
