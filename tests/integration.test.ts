import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
