import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { GraphStore } from '../src/main/graph-store'
import { parseJsonl, isSyscall } from '@shared/ares-parse'
import { foldEvents } from '@shared/graph-shape'

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
