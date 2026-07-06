import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { GraphStore } from '../src/main/graph-store'
import { parseJsonl, isSyscall } from '@shared/ares-parse'
import { foldEvents } from '@shared/graph-shape'
import { presenceOf } from '../src/shared/diff'

const FIXTURE = resolve(__dirname, 'fixtures/sample.jsonl')
const store = new GraphStore()

afterAll(() => store.close())

describe('integration: load the fixture end to end', () => {
  it('ingests syscalls, tolerates the bad line, ignores the non-syscall record', async () => {
    const r = await store.ingest(FIXTURE)
    expect(r.eventCount).toBe(3) // 3 syscalls; lib + bad line excluded
    expect(r.errors).toBe(1) // the deliberately malformed line
  })

  it('reconstructs the root-check bridge and filters to java-bearing events', async () => {
    await store.ingest(FIXTURE)
    const withJava = await store.slice({ hasJavaStack: true })
    expect(withJava.eventCount).toBe(2)
    const ids = withJava.nodes.map(n => n.id)
    expect(ids).toContain('java:com.example.app.RootCheck.run')
    expect(ids).toContain('nat:libexample.so!check_su')
    expect(ids).toContain('sys:openat')
    expect(ids).not.toContain('sys:read')
  })

  it('the DuckDB slice matches the pure-TS foldEvents oracle over the whole run', async () => {
    await store.ingest(FIXTURE)
    const oracle = foldEvents(parseJsonl(readFileSync(FIXTURE, 'utf-8')).events.filter(isSyscall))
    const slice = await store.slice()
    const ids = (xs: { id: string }[]) => xs.map(x => x.id).sort()
    expect(ids(slice.nodes)).toEqual(ids(oracle.nodes))
    expect(ids(slice.edges)).toEqual(ids(oracle.edges))
    expect(slice.eventCount).toBe(oracle.eventCount)
  })

  it('filters by library and by tid', async () => {
    await store.ingest(FIXTURE)
    expect((await store.table({ library: 'libexample' }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([1, 2])
    expect((await store.table({ tid: 202 }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([3])
  })
})

function fixture(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ares-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n'))
  return p
}

const evA = { type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat',
  args: ['0xffffff9c', '0x0'], retval: 7, string_args: { '1': '/system/bin/su' },
  fd_args: {}, decoded_args: {}, java_stack: ['com.example.app.RootCheck.run'],
  backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }] }

describe('multi-run store', () => {
  it('keeps two runs addressable and returns distinct runIds', async () => {
    const store = new GraphStore()
    const a = await store.ingest(fixture([evA]))
    const b = await store.ingest(fixture([{ ...evA, syscall: 'ptrace', string_args: {} }]))
    expect(a.runId).not.toBe(b.runId)
    expect(store.runs().map(r => r.runId).sort()).toEqual([a.runId, b.runId].sort())

    const rowsA = await store.table({}, { limit: 10, offset: 0 }, a.runId)
    const rowsB = await store.table({}, { limit: 10, offset: 0 }, b.runId)
    expect(rowsA.map(r => r.syscall)).toEqual(['openat'])
    expect(rowsB.map(r => r.syscall)).toEqual(['ptrace'])
    await store.close()
  })

  it('defaults queries to the most recent run', async () => {
    const store = new GraphStore()
    await store.ingest(fixture([evA]))
    await store.ingest(fixture([{ ...evA, syscall: 'ptrace', string_args: {} }]))
    const rows = await store.table({}, { limit: 10, offset: 0 })
    expect(rows.map(r => r.syscall)).toEqual(['ptrace'])
    await store.close()
  })
})

describe('nodeEvents run scoping', () => {
  it('scopes nodeEvents to the requested run even when ids collide across runs', async () => {
    const store = new GraphStore()
    const a = await store.ingest(fixture([{ ...evA, string_args: { '1': '/system/bin/su' }, tid: 101 }]))
    const b = await store.ingest(fixture([{ ...evA, string_args: { '1': '/system/bin/su' }, tid: 999 }]))
    const events = await store.nodeEvents('sys:openat', {}, 500, b.runId)
    expect(events).toHaveLength(1)
    expect(events[0].tid).toBe(999)
    await store.close()
  })
})

describe('heuristic suggestions', () => {
  it('suggests root + debugger tags from a run', async () => {
    const store = new GraphStore()
    await store.ingest(fixture([
      evA, // openat /system/bin/su -> root
      { ...evA, id: 2, syscall: 'ptrace', args: ['0x0'], string_args: {}, backtrace: [] }, // TRACEME -> debugger
      { ...evA, id: 3, syscall: 'openat', string_args: { '1': '/data/app/ok.so' } }, // benign
    ]))
    const s = await store.suggest()
    const cats = s.map(x => x.category).sort()
    expect(cats).toContain('root')
    expect(cats).toContain('debugger')
    expect(s.find(x => x.category === 'root')!.target).toBe('nat:libexample.so!check_su')
    await store.close()
  })
})

describe('run diffing', () => {
  it('diffTable surfaces per-node presence and delta across two runs', async () => {
    const store = new GraphStore()
    const a = await store.ingest(fixture([evA])) // has nat:libexample.so!check_su + sys:openat
    const b = await store.ingest(fixture([
      { ...evA, syscall: 'read', string_args: {}, fd_args: { '0': '/proc/self/status' },
        backtrace: [{ frame: 0, addr: '0x9', symbol: 'libother.so!probe+0x4' }],
        java_stack: [] },
    ]))
    const rows = await store.diffTable(a.runId, b.runId)
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get('sys:openat')!.presence).toBe('A-only')
    expect(byId.get('sys:read')!.presence).toBe('B-only')
    await store.close()
  })

  it('diffTable orders divergent rows before shared, even when a shared row has a bigger delta', async () => {
    const store = new GraphStore()
    // Run A: the same bridge five times -> shared nodes with a large |delta|.
    const a = await store.ingest(fixture([
      evA, { ...evA, id: 2 }, { ...evA, id: 3 }, { ...evA, id: 4 }, { ...evA, id: 5 },
    ]))
    // Run B: that bridge once (shared, delta -4) + a unique bridge (B-only, delta +1).
    const b = await store.ingest(fixture([
      evA,
      { ...evA, id: 2, syscall: 'read', string_args: {}, fd_args: { '0': '/proc/self/status' },
        java_stack: ['com.example.app.Other.x'],
        backtrace: [{ frame: 0, addr: '0x9', symbol: 'libother.so!probe+0x4' }] },
    ]))
    const rows = await store.diffTable(a.runId, b.runId)
    const idx = (p: string) => rows.map((r, i) => ({ p: r.presence, i })).filter(x => x.p === p).map(x => x.i)
    const divergentIdx = rows.map((r, i) => ({ p: r.presence, i })).filter(x => x.p !== 'both').map(x => x.i)
    const bothIdx = idx('both')
    // Magnitude alone would put the shared rows first...
    const bothMax = Math.max(...rows.filter(r => r.presence === 'both').map(r => Math.abs(r.delta)))
    const divMax = Math.max(...rows.filter(r => r.presence !== 'both').map(r => Math.abs(r.delta)))
    expect(bothMax).toBeGreaterThan(divMax)
    // ...but divergence-first wins: every divergent row precedes every shared row.
    expect(Math.max(...divergentIdx)).toBeLessThan(Math.min(...bothIdx))
    await store.close()
  })

  it('diffSlice returns a merged neighbourhood tagged by origin', async () => {
    const store = new GraphStore()
    const a = await store.ingest(fixture([evA]))
    const b = await store.ingest(fixture([{ ...evA, retval: -2 }])) // same chain, run B
    const merged = await store.diffSlice(a.runId, b.runId, 'sys:openat')
    expect(merged.nodes.find(n => n.id === 'sys:openat')!.presence).toBe('both')
    await store.close()
  })

  it('diffSlice honors the active filter (filtered-out neighbour drops from the same node neighbourhood)', async () => {
    const store = new GraphStore()
    // Two events share the native node + syscall but reach it from different tids
    // and java methods. Filtering by tid must prune one java neighbour of check_su.
    const mk = () => [
      evA, // tid 101, java RootCheck.run -> nat check_su -> sys openat
      { ...evA, id: 2, tid: 202, java_stack: ['com.example.app.Other.probe'] }, // same native+syscall, other branch
    ]
    const a = await store.ingest(fixture(mk()))
    const b = await store.ingest(fixture(mk()))
    const node = 'nat:libexample.so!check_su'
    const other = 'java:com.example.app.Other.probe'
    // Unfiltered: both java branches are neighbours of check_su.
    const unfiltered = await store.diffSlice(a.runId, b.runId, node)
    expect(unfiltered.nodes.some(n => n.id === other)).toBe(true)
    // Filtered to tid 101: the tid-202 branch (Other.probe) must be pruned.
    const filtered = await store.diffSlice(a.runId, b.runId, node, { tid: 101 })
    expect(filtered.nodes.some(n => n.id === other)).toBe(false)
    await store.close()
  })
})
