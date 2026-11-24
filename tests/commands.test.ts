import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCommands } from '../src/main/commands'
import { GraphStore } from '../src/main/graph-store'

const LINES = [
  JSON.stringify({ type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat', args: ['0x1'], retval: 7, string_args: { '1': '/system/bin/su' }, fd_args: {}, decoded_args: {}, stack_id: 11, java_stack: ['com.example.app.RootCheck.run'], backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }] }),
  JSON.stringify({ type: 'syscall', id: 2, pid: 100, tid: 202, syscall_nr: 62, syscall: 'read', args: ['0x5'], retval: 128, string_args: {}, fd_args: { '0': '/proc/self/status' }, decoded_args: {}, backtrace: [{ frame: 0, addr: '0x9', symbol: 'libc.so!read+0x8' }] }),
]

let dir: string
function fixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'anubee-cmd-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, LINES.join('\n') + '\n')
  return p
}

afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('buildCommands', () => {
  it('graph.runs and graph.table return the same shape as the store', async () => {
    const store = new GraphStore()
    await store.ingest(fixture())
    const cmd = buildCommands({ store, runFileOf: () => ({ file: '' }) })
    expect(await cmd['graph.runs']()).toEqual(store.runs())
    const page = { limit: 500, offset: 0 }
    expect(await cmd['graph.table']({ filter: {}, page })).toEqual(await store.table({}, page))
  })

  it('exposes every Tier-1 read command', () => {
    const store = new GraphStore()
    const cmd = buildCommands({ store, runFileOf: () => ({ file: '' }) })
    for (const n of ['graph.runs', 'graph.table', 'graph.count', 'graph.slice', 'graph.stackRollup', 'graph.eventById', 'graph.coverage', 'graph.nodeEvents', 'graph.nodeEventCount', 'graph.highlightSets', 'graph.recordChain', 'graph.nodeOffsets', 'graph.diffTable', 'graph.diffSlice', 'rasp.suggest', 'rasp.rules.get', 'tags.load', 'tags.orphans', 'suggest.dismissed.get', 'nativelib.table']) {
      expect(typeof cmd[n], n).toBe('function')
    }
  })
})
