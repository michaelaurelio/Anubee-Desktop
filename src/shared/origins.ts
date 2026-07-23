// The offset origin row behind a native node's offset popup, plus the hex math
// (module-relative = addr - load_base, the ghidra image-base offset) and the
// copy / JSON shaping. Electron-free and DB-free so it is unit-tested in
// isolation and shared by the store, the renderer, and (later) the Session MCP.

import type { RawHit, ResolvedHit } from './rasp-heuristics'

export interface OffsetRow {
  module: string                       // library basename, e.g. 'libexample.so'
  offset: string                       // module-relative, 0x-hex (ghidra offset)
  symbol: string | null                // resolved symbol, if any
  syscall: string                      // the syscall this call-site row is for
  argsSample: Record<string, string>   // decoded args of a representative event
  count: number                        // events for this (offset, syscall)
  sampleEventId: number                // id of a representative event for row-expand
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

// The load-base lookup: "<pid>|<module basename>" -> base address. Plain data,
// owned by the store at ingest, passed by value into the pure resolver.
export type ModuleBases = ReadonlyMap<string, bigint>

export function baseKey(pid: number, module: string): string {
  return `${pid}|${module}`
}

// Stamp each hit's anchor frame with its module-relative (ghidra) offset, so a
// heuristic tag's offset is byte-identical to one authored from the offset popup.
// A hit with no frame, no load base, or an unparseable address is '[unmapped]'
// rather than dropped: the behaviour was still detected, only the call site is
// unknown.
export function resolveHits(hits: RawHit[], bases: ModuleBases): ResolvedHit[] {
  return hits.map(h => ({
    target: h.target, category: h.category, confidence: h.confidence,
    rationale: h.rationale, offset: offsetOf(h, bases),
  }))
}

function offsetOf(h: RawHit, bases: ModuleBases): string {
  if (h.frame === null) return '[unmapped]'
  const base = bases.get(baseKey(h.pid, h.frame.module))
  if (base === undefined) return '[unmapped]'
  const addr = parseHexAddr(h.frame.addr)
  if (addr === null) return '[unmapped]'
  return moduleRelative(addr, base)
}
