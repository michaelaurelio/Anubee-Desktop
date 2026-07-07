// The offset origin row behind a native node's offset popup, plus the hex math
// (module-relative = addr - load_base, the ghidra image-base offset) and the
// copy / JSON shaping. Electron-free and DB-free so it is unit-tested in
// isolation and shared by the store, the renderer, and (later) the Session MCP.

export interface OffsetRow {
  module: string                       // library basename, e.g. 'libexample.so'
  offset: string                       // module-relative, 0x-hex (ghidra offset)
  symbol: string | null                // resolved symbol, if any
  reaches: string[]                    // distinct syscalls this call-site leads to
  argsSample: Record<string, string>   // decoded args of a representative event
  count: number                        // events in which this call-site appears
}

export interface OriginBlob {
  node: string                         // the native function node id
  offsets: OffsetRow[]
}

// '0x1a0' | '1a0' -> 0x1a0n; null if not clean hex.
export function parseHexAddr(s: string): bigint | null {
  const body = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s
  if (body.length === 0 || !/^[0-9a-fA-F]+$/.test(body)) return null
  return BigInt('0x' + body)
}

// Module-relative offset as 0x-hex.
export function moduleRelative(addr: bigint, base: bigint): string {
  return '0x' + (addr - base).toString(16)
}

// Plain-text copy: 'libexample.so + 0x4a1c0' (paste into ghidra goto).
export function copyText(row: OffsetRow): string {
  return `${row.module} + ${row.offset}`
}

export function rowJson(row: OffsetRow): string {
  return JSON.stringify(row)
}

export function blobJson(blob: OriginBlob): string {
  return JSON.stringify(blob)
}
