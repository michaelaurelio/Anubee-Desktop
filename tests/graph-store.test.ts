import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../src/main/graph-store'
import { parseJsonl, isSyscall, isCall } from '@shared/ares-parse'
import { foldEvents, foldFuncEvents, type GraphSlice } from '@shared/graph-shape'
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

const FUNCS_LINES = [
  JSON.stringify({ type: 'call', id: 1, pid: 100, tid: 101, module: 'libexample.so', symbol: 'checkRoot', entry_addr: '0x1000', args: ['0x1'], string_args: {}, fd_args: {}, sock_args: {}, backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libexample.so!checkRoot' }, { frame: 1, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }] }),
  JSON.stringify({ type: 'return', id: 1, pid: 100, tid: 101, module: 'libexample.so', symbol: 'checkRoot', offset: 4096, retval: 1, elapsed_ns: 2300, backtrace: [{ frame: 0, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }], out_args: {} }),
]

function funcsFixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'ares-funcs-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, FUNCS_LINES.join('\n') + '\n')
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

  it('derives a primary arg (string > fd > decoded > raw, empty when none)', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const rows = await store.table({}, { limit: 100, offset: 0 })
    expect(rows.find(r => r.id === 1)!.arg).toBe('/system/bin/su')   // string_args
    expect(rows.find(r => r.id === 3)!.arg).toBe('/proc/self/status') // fd_args
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
    dir = mkdtempSync(join(tmpdir(), 'ares-store-'))
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
    dir = mkdtempSync(join(tmpdir(), 'ares-store-'))
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
  dir = mkdtempSync(join(tmpdir(), 'ares-funcs-pair-'))
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
    dir = mkdtempSync(join(tmpdir(), 'ares-store-'))
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

const FUNCS_DETAIL_LINES = [
  JSON.stringify({ type: 'call', id: 1, pid: 9, tid: 9, ppid: 1, module: 'libexample.so', symbol: 'checkRoot', entry_addr: '0x1000', offset: 4096, caller_addr: '0x2000', args: ['0xaa'], string_args: { '0': 'ro.debuggable' }, fd_args: {}, sock_args: {}, backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libexample.so!checkRoot' }, { frame: 1, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }] }),
  JSON.stringify({ type: 'return', id: 1, pid: 9, tid: 9, module: 'libexample.so', symbol: 'checkRoot', offset: 4096, retval: 1, elapsed_ns: 2300, out_args: { '0': 'result' }, backtrace: [{ frame: 0, addr: '0x2000', symbol: 'libc.so!__libc_init+0x40' }] }),
]
function funcsDetailFixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'ares-funcs-detail-'))
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
