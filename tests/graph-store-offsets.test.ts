import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../src/main/graph-store'

// One library mapped at base 0x1000 (two segments; lowest start wins), plus
// syscalls whose backtrace addr lands inside it. Placeholder identifiers only.
const LINES = [
  JSON.stringify({ type: 'lib', pid: 100, library: '/data/app/libexample.so', start: '0x2000', end: '0x3000', pgoff: 4096 }),
  JSON.stringify({ type: 'lib', pid: 100, library: '/data/app/libexample.so', start: '0x1000', end: '0x2000', pgoff: 0 }),
  JSON.stringify({ type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat', args: [], retval: 3, string_args: { '1': '/system/bin/su' }, fd_args: {}, decoded_args: {}, java_stack: ['com.example.Sec.check'], backtrace: [{ frame: 0, addr: '0x1010', symbol: 'libexample.so!check_su+0x10' }] }),
  JSON.stringify({ type: 'syscall', id: 2, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat', args: [], retval: 3, string_args: {}, fd_args: {}, decoded_args: {}, java_stack: ['com.example.Sec.check'], backtrace: [{ frame: 0, addr: '0x1020', symbol: 'libexample.so!check_su+0x20' }] }),
  JSON.stringify({ type: 'syscall', id: 3, pid: 100, tid: 101, syscall_nr: 62, syscall: 'read', args: [], retval: 8, string_args: {}, fd_args: {}, decoded_args: {}, java_stack: ['com.example.Sec.check'], backtrace: [{ frame: 0, addr: '0x1010', symbol: 'libexample.so!check_su+0x10' }] }),
]

let dir: string
let store: GraphStore | undefined

function fixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'ares-offsets-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, LINES.join('\n') + '\n')
  return p
}

afterEach(async () => {
  await store?.close()
  store = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('GraphStore module map', () => {
  it('ingests lib records and resolves the lowest-start load base', async () => {
    store = new GraphStore()
    const { runId, eventCount } = await store.ingest(fixture())
    expect(eventCount).toBe(3) // 3 syscalls; 2 lib records are not events
    expect(store.moduleBase(runId, 100, 'libexample.so')).toBe(0x1000n)
  })
})

describe('GraphStore.nodeOffsets', () => {
  it('returns module-relative offsets, reached syscalls, and counts', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    const rows = await store.nodeOffsets('nat:libexample.so!check_su')
    const byOffset = Object.fromEntries(rows.map(r => [r.offset, r]))

    // addr 0x1010 - base 0x1000 = 0x10, hit by openat (id 1) and read (id 3).
    expect(byOffset['0x10'].module).toBe('libexample.so')
    expect(byOffset['0x10'].symbol).toBe('check_su')
    expect(byOffset['0x10'].reaches.sort()).toEqual(['openat', 'read'])
    expect(byOffset['0x10'].count).toBe(2)

    // addr 0x1020 - base 0x1000 = 0x20, hit by openat (id 2) only.
    expect(byOffset['0x20'].reaches).toEqual(['openat'])
    expect(byOffset['0x20'].count).toBe(1)

    // Row's sample event = the first event that contributed that offset.
    expect(byOffset['0x10'].sampleEventId).toBe(1) // event id 1 (addr 0x1010) hits 0x10 first
    expect(byOffset['0x20'].sampleEventId).toBe(2) // event id 2 (addr 0x1020)
  })

  it('is empty when the module has no load base', async () => {
    store = new GraphStore()
    await store.ingest(fixture())
    // libc.so was never mapped by a lib record -> no base -> no offsets.
    expect(await store.nodeOffsets('nat:libc.so!read')).toEqual([])
  })

  it('emits [unmapped] row when the frame module is unmapped (node still appears in a chain)', async () => {
    // libother.so has no `lib` record, so nodeEvents finds the event (the node
    // appears in the chain) but moduleBase() returns undefined - this drives the
    // `base === undefined` branch, unlike the fixture-wide "no load base" case
    // above where nodeEvents already returns [] before that branch is reached.
    const noBaseLines = [
      JSON.stringify({ type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat', args: [], retval: 3, string_args: {}, fd_args: {}, decoded_args: {}, java_stack: [], backtrace: [{ frame: 0, addr: '0x500', symbol: 'libother.so!bar+0x10' }] }),
    ]
    dir = mkdtempSync(join(tmpdir(), 'ares-offsets-nobase-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, noBaseLines.join('\n') + '\n')

    store = new GraphStore()
    await store.ingest(p)
    const events = await store.nodeEvents('nat:libother.so!bar')
    expect(events).toHaveLength(1) // the node does appear in a chain
    const rows = await store.nodeOffsets('nat:libother.so!bar')
    expect(rows).toHaveLength(1)
    expect(rows[0].offset).toBe('[unmapped]')
    expect(rows[0].module).toBe('libother.so')
    expect(rows[0].reaches.length).toBeGreaterThan(0)
    expect(rows[0].count).toBe(1)
  })
})

// A single event whose backtrace has both a symbolized and an unsymbolized
// frame in the SAME mapped module, so nat:module (bare) and nat:module!symbol
// are distinct nodes fed by distinct frames. Load base 0x1000.
const MIXED_LINES = [
  JSON.stringify({ type: 'lib', pid: 200, library: '/data/app/libexample.so', start: '0x1000', end: '0x2000', pgoff: 0 }),
  JSON.stringify({ type: 'syscall', id: 1, pid: 200, tid: 201, syscall_nr: 56, syscall: 'openat', args: [], retval: 3, string_args: {}, fd_args: {}, decoded_args: {}, java_stack: [], backtrace: [
    { frame: 0, addr: '0x1900', symbol: 'libexample.so+0x900' },
    { frame: 1, addr: '0x1050', symbol: 'libexample.so!foo+0x50' },
  ] }),
]

describe('GraphStore.nodeOffsets - bare-module node vs symbolized node', () => {
  it('bare-module node only includes the unsymbolized call site', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ares-offsets-mixed-'))
    const p = join(dir, 'run.jsonl')
    writeFileSync(p, MIXED_LINES.join('\n') + '\n')

    store = new GraphStore()
    await store.ingest(p)

    const bareRows = await store.nodeOffsets('nat:libexample.so')
    expect(bareRows.map(r => r.offset)).toEqual(['0x900'])
    expect(bareRows[0].symbol).toBeNull()

    const fooRows = await store.nodeOffsets('nat:libexample.so!foo')
    expect(fooRows.map(r => r.offset)).toEqual(['0x50'])
    expect(fooRows[0].symbol).toBe('foo')
  })
})
