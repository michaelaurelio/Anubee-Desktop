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
    // @ts-expect-error - reach into the private helper for a white-box check
    expect(store.moduleBase(runId, 100, 'libexample.so')).toBe(0x1000n)
  })
})
