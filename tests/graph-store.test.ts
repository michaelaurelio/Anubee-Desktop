import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../src/main/graph-store'
import { parseJsonl, isSyscall } from '@shared/ares-parse'
import { foldEvents, type GraphSlice } from '@shared/graph-shape'
import type { Rule } from '@shared/rasp-heuristics'

// A trace with 2 root-check bridges (java + native), 1 java-less read, a
// non-syscall `lib` record, and a deliberately malformed line. Placeholder
// identifiers only.
const LINES = [
  JSON.stringify({ type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat', args: ['0x1'], retval: 7, string_args: { '1': '/system/bin/su' }, fd_args: {}, decoded_args: {}, stack_id: 11, java_stack: ['com.example.app.RootCheck.run'], backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }] }),
  JSON.stringify({ type: 'syscall', id: 2, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat', args: ['0x1'], retval: -2, string_args: { '1': '/sbin/magisk' }, fd_args: {}, decoded_args: {}, stack_id: 11, java_stack: ['com.example.app.RootCheck.run'], backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }] }),
  JSON.stringify({ type: 'syscall', id: 3, pid: 100, tid: 202, syscall_nr: 62, syscall: 'read', args: ['0x5'], retval: 128, string_args: {}, fd_args: { '0': '/proc/self/status' }, decoded_args: {}, backtrace: [{ frame: 0, addr: '0x9', symbol: 'libc.so!read+0x8' }] }),
  JSON.stringify({ type: 'lib', pid: 100, library: 'libexample.so' }),
  '{bad line to prove tolerance}',
]

let dir: string
let store: GraphStore | undefined

function fixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'ares-store-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, LINES.join('\n') + '\n')
  return p
}

afterEach(async () => {
  await store?.close()
  store = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('GraphStore.ingest', () => {
  it('counts syscalls, tolerates the bad line, ignores non-syscall records', async () => {
    store = new GraphStore()
    const r = await store.ingest(fixture())
    expect(r.eventCount).toBe(3) // 3 syscalls
    expect(r.errors).toBe(1) // the malformed line only (lib is neither event nor error)
  })
})

describe('GraphStore.table', () => {
  it('returns rows with derived hasJava / topJava / topNative', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const rows = await store.table({}, { limit: 100, offset: 0 })
    expect(rows).toHaveLength(3)
    const r1 = rows.find(r => r.id === 1)!
    expect(r1.hasJava).toBe(true)
    expect(r1.topJava).toBe('com.example.app.RootCheck.run')
    expect(r1.topNative).toBe('libexample.so!check_su+0x10')
    expect(typeof r1.id).toBe('number')
    const r3 = rows.find(r => r.id === 3)!
    expect(r3.hasJava).toBe(false)
    expect(r3.topJava).toBeNull()
  })
})

describe('GraphStore.count', () => {
  it('counts all matching events regardless of the table page window', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect(await store.count()).toBe(3) // 3 syscalls; lib + bad line excluded
    expect(await store.count({ tid: 202 })).toBe(1)
    expect(await store.count({ hasJavaStack: true })).toBe(2)
  })
})

describe('GraphStore.eventById', () => {
  it('returns one raw record as a plain SyscallEvent', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const e = await store.eventById(1)
    expect(e).toBeDefined()
    expect(e!.syscall).toBe('openat')
    expect(e!.tid).toBe(101)
    expect(e!.java_stack).toEqual(['com.example.app.RootCheck.run'])
    expect(e!.string_args['1']).toBe('/system/bin/su')
    expect(e!.backtrace[0].symbol).toBe('libexample.so!check_su+0x10')
  })

  it('returns undefined for an unknown id', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect(await store.eventById(999)).toBeUndefined()
  })
})

// The DuckDB slice SQL must reconstruct the same graph as the pure-TS oracle.
const oracleEvents = parseJsonl(LINES.join('\n')).events.filter(isSyscall)

const normNodes = (s: GraphSlice) =>
  [...s.nodes].sort((a, b) => a.id.localeCompare(b.id))
    .map(n => ({ id: n.id, kind: n.kind, label: n.label, module: n.module, count: n.count }))
const normEdges = (s: GraphSlice) =>
  [...s.edges].sort((a, b) => a.id.localeCompare(b.id))
    .map(e => ({ id: e.id, source: e.source, target: e.target, count: e.count }))

describe('GraphStore.slice', () => {
  it('reconstructs the same nodes/edges as the foldEvents oracle', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const oracle = foldEvents(oracleEvents)
    const slice = await store.slice()

    expect(slice.eventCount).toBe(oracle.eventCount)
    expect(slice.truncated).toBe(false)
    expect(normNodes(slice)).toEqual(normNodes(oracle))
    expect(normEdges(slice)).toEqual(normEdges(oracle))
  })

  it('flags truncated when node+edge count exceeds the cap', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const slice = await store.slice({}, 2)
    expect(slice.truncated).toBe(true)
  })
})

describe('GraphStore filtering (filterToSql wired end-to-end)', () => {
  it('filters the table by hasJavaStack, tid, syscall, and library', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect((await store.table({ hasJavaStack: true }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([1, 2])
    expect((await store.table({ tid: 202 }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([3])
    expect((await store.table({ syscall: 'READ' }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([3])
    expect((await store.table({ library: 'libexample' }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([1, 2])
  })

  it('filters the slice to the java-bearing bridges only', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const s = await store.slice({ hasJavaStack: true })
    expect(s.eventCount).toBe(2)
    const ids = s.nodes.map(n => n.id)
    expect(ids).toContain('java:com.example.app.RootCheck.run')
    expect(ids).toContain('nat:libexample.so!check_su')
    expect(ids).toContain('sys:openat')
    expect(ids).not.toContain('sys:read')
  })

  it('free-text matches across syscall, java, and backtrace symbols', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect((await store.table({ text: 'RootCheck' }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([1, 2])
    expect((await store.table({ text: 'check_su' }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([1, 2])
    expect((await store.table({ text: 'read' }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([3])
  })
})

describe('GraphStore.nodeEvents', () => {
  it('returns the raw records whose chain touches a node', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect((await store.nodeEvents('sys:openat')).map(e => e.id)).toEqual([1, 2])
    expect((await store.nodeEvents('java:com.example.app.RootCheck.run')).map(e => e.id)).toEqual([1, 2])
    expect((await store.nodeEvents('nat:libc.so!read')).map(e => e.id)).toEqual([3])
  })

  it('honours the active filter', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect((await store.nodeEvents('sys:openat', { tid: 101 })).map(e => e.id)).toEqual([1, 2])
    expect((await store.nodeEvents('sys:openat', { tid: 999 }))).toEqual([])
  })
})

describe('GraphStore.previewRule', () => {
  it('previewRule counts matching events and distinct targets', async () => {
    store = new GraphStore()
    const r = await store.ingest(fixture())
    const rule: Rule = {
      id: 'preview-root', category: 'root', confidence: 0.8, rationale: 'root path',
      enabled: true, source: 'project',
      match: { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su$|magisk' },
    }
    const out = await store.previewRule(r.runId, rule)
    expect(out.events).toBe(2)  // both openat events match
    expect(out.targets).toBe(1) // both fold to the one native block
  })

  it('previewRule returns zeros when nothing matches', async () => {
    store = new GraphStore()
    const r = await store.ingest(fixture())
    const rule: Rule = {
      id: 'preview-none', category: 'root', confidence: 0.8, rationale: 'x',
      enabled: true, source: 'project',
      match: { syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x10' },
    }
    expect(await store.previewRule(r.runId, rule)).toEqual({ events: 0, targets: 0 })
  })
})
