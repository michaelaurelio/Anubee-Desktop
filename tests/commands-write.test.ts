import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCommands, type CommandCtx } from '../src/main/commands'
import { GraphStore } from '../src/main/graph-store'

const LINES = [
  JSON.stringify({ type: 'lib', pid: 100, library: '/data/app/libexample.so', start: '0x2000', end: '0x3000', pgoff: 4096 }),
  JSON.stringify({ type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat', args: ['0x1'], retval: 7, string_args: { '1': '/system/bin/su' }, fd_args: {}, decoded_args: {}, stack_id: 11, java_stack: ['com.example.app.RootCheck.run+0x1a', 'com.example.app.Main.go'], backtrace: [{ frame: 0, addr: '0x2a10', symbol: 'libexample.so!check_su+0x10' }, { frame: 1, addr: '0x9', symbol: 'libc.so!read+0x8' }] }),
]

let dir: string
function fixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'anubee-cmdw-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, LINES.join('\n') + '\n')
  return p
}
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function ctxFor(store: GraphStore): CommandCtx {
  return {
    store,
    runFileOf: (rid: number) => {
      const r = store.runs().find(x => x.runId === rid)
      if (!r) throw new Error('unknown run')
      return { file: r.file, ingestedAt: r.ingestedAt } as { file: string }
    },
    loadPath: (path: string, _broadcast: boolean) => store.ingest(path),
  }
}

describe('write + path-load commands', () => {
  it('run.loadByPath ingests a fixture and backtraces emits a ghidra offset', async () => {
    const store = new GraphStore()
    const cmd = buildCommands(ctxFor(store))
    const r = await cmd['run.loadByPath']({ path: fixture() })
    expect((r as any).runId).toBe(1)
    const bt = await cmd['backtraces']({ id: 1 }) as { frames: any[] }
    const nat = bt.frames.find(f => f.kind === 'native')
    expect(nat.module_relative_offset).toMatch(/^0x[0-9a-f]+$/)
    expect(nat.module_relative_offset).toBe('0xa10')
    expect(nat.load_base).toBe('0x2000')
    expect(nat.module).toBe('libexample.so')
    expect(nat.symbol).toBe('check_su')
    const java = bt.frames.filter(f => f.kind === 'java')
    expect(java[0]).toEqual({ kind: 'java', class: 'com.example.app.RootCheck', method: 'run', dexpc: '0x1a' })
    expect(java[1]).toEqual({ kind: 'java', class: 'com.example.app.Main', method: 'go' })
    await store.close()
  })

  it('suggest.confirm mints a heuristic tag via the shared helper and suggest.reject persists a dismissal', async () => {
    const store = new GraphStore()
    const cmd = buildCommands(ctxFor(store))
    await cmd['run.loadByPath']({ path: fixture() })
    const s = { target: 'nat:libexample.so!check_su', category: 'root', confidence: 0.9, rationale: 'su probe', offsets: [] }
    await cmd['suggest.confirm']({ runId: 1, suggestion: s, offset: '0xa10' })
    const { tags } = await cmd['tags.load']({ runId: 1 }) as any
    expect(tags).toHaveLength(1)
    expect(tags[0]).toMatchObject({ target: s.target, offset: '0xa10', source: 'heuristic', confidence: 0.9 })
    await cmd['suggest.reject']({ runId: 1, suggestion: s })
    expect(await cmd['suggest.dismissed.get']({ runId: 1 })).toEqual([{ target: s.target, category: 'root' }])
    await store.close()
  })

  it('registers the Tier-2 and Tier-3 command names', () => {
    const cmd = buildCommands(ctxFor(new GraphStore()))
    for (const n of ['run.loadByPath', 'run.loadCompareByPath', 'tags.save', 'suggest.dismissed.save', 'suggest.confirm', 'suggest.reject', 'rasp.rules.save', 'rasp.rules.preview', 'findings.export', 'backtraces',
      'capture.preflight', 'capture.start', 'capture.stop', 'nativelib.startLive', 'nativelib.stopLive', 'nativelib.verify', 'nativelib.dumpLib', 'nativelib.exportArtifact']) {
      expect(typeof cmd[n], n).toBe('function')
    }
  })
})
