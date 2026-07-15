import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveLibArg, dumpArg, startLive, triageDir, dumpByBase } from '../src/main/native-lib-live'
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
  it('dumpArg selects by exact base via --now, and exits 0 (no wait-for-Ctrl-C)', () => {
    const a = dumpArg(25659, '0x7281a0000', '/data/local/tmp/out')
    expect(a).toContain('dump --now -p 25659')
    expect(a).toContain('--base 0x7281a0000')
    expect(a).toContain('-o /data/local/tmp/out/manifest.jsonl')
    expect(a).not.toContain('--on-map')
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

// A spawner whose run exits with a fixed code on the next microtask, so
// `await run.done` inside dumpLibs resolves without a manual fire().
function autoSpawner(exitCode: number): Spawner {
  return { spawn: () => ({ onLine: () => {}, onExit: cb => { queueMicrotask(() => cb(exitCode)) }, kill: () => {} }) }
}
const okAdb: Adb = { run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) }

describe('triageDir', () => {
  it('returns [] when the manifest is absent', () => {
    const d = mkdtempSync(join(tmpdir(), 'ares-triage-'))
    expect(triageDir(d)).toEqual([])
    rmSync(d, { recursive: true, force: true })
  })
  it('triages listed modules from real bytes and skips a malformed manifest line', () => {
    const d = mkdtempSync(join(tmpdir(), 'ares-triage-'))
    const elf = Buffer.alloc(64); elf.set([0x7f, 0x45, 0x4c, 0x46]); elf[4] = 2; elf[5] = 1; elf[18] = 0xb7
    writeFileSync(join(d, 'libgood.so'), elf)
    writeFileSync(join(d, 'manifest.jsonl'),
      '{"type":"dump","module":"libgood.so","path":"/proc/7/libgood.so","base":"0x1000","pid":7,"raw":false}\n' +
      '{ truncated partial line\n')
    const arts = triageDir(d)
    expect(arts).toHaveLength(1)
    expect(arts[0]).toMatchObject({ module: 'libgood.so', pid: 7, arch: 'arm64', elfValid: true, raw: false })
    expect(arts[0].sha256).toHaveLength(64)
    expect(arts[0].size).toBe(64)
    rmSync(d, { recursive: true, force: true })
  })
})

describe('input validation', () => {
  it('startLive rejects an unsafe package token', () => {
    const { sp } = fakeSpawner([])
    expect(() => startLive(sp, noAdb, "com.x'; rm -rf /", () => {})).toThrow(/unsafe package/)
  })
  it('dumpByBase rejects an unsafe base token', async () => {
    const { sp } = fakeSpawner([])
    await expect(dumpByBase(sp, noAdb, 7, "a'; id", '/data/local/tmp/d', '/tmp/x', () => {}))
      .rejects.toThrow(/unsafe base token/)
  })
})

describe('dumpByBase', () => {
  it('treats a non-zero exit as a real error (not the old false alarm)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ares-dump-'))
    await expect(dumpByBase(autoSpawner(1), okAdb, 7, '0x1000', '/data/local/tmp/dev', d, () => {}))
      .rejects.toThrow(/ares dump --now exited 1/)
    rmSync(d, { recursive: true, force: true })
  })
  it('pulls and triages on a clean exit 0', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ares-dump-'))
    // the fake adb "pull" is a no-op, so pre-populate hostDir as if pulled
    const elf = Buffer.alloc(64); elf.set([0x7f, 0x45, 0x4c, 0x46]); elf[4] = 2; elf[5] = 1; elf[18] = 0xb7
    writeFileSync(join(d, 'libz.so'), elf)
    writeFileSync(join(d, 'manifest.jsonl'),
      '{"type":"dump","module":"libz.so","path":"/proc/7/libz.so","base":"0x2000","pid":7,"raw":true}\n')
    const arts = await dumpByBase(autoSpawner(0), okAdb, 7, '0x2000', '/data/local/tmp/dev', d, () => {})
    expect(arts).toHaveLength(1)
    expect(arts[0]).toMatchObject({ module: 'libz.so', raw: true, arch: 'arm64' })
    rmSync(d, { recursive: true, force: true })
  })
})
