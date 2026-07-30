import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../src/main/graph-store'
import { parseJsonl, isSyscall, isCall } from '@shared/anubee-parse'
import { foldEvents, foldFuncEvents, chainOfCfi, coOccur, chainOf, setsFromChain, type GraphSlice } from '@shared/graph-shape'
import type { Rule } from '@shared/rasp-heuristics'

// A trace with 2 root-check bridges (java + native), 1 java-less read, a
// non-syscall `lib` record, and a deliberately malformed line. Placeholder
// identifiers only.
const LINES = [
  JSON.stringify({ type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat', args: ['0x1'], retval: 7, string_args: { '1': '/system/bin/su' }, fd_args: {}, decoded_args: {}, stack_id: 11, java_stack: ['com.example.app.RootCheck.run'], backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }] }),
  JSON.stringify({ type: 'syscall', id: 2, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat', args: ['0x1'], retval: -2, string_args: { '1': '/sbin/magisk' }, fd_args: {}, decoded_args: {}, stack_id: 11, java_stack: ['com.example.app.RootCheck.run'], backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }] }),
  JSON.stringify({ type: 'syscall', id: 3, pid: 100, tid: 202, syscall_nr: 62, syscall: 'read', args: ['0x5'], retval: 128, string_args: {}, fd_args: { '0': '/proc/self/status' }, decoded_args: {}, backtrace: [{ frame: 0, addr: '0x9', symbol: 'libc.so!read+0x8' }] }),
  JSON.stringify({ type: 'syscall', id: 4, pid: 100, tid: 202, syscall_nr: 203, syscall: 'connect', args: ['0x7b'], retval: -111, string_args: {}, fd_args: { '0': 'fd=123 <anon_inode:[eventfd]>' }, decoded_args: {}, sock_addr: 'unix:@/frida-zymbiote-abc', backtrace: [{ frame: 0, addr: '0x9', symbol: 'libc.so!connect+0x8' }] }),
  JSON.stringify({ type: 'lib', pid: 100, library: 'libexample.so' }),
  '{bad line to prove tolerance}',
]

let dir: string
let store: GraphStore | undefined

function fixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'anubee-store-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, LINES.join('\n') + '\n')
  return p
}

const FUNCS_LINES = [
  JSON.stringify({ type: 'call', id: 1, pid: 100, tid: 101, module: 'libexample.so', symbol: 'checkRoot', entry_addr: '0x1000', args: ['0x1'], string_args: {}, fd_args: {}, sock_args: {}, backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libexample.so!checkRoot' }, { frame: 1, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }] }),
  JSON.stringify({ type: 'return', id: 1, pid: 100, tid: 101, module: 'libexample.so', symbol: 'checkRoot', offset: 4096, retval: 1, elapsed_ns: 2300, backtrace: [{ frame: 0, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }], out_args: {} }),
]

function funcsFixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'anubee-funcs-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, FUNCS_LINES.join('\n') + '\n')
  return p
}

// Two syscalls that SHARE one native node (libexample.so!tramp) but diverge
// to different syscalls/java callers - the exact shared-native-node diamond
// topology the highlightSets fix guards against leaking across.
const DIAMOND_LINES = [
  JSON.stringify({ type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat', args: ['0x1'], retval: 3, string_args: {}, fd_args: {}, decoded_args: {}, java_stack: ['com.example.A.a'], backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!tramp+0x8' }] }),
  JSON.stringify({ type: 'syscall', id: 2, pid: 100, tid: 101, syscall_nr: 63, syscall: 'read', args: ['0x5'], retval: 8, string_args: {}, fd_args: {}, decoded_args: {}, java_stack: ['com.example.B.b'], backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!tramp+0x8' }] }),
]

function diamondFixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'anubee-diamond-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, DIAMOND_LINES.join('\n') + '\n')
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
    expect(r.eventCount).toBe(4) // 4 syscalls
    expect(r.errors).toBe(1) // the malformed line only (lib is neither event nor error)
  })
})

describe('GraphStore.ingest funcs', () => {
  it('reports funcs kind and counts calls; call and return share the tracer id', async () => {
    store = new GraphStore()
    const r = await store.ingest(funcsFixture())
    expect(r.kinds).toEqual(['funcs'])
    expect(r.eventCount).toBe(1) // 1 call (returns are not listable events)
    const ids = await store.raw(`SELECT type, id FROM ev WHERE type IN ('call','return') ORDER BY type`)
    expect(ids.map(row => Number(row.id))).toEqual([1, 1]) // call id 1, return id 1 (shared)
  })
})

describe('GraphStore.table', () => {
  it('returns rows with derived hasJava / topJava / topNative', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const rows = await store.table({}, { limit: 100, offset: 0 })
    expect(rows).toHaveLength(4)
    const r1 = rows.find(r => r.id === 1)!
    expect(r1.hasJava).toBe(true)
    expect(r1.topJava).toBe('com.example.app.RootCheck.run')
    expect(r1.topNative).toBe('libexample.so!check_su+0x10')
    expect(typeof r1.id).toBe('number')
    const r3 = rows.find(r => r.id === 3)!
    expect(r3.hasJava).toBe(false)
    expect(r3.topJava).toBeNull()
  })

  it('derives a primary arg (string > sock_addr > fd > decoded > raw, empty when none)', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const rows = await store.table({}, { limit: 100, offset: 0 })
    expect(rows.find(r => r.id === 1)!.arg).toBe('/system/bin/su')        // string_args
    expect(rows.find(r => r.id === 3)!.arg).toBe('/proc/self/status')     // fd_args
    expect(rows.find(r => r.id === 4)!.arg).toBe('unix:@/frida-zymbiote-abc') // sock_addr beats fd_args
  })
})

describe('GraphStore.count', () => {
  it('counts all matching events regardless of the table page window', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect(await store.count()).toBe(4) // 4 syscalls; lib + bad line excluded
    expect(await store.count({ tid: 202 })).toBe(2)
    expect(await store.count({ hasJavaStack: true })).toBe(2)
  })
})

describe('GraphStore.eventById', () => {
  it('returns one raw record as a plain SyscallEvent', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const e = await store.eventById(1) as import('@shared/events').SyscallEvent | undefined
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

describe('GraphStore.coverage', () => {
  it('returns undefined when the run has no coverage record', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect(await store.coverage()).toBeUndefined()
  })

  it('returns the run\'s coverage record when present', async () => {
    const coverageLine = JSON.stringify({
      type: 'coverage', engine: 'funcs', snaps: { total: 10, truncated: 1 },
      cfi: { walks: 5, stops: { unwind_error: 1 } },
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-store-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, [...LINES, coverageLine].join('\n') + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const cov = await store.coverage()
    expect(cov).toBeDefined()
    expect(cov!.type).toBe('coverage')
    expect(cov!.engine).toBe('funcs')
    expect(cov!.snaps).toEqual({ total: 10, truncated: 1 })
    expect(cov!.cfi).toEqual({ walks: 5, stops: { unwind_error: 1 } })
  })

  // Drift regression: read_json's explicit schema silently drops any JSON key
  // not listed in it, so a variant whose fields were missing from the schema
  // would ingest fine but come back with them silently gone (not a crash -
  // exactly the kind of drift that goes unnoticed). This proves the exempt/
  // clean/degraded fields actually survive the real DuckDB round-trip, not
  // just the TS type.
  it('round-trips an exempt coverage record (engine with no coverage surface)', async () => {
    const coverageLine = JSON.stringify({ type: 'coverage', engine: 'lib', exempt: true, reason: 'no coverage surface' })
    dir = mkdtempSync(join(tmpdir(), 'anubee-store-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, [...LINES, coverageLine].join('\n') + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const cov = await store.coverage()
    expect(cov!.exempt).toBe(true)
    expect(cov!.reason).toBe('no coverage surface')
    expect(cov!.snaps).toBeFalsy()
  })

  it('round-trips a clean coverage record', async () => {
    const coverageLine = JSON.stringify({ type: 'coverage', engine: 'syscalls', clean: true })
    dir = mkdtempSync(join(tmpdir(), 'anubee-store-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, [...LINES, coverageLine].join('\n') + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const cov = await store.coverage()
    expect(cov!.clean).toBe(true)
  })

  it('round-trips a degraded coverage record\'s fields beyond snaps/cfi', async () => {
    const coverageLine = JSON.stringify({
      type: 'coverage', engine: 'syscalls',
      drops: { ring: 5, queue: 2 }, managed_naming_off: true,
      prearm_drops: 7, depth_capped: 1, decode_partial: true,
      returns: { spans: 100, captured: 80 },
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-store-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, [...LINES, coverageLine].join('\n') + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const cov = await store.coverage()
    expect(cov!.drops).toEqual({ ring: 5, queue: 2 })
    expect(cov!.managed_naming_off).toBe(true)
    expect(cov!.prearm_drops).toBe(7)
    expect(cov!.depth_capped).toBe(1)
    expect(cov!.decode_partial).toBe(true)
    expect(cov!.returns).toEqual({ spans: 100, captured: 80 })
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

  it('merges a funcs-adapter node into the SQL node of the same id instead of duplicating it', async () => {
    // The funcs call's caller frame resolves to nat:libexample.so!check_su -
    // the same id the syscall SQL path already builds from LINES[0]/[1]'s
    // backtrace. Two GraphNode objects sharing one id would make
    // sliceToElements -> cy.add() throw; the merge must combine them into one.
    const funcsLine = JSON.stringify({
      type: 'call', pid: 100, tid: 101, module: 'libexample.so', symbol: 'derive_key', entry_addr: '0x3000',
      backtrace: [
        { frame: 0, addr: '0x3000', symbol: 'libexample.so!derive_key' },
        { frame: 1, addr: '0x1', symbol: 'libexample.so!check_su+0x10' },
      ],
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-store-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, [...LINES, funcsLine].join('\n') + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const slice = await store.slice()

    const checkSuNodes = slice.nodes.filter(n => n.id === 'nat:libexample.so!check_su')
    expect(checkSuNodes).toHaveLength(1) // not duplicated
    expect(checkSuNodes[0].count).toBe(3) // 2 syscall events + 1 funcs-adapter bump

    const funcNode = slice.nodes.find(n => n.id === 'fn:libexample.so!derive_key')
    expect(funcNode).toEqual({ id: 'fn:libexample.so!derive_key', kind: 'func', label: 'libexample.so!derive_key', module: null, count: 1 })
    const edge = slice.edges.find(e => e.id === 'nat:libexample.so!check_su=>fn:libexample.so!derive_key')
    expect(edge?.count).toBe(1)
  })

  it('collapses a managed method captured with and without a dexpc offset', async () => {
    const withOff = JSON.stringify({
      type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat',
      args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, stack_id: 11,
      java_stack: ['com.example.app.RootCheck.run+0x0'],
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }],
    })
    const noOff = JSON.stringify({
      type: 'syscall', id: 2, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat',
      args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, stack_id: 11,
      java_stack: ['com.example.app.RootCheck.run'],
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }],
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-store-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, [withOff, noOff].join('\n') + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const slice = await store.slice()

    const rc = slice.nodes.filter(n => n.id === 'java:com.example.app.RootCheck.run')
    expect(rc).toHaveLength(1)      // one method, one node
    expect(rc[0].count).toBe(2)     // both events fold into it

    // And the SQL slice still equals the pure-TS oracle for this input.
    const oracle = foldEvents(parseJsonl([withOff, noOff].join('\n')).events.filter(isSyscall))
    expect(normNodes(slice)).toEqual(normNodes(oracle))
    expect(normEdges(slice)).toEqual(normEdges(oracle))
  })

  it('uses the cfi_stack sidecar to place the outer-native caller above java', async () => {
    const sys = JSON.stringify({
      type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 29, syscall: 'ioctl',
      args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, stack_id: 11,
      java_stack: ['com.android.internal.os.Zygote.callPostForkChildHooks'],
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8' }],
    })
    const cfi = JSON.stringify({
      type: 'cfi_stack', pid: 100, tid: 101, stack_id: 11,
      cfi_backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8', kind: 'native' },
        { frame: 1, addr: '0x5', symbol: 'boot.oat!com.android.internal.os.Zygote.callPostForkChildHooks+0x28', kind: 'managed' },
        { frame: 2, addr: '0x7', symbol: 'libandroid_runtime.so!SpecializeCommon+0x69a0', kind: 'native' },
      ],
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-cfi-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, sys + '\n')
    writeFileSync(p + '.stacks', cfi + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const slice = await store.slice()

    // The outer-native caller is present and sits ABOVE the java frame.
    expect(slice.nodes.map(n => n.id)).toContain('nat:libandroid_runtime.so!SpecializeCommon')
    expect(slice.edges.find(e =>
      e.id === 'nat:libandroid_runtime.so!SpecializeCommon=>java:com.android.internal.os.Zygote.callPostForkChildHooks',
    )).toBeTruthy()
    // The java frame is NOT a root: nothing points *from* it back up to native above it,
    // and the outer-native node is a source, proving the fallback (java-as-root) was not used.
    const oracle = chainOfCfi(
      JSON.parse(cfi).cfi_backtrace, 'sys:ioctl',
    ).map(n => n.id)
    // walk the oracle chain's edges and assert each exists in the slice
    for (let i = 1; i < oracle.length; i++) {
      const id = `${oracle[i - 1]}=>${oracle[i]}`
      expect(slice.edges.find(e => e.id === id), `missing edge ${id}`).toBeTruthy()
    }
  })

  it('does not inflate counts when a stack_id has a duplicate cfi_stack sidecar row', async () => {
    // Anubee's cfi_stack dedup set is an LRU capped at 16384 entries; on long
    // runs it can legitimately re-emit a cfi_stack record for a stack_id
    // already seen. The cfi CTE must collapse these before the LEFT JOIN,
    // else one syscall row fans out into N chain rows (N = duplicate count).
    const sys = JSON.stringify({
      type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 29, syscall: 'ioctl',
      args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, stack_id: 11,
      java_stack: ['com.android.internal.os.Zygote.callPostForkChildHooks'],
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8' }],
    })
    const cfi = JSON.stringify({
      type: 'cfi_stack', pid: 100, tid: 101, stack_id: 11,
      cfi_backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8', kind: 'native' },
        { frame: 1, addr: '0x5', symbol: 'boot.oat!com.android.internal.os.Zygote.callPostForkChildHooks+0x28', kind: 'managed' },
        { frame: 2, addr: '0x7', symbol: 'libandroid_runtime.so!SpecializeCommon+0x69a0', kind: 'native' },
      ],
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-cfi-dup-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, sys + '\n')
    // Two identical cfi_stack rows for the same stack_id - the re-emit case.
    writeFileSync(p + '.stacks', cfi + '\n' + cfi + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const slice = await store.slice()

    // One syscall event in, one occurrence out - the duplicate sidecar row
    // must not fan the join into two chain rows.
    const outerNative = slice.nodes.find(n => n.id === 'nat:libandroid_runtime.so!SpecializeCommon')
    expect(outerNative?.count).toBe(1)
    const edge = slice.edges.find(e =>
      e.id === 'nat:libandroid_runtime.so!SpecializeCommon=>java:com.android.internal.os.Zygote.callPostForkChildHooks',
    )
    expect(edge?.count).toBe(1)
  })

  it('falls back to CHAIN_SQL for a syscall row whose stack_id has no cfi_stack', async () => {
    store = new GraphStore()
    await store.ingest(fixture()) // LINES: syscalls with java_stack, no .stacks sidecar
    const oracle = foldEvents(oracleEvents)
    const slice = await store.slice()
    expect(normNodes(slice)).toEqual(normNodes(oracle))
    expect(normEdges(slice)).toEqual(normEdges(oracle))
  })
})

describe('GraphStore.slice funcs', () => {
  it('matches the foldFuncEvents oracle for a funcs run', async () => {
    store = new GraphStore()
    await store.ingest(funcsFixture())
    const slice = await store.slice({})
    const calls = parseJsonl(FUNCS_LINES.join('\n')).events.filter(isCall)
    const oracle = foldFuncEvents(calls)
    const norm = (s: { nodes: { id: string; count: number }[]; edges: { id: string; count: number }[] }) => ({
      nodes: [...s.nodes].map(n => ({ id: n.id, count: n.count })).sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...s.edges].map(e => ({ id: e.id, count: e.count })).sort((a, b) => a.id.localeCompare(b.id)),
    })
    expect(norm(slice)).toEqual(norm(oracle))
  })

  it('collapses a managed method captured with and without a dexpc offset (funcs)', async () => {
    const withOff = JSON.stringify({
      type: 'call', id: 1, pid: 1, tid: 1, module: 'libexample.so', symbol: 'checkRoot', entry_addr: '0x0',
      java_stack: ['com.example.Sec.check+0x0'],
      backtrace: [{ frame: 0, addr: '0x0', symbol: 'libexample.so!checkRoot' }],
    })
    const noOff = JSON.stringify({
      type: 'call', id: 2, pid: 1, tid: 1, module: 'libexample.so', symbol: 'checkRoot', entry_addr: '0x0',
      java_stack: ['com.example.Sec.check'],
      backtrace: [{ frame: 0, addr: '0x0', symbol: 'libexample.so!checkRoot' }],
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-funcs-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, [withOff, noOff].join('\n') + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const slice = await store.slice({})

    const rc = slice.nodes.filter(n => n.id === 'java:com.example.Sec.check')
    expect(rc).toHaveLength(1)
    expect(rc[0].count).toBe(2)

    const calls = parseJsonl([withOff, noOff].join('\n')).events.filter(isCall)
    const oracle = foldFuncEvents(calls)
    const norm = (s: { nodes: { id: string; count: number }[]; edges: { id: string; count: number }[] }) => ({
      nodes: [...s.nodes].map(n => ({ id: n.id, count: n.count })).sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...s.edges].map(e => ({ id: e.id, count: e.count })).sort((a, b) => a.id.localeCompare(b.id)),
    })
    expect(norm(slice)).toEqual(norm(oracle))
  })

  it('uses cfi_stack to place the outer-native caller above a hooked funcs frame', async () => {
    const call = JSON.stringify({
      type: 'call', id: 1, pid: 1, tid: 1, module: 'libexample.so', symbol: 'checkRoot', entry_addr: '0x0', stack_id: 11,
      backtrace: [{ frame: 0, addr: '0x0', symbol: 'libexample.so!checkRoot' }],
    })
    const cfi = JSON.stringify({
      type: 'cfi_stack', pid: 1, tid: 1, stack_id: 11,
      cfi_backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libexample.so!checkRoot+0x4', kind: 'native' },
        { frame: 1, addr: '0x2', symbol: 'boot.oat!com.example.Sec.check+0x10', kind: 'managed' },
        { frame: 2, addr: '0x3', symbol: 'libandroid.so!Specialize+0x20', kind: 'native' },
      ],
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-cfi-fn-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, call + '\n')
    writeFileSync(p + '.stacks', cfi + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const slice = await store.slice({})

    const oracle = chainOfCfi(
      JSON.parse(cfi).cfi_backtrace, null, new Set(['libexample.so!checkRoot']),
    ).map(n => n.id)
    // chain: nat:libandroid.so!Specialize -> java:com.example.Sec.check -> fn:libexample.so!checkRoot
    expect(oracle).toEqual([
      'nat:libandroid.so!Specialize',
      'java:com.example.Sec.check',
      'fn:libexample.so!checkRoot',
    ])
    for (let i = 1; i < oracle.length; i++) {
      const id = `${oracle[i - 1]}=>${oracle[i]}`
      expect(slice.edges.find(e => e.id === id), `missing edge ${id}`).toBeTruthy()
    }
  })

  it('falls back to FUNCS_CHAIN_SQL for a call row whose stack_id has no cfi_stack', async () => {
    store = new GraphStore()
    await store.ingest(funcsFixture()) // FUNCS_LINES, no sidecar
    const slice = await store.slice({})
    const calls = parseJsonl(FUNCS_LINES.join('\n')).events.filter(isCall)
    const oracle = foldFuncEvents(calls)
    const norm = (s: { nodes: { id: string; count: number }[]; edges: { id: string; count: number }[] }) => ({
      nodes: [...s.nodes].map(n => ({ id: n.id, count: n.count })).sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...s.edges].map(e => ({ id: e.id, count: e.count })).sort((a, b) => a.id.localeCompare(b.id)),
    })
    expect(norm(slice)).toEqual(norm(oracle))
  })
})

const FUNCS_PAIR_LINES = [
  // checkRoot: call + return share id 1 -> folds retval/elapsed
  JSON.stringify({ type: 'call', id: 1, pid: 1, tid: 1, module: 'libexample.so', symbol: 'checkRoot', entry_addr: '0x1000', args: ['0xaa'], string_args: { '0': 'ro.debuggable' }, fd_args: {}, sock_args: {}, backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libexample.so!checkRoot' }, { frame: 1, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }] }),
  JSON.stringify({ type: 'return', id: 1, pid: 1, tid: 1, module: 'libexample.so', symbol: 'checkRoot', offset: 4096, retval: 1, elapsed_ns: 2300, backtrace: [{ frame: 0, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }], out_args: {} }),
  // two getProp invocations (distinct ids 2, 3); returns emitted out of call order
  // to prove the fold joins on shared id, not stream position
  JSON.stringify({ type: 'call', id: 2, pid: 1, tid: 2, module: 'libc.so', symbol: 'getProp', entry_addr: '0x3000', args: [], string_args: {}, fd_args: {}, sock_args: {}, backtrace: [{ frame: 0, addr: '0x3000', symbol: 'libc.so!getProp' }, { frame: 1, addr: '0x4000', symbol: 'libexample.so!checkRoot+0x8' }] }),
  JSON.stringify({ type: 'call', id: 3, pid: 1, tid: 2, module: 'libc.so', symbol: 'getProp', entry_addr: '0x3000', args: [], string_args: {}, fd_args: {}, sock_args: {}, backtrace: [{ frame: 0, addr: '0x3000', symbol: 'libc.so!getProp' }, { frame: 1, addr: '0x4000', symbol: 'libexample.so!checkRoot+0x8' }] }),
  JSON.stringify({ type: 'return', id: 3, pid: 1, tid: 2, module: 'libc.so', symbol: 'getProp', offset: 12288, retval: 7, elapsed_ns: 20, backtrace: [{ frame: 0, addr: '0x1', symbol: 'libc.so!x+0x1' }], out_args: {} }),
  JSON.stringify({ type: 'return', id: 2, pid: 1, tid: 2, module: 'libc.so', symbol: 'getProp', offset: 12288, retval: 0, elapsed_ns: 10, backtrace: [{ frame: 0, addr: '0x1', symbol: 'libc.so!x+0x1' }], out_args: {} }),
  // lonely call, no matching return -> retval/elapsed blank via LEFT JOIN
  JSON.stringify({ type: 'call', id: 4, pid: 1, tid: 3, module: 'libfoo.so', symbol: 'openThing', entry_addr: '0x5000', args: [], string_args: {}, fd_args: {}, sock_args: {}, backtrace: [{ frame: 0, addr: '0x5000', symbol: 'libfoo.so!openThing' }] }),
]

function funcsPairFixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'anubee-funcs-pair-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, FUNCS_PAIR_LINES.join('\n') + '\n')
  return p
}

describe('GraphStore.table funcs', () => {
  it('lists calls with engine tag, function, caller, and retval/elapsed folded by shared id', async () => {
    store = new GraphStore()
    await store.ingest(funcsPairFixture())
    const rows = await store.table({}, { limit: 100, offset: 0 })
    expect(rows).toHaveLength(4) // 4 calls listed, returns not listed
    const cr = rows.find(r => r.fn === 'libexample.so!checkRoot')!
    expect(cr.engine).toBe('func')
    expect(cr.caller).toBe('libc.so!__libc_init') // backtrace[1], offset stripped
    expect(cr.retval).toBe(1)
    expect(cr.elapsed).toBe(2300)
    // returns joined by shared id, not by stream order (returns were reversed)
    const gp = rows.filter(r => r.fn === 'libc.so!getProp').sort((a, b) => a.id - b.id)
    expect(gp.map(r => r.retval)).toEqual([0, 7]) // id 2 -> 0, id 3 -> 7
    const lonely = rows.find(r => r.fn === 'libfoo.so!openThing')!
    expect(lonely.retval).toBeNull()
    expect(lonely.elapsed).toBeNull()
  })

  it('counts calls only', async () => {
    store = new GraphStore()
    await store.ingest(funcsPairFixture())
    expect(await store.count()).toBe(4)
  })
})

describe('GraphStore filtering (filterToSql wired end-to-end)', () => {
  it('filters the table by hasJavaStack, tid, syscall, and library', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect((await store.table({ hasJavaStack: true }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([1, 2])
    expect((await store.table({ tid: 202 }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([3, 4])
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

  it('finds a cfi-only node (the outer-native caller absent from the syscall\'s own backtrace)', async () => {
    // Without the fix, nodeEvents' syscall branch used CHAIN_SQL only, which
    // never sees cfi_backtrace - the outer-native node from the sidecar
    // wouldn't exist in `chain` at all, so this would return [].
    const sys = JSON.stringify({
      type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 29, syscall: 'ioctl',
      args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, stack_id: 11,
      java_stack: ['com.android.internal.os.Zygote.callPostForkChildHooks'],
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8' }],
    })
    const cfi = JSON.stringify({
      type: 'cfi_stack', pid: 100, tid: 101, stack_id: 11,
      cfi_backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8', kind: 'native' },
        { frame: 1, addr: '0x5', symbol: 'boot.oat!com.android.internal.os.Zygote.callPostForkChildHooks+0x28', kind: 'managed' },
        { frame: 2, addr: '0x7', symbol: 'libandroid_runtime.so!SpecializeCommon+0x69a0', kind: 'native' },
      ],
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-cfi-nodeevents-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, sys + '\n')
    writeFileSync(p + '.stacks', cfi + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const events = await store.nodeEvents('nat:libandroid_runtime.so!SpecializeCommon')
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe(1)
  })

  it('windows records by offset and reports the true total via nodeEventCount', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    // sys:openat has 2 records (ids 1,2). Page size 1 walks them.
    expect(await store.nodeEventCount('sys:openat')).toBe(2)
    expect((await store.nodeEvents('sys:openat', {}, 1, undefined, 0)).map(e => e.id)).toEqual([1])
    expect((await store.nodeEvents('sys:openat', {}, 1, undefined, 1)).map(e => e.id)).toEqual([2])
    expect(await store.nodeEvents('sys:openat', {}, 1, undefined, 99)).toEqual([])
  })

  it('nodeEventCount respects the filter', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect(await store.nodeEventCount('sys:openat', { tid: 101 })).toBe(2)
    expect(await store.nodeEventCount('sys:openat', { tid: 999 })).toBe(0)
  })
})

const FUNCS_DETAIL_LINES = [
  JSON.stringify({ type: 'call', id: 1, pid: 9, tid: 9, ppid: 1, module: 'libexample.so', symbol: 'checkRoot', entry_addr: '0x1000', offset: 4096, caller_addr: '0x2000', args: ['0xaa'], string_args: { '0': 'ro.debuggable' }, fd_args: {}, sock_args: {}, backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libexample.so!checkRoot' }, { frame: 1, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }] }),
  JSON.stringify({ type: 'return', id: 1, pid: 9, tid: 9, module: 'libexample.so', symbol: 'checkRoot', offset: 4096, retval: 1, elapsed_ns: 2300, out_args: { '0': 'result' }, backtrace: [{ frame: 0, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }] }),
]
function funcsDetailFixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'anubee-funcs-detail-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, FUNCS_DETAIL_LINES.join('\n') + '\n')
  return p
}

describe('GraphStore funcs inspector data', () => {
  it('eventById merges the return retval/elapsed/out_args onto the call', async () => {
    store = new GraphStore()
    await store.ingest(funcsDetailFixture())
    const ev = await store.eventById(1) as import('@shared/events').FuncEvent
    expect(ev.type).toBe('call')
    expect(ev.symbol).toBe('checkRoot')
    expect(ev.string_args).toEqual({ '0': 'ro.debuggable' })
    expect(ev.retval).toBe(1)
    expect(ev.elapsed_ns).toBe(2300)
    expect(ev.out_args).toEqual({ '0': 'result' })
  })

  it('nodeEvents returns the enriched funcs calls whose chain touches a node', async () => {
    store = new GraphStore()
    await store.ingest(funcsDetailFixture())
    const fnRows = await store.nodeEvents('fn:libexample.so!checkRoot') as import('@shared/events').FuncEvent[]
    expect(fnRows).toHaveLength(1)
    expect(fnRows[0].retval).toBe(1)
    // the unhooked caller frame is a nat: node the same call passes through
    const natRows = await store.nodeEvents('nat:libc.so!__libc_init') as import('@shared/events').FuncEvent[]
    expect(natRows.map(r => r.id)).toEqual([1])
  })
})

describe('GraphStore.previewRule', () => {
  it('previewRule counts matching events and distinct targets', async () => {
    store = new GraphStore()
    const r = await store.ingest(fixture())
    const rule: Rule = {
      id: 'preview-root', category: 'root', confidence: 0.8, rationale: 'root path',
      enabled: true, source: 'project',
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su$|magisk' }],
      correlate: 'symbol+tid', maxGap: 50, mode: 'ordered', minOccurrences: 1,
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
      steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x10' }],
      correlate: 'symbol+tid', maxGap: 50, mode: 'ordered', minOccurrences: 1,
    }
    expect(await store.previewRule(r.runId, rule)).toEqual({ events: 0, targets: 0 })
  })
})

describe('GraphStore.ingest cfi sidecar', () => {
  it('loads a companion <run>.stacks sidecar into cfi_stack rows', async () => {
    const sys = JSON.stringify({
      type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 29, syscall: 'ioctl',
      args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, stack_id: 11,
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8' }],
    })
    const cfi = JSON.stringify({
      type: 'cfi_stack', pid: 100, tid: 101, stack_id: 11,
      cfi_backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8', kind: 'native' },
        { frame: 1, addr: '0x5', symbol: 'boot.oat!com.android.internal.os.Zygote.callPostForkChildHooks+0x28', kind: 'managed' },
        { frame: 2, addr: '0x7', symbol: 'libandroid_runtime.so!SpecializeCommon+0x69a0', kind: 'native' },
      ],
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-cfi-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, sys + '\n')
    writeFileSync(p + '.stacks', cfi + '\n')

    store = new GraphStore()
    await store.ingest(p)

    const n = Number((await store.raw(`SELECT count(*) n FROM ev WHERE type = 'cfi_stack'`))[0].n)
    expect(n).toBe(1)
    const len = Number((await store.raw(
      `SELECT len(cfi_backtrace) n FROM ev WHERE type = 'cfi_stack'`))[0].n)
    expect(len).toBe(3)
  })

  it('ingests normally when no .stacks sidecar is present', async () => {
    store = new GraphStore()
    const r = await store.ingest(fixture()) // existing LINES fixture, no sidecar
    expect(r.errors).toBe(1) // the one malformed line, unchanged
    const n = Number((await store.raw(`SELECT count(*) n FROM ev WHERE type = 'cfi_stack'`))[0].n)
    expect(n).toBe(0)
  })
})

describe('GraphStore.table free-text search over args', () => {
  it('matches fd_args values (the /proc/self case)', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const rows = await store.table({ text: '/proc/self' }, { limit: 10, offset: 0 })
    expect(rows.map(r => r.id)).toEqual([3])
    expect(await store.count({ text: '/proc/self' })).toBe(1)
  })

  it('matches string_args values', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const rows = await store.table({ text: 'magisk' }, { limit: 10, offset: 0 })
    expect(rows.map(r => r.id)).toEqual([2])
  })
})

describe('GraphStore.highlightSets', () => {
  it('lights only the chain through the clicked syscall, not a sibling syscall', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const r = await store.highlightSets('sys:openat')
    expect([...r.nodes].sort()).toEqual([
      'java:com.example.app.RootCheck.run', 'nat:libexample.so!check_su', 'sys:openat'])
    expect(r.nodes).not.toContain('sys:read')
    expect([...r.edges].sort()).toEqual([
      'java:com.example.app.RootCheck.run=>nat:libexample.so!check_su',
      'nat:libexample.so!check_su=>sys:openat'])
  })

  it('a java-less syscall lights just its native fan-in', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const r = await store.highlightSets('sys:read')
    expect([...r.nodes].sort()).toEqual(['nat:libc.so!read', 'sys:read'])
  })

  it('matches the coOccur oracle over the same events', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const events = parseJsonl(LINES.join('\n')).events.filter(isSyscall)
    const store_r = await store.highlightSets('nat:libexample.so!check_su')
    const oracle = coOccur(events, 'nat:libexample.so!check_su')
    expect([...store_r.nodes].sort()).toEqual([...oracle.nodes].sort())
    expect([...store_r.edges].sort()).toEqual([...oracle.edges].sort())
  })

  it('does not leak a sibling syscall reached through a shared native node', async () => {
    store = new GraphStore()
    await store.ingest(diamondFixture())
    const r = await store.highlightSets('sys:openat')
    expect([...r.nodes].sort()).toEqual(['java:com.example.A.a', 'nat:libexample.so!tramp', 'sys:openat'])
    expect(r.nodes).not.toContain('sys:read')
    expect(r.nodes).not.toContain('java:com.example.B.b')
    // the shared native node, clicked, lights BOTH branches
    const shared = await store.highlightSets('nat:libexample.so!tramp')
    expect([...shared.nodes].sort()).toEqual([
      'java:com.example.A.a', 'java:com.example.B.b', 'nat:libexample.so!tramp', 'sys:openat', 'sys:read'])
  })
})

describe('GraphStore.recordChain', () => {
  it('returns the selected syscall record\'s own chain, matching the fold oracle', async () => {
    store = new GraphStore()
    const p = fixture()
    await store.ingest(p)
    const r = await store.recordChain(1)
    // Oracle: event id 1's own chain (java RootCheck.run -> native check_su -> openat),
    // folded to sets exactly as recordChain does.
    const ev1 = parseJsonl(LINES.join('\n')).events.filter(isSyscall).find(e => e.id === 1)!
    const oracle = setsFromChain(chainOf(ev1).map(c => c.id))
    expect([...r.nodes].sort()).toEqual([...oracle.nodes].sort())
    expect([...r.edges].sort()).toEqual([...oracle.edges].sort())
    // Strict subset of the slice the graph is actually drawn with (the record's bridge),
    // not the unfiltered slice.
    const slice = await store.slice({ text: 'com.example.app.RootCheck.run', hasJavaStack: true }, undefined)
    const sliceNodeIds = new Set(slice.nodes.map(n => n.id))
    const sliceEdgeIds = new Set(slice.edges.map(e => e.id))
    for (const n of r.nodes) expect(sliceNodeIds.has(n)).toBe(true)
    for (const e of r.edges) expect(sliceEdgeIds.has(e)).toBe(true)
  })

  it('returns empty sets for an unknown id', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    expect(await store.recordChain(9999)).toEqual({ nodes: [], edges: [] })
  })

  it('returns a funcs call record\'s chain on a funcs run', async () => {
    store = new GraphStore()
    await store.ingest(funcsFixture())
    const r = await store.recordChain(1)
    expect(r.nodes).toContain('fn:libexample.so!checkRoot')
    // subset of the funcs slice
    const slice = await store.slice({}, undefined)
    const ids = new Set(slice.nodes.map(n => n.id))
    for (const n of r.nodes) expect(ids.has(n)).toBe(true)
  })

  it('uses the cfi_stack sidecar chain for a record whose stack_id has one', async () => {
    const sys = JSON.stringify({
      type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 29, syscall: 'ioctl',
      args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, stack_id: 11,
      java_stack: ['com.android.internal.os.Zygote.callPostForkChildHooks'],
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8' }],
    })
    const cfi = JSON.stringify({
      type: 'cfi_stack', pid: 100, tid: 101, stack_id: 11,
      cfi_backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__ioctl+0x8', kind: 'native' },
        { frame: 1, addr: '0x5', symbol: 'boot.oat!com.android.internal.os.Zygote.callPostForkChildHooks+0x28', kind: 'managed' },
        { frame: 2, addr: '0x7', symbol: 'libandroid_runtime.so!SpecializeCommon+0x69a0', kind: 'native' },
      ],
    })
    dir = mkdtempSync(join(tmpdir(), 'anubee-cfi-record-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, sys + '\n')
    writeFileSync(p + '.stacks', cfi + '\n')
    store = new GraphStore()
    await store.ingest(p)
    const r = await store.recordChain(1)
    // CFI-recovered chain (includes the outer-native SpecializeCommon caller the FP
    // backtrace drops), folded to sets exactly as recordChain does.
    const oracle = setsFromChain(chainOfCfi(JSON.parse(cfi).cfi_backtrace, 'sys:ioctl').map(n => n.id))
    expect([...r.nodes].sort()).toEqual([...oracle.nodes].sort())
    expect([...r.edges].sort()).toEqual([...oracle.edges].sort())
    // The CFI-only outer-native caller is present (proves the CFI path, not the FP fallback).
    expect(r.nodes).toContain('nat:libandroid_runtime.so!SpecializeCommon')
  })
})
