import { describe, it, expect, vi } from 'vitest'
import { liveLibArg, dumpArg, startLive } from '../src/main/native-lib-live'
import type { Adb, Spawner } from '../src/main/tracer-control'
import type { LibLine } from '@shared/native-lib'

function fakeSpawner(lines: string[]): { sp: Spawner; fire: () => void } {
  let onLine: (l: string) => void = () => {}
  let onExit: (c: number) => void = () => {}
  const sp: Spawner = {
    spawn: () => ({
      onLine: cb => { onLine = cb },
      onExit: cb => { onExit = cb },
      kill: () => {},
    }),
  }
  return { sp, fire: () => { lines.forEach(l => onLine(l)); onExit(0) } }
}
const noAdb: Adb = { run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) }

describe('native-lib-live argv', () => {
  it('builds the live lib stream command', () => {
    expect(liveLibArg('dev.ares.detector')).toBe("su -c '/data/local/tmp/ares lib -P dev.ares.detector'")
  })
  it('builds the attach-and-dump command with -p pid', () => {
    expect(dumpArg(7420, 'libsentinel.so', '/data/local/tmp/ares-dump-X'))
      .toBe("su -c '/data/local/tmp/ares dump -p 7420 libsentinel.so -d /data/local/tmp/ares-dump-X -o /data/local/tmp/ares-dump-X/manifest.jsonl'")
  })
})

describe('startLive', () => {
  it('emits parsed lib lines with an arrival timestamp and raw for the rest', async () => {
    const { sp, fire } = fakeSpawner([
      'libbpf: loading',
      '[lib] pid 7420 /data/app/dev.ares.detector-1/lib/arm64/libsentinel.so [0x1000, 0x2000) off=0x0 inode=5 ppid=1',
    ])
    const events: Array<{ line?: LibLine; raw?: string; atMs?: number }> = []
    startLive(sp, noAdb, 'dev.ares.detector', e => events.push(e))
    fire()
    expect(events[0]).toEqual({ raw: 'libbpf: loading' })
    expect(events[1].line?.kind).toBe('lib')
    expect(typeof events[1].atMs).toBe('number')
  })
})
