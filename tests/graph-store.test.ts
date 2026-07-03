import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../src/main/graph-store'

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
