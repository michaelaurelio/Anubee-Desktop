import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveLibArg, dumpArg, startLive, triageDir, dumpByBase, watchArg, startWatch, pullWatchArtifacts, checkArg, checkByBases } from '../src/main/native-lib-live'
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
    expect(liveLibArg('dev.ares.detector')).toBe("su -c '/data/local/tmp/anubee lib -P dev.ares.detector'")
  })
  it('dumpArg selects by exact base via --now, and exits 0 (no wait-for-Ctrl-C)', () => {
    const a = dumpArg(25659, '0x7281a0000', '/data/local/tmp/out')
    expect(a).toContain('dump --now -p 25659')
    expect(a).toContain('--base 0x7281a0000')
    expect(a).toContain('-o /data/local/tmp/out/manifest.jsonl')
    expect(a).not.toContain('--on-map')
  })
  it('dumpArg emits balanced quotes, so the device shell can parse it', () => {
    const a = dumpArg(25659, '0x7281a0000', '/data/local/tmp/out')
    expect((a.match(/'/g) ?? []).length % 2).toBe(0)
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
// `await run.done` inside dumpByBase resolves without a manual fire().
function autoSpawner(exitCode: number): Spawner {
  return { spawn: () => ({ onLine: () => {}, onExit: cb => { queueMicrotask(() => cb(exitCode)) }, kill: () => {} }) }
}
const okAdb: Adb = { run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) }

describe('watchArg / startWatch', () => {
  it('watchArg single-quotes the glob and writes to the given dir, so the device shell cannot expand it', () => {
    // `su -c '<str>'` is re-parsed: the device's OUTER shell strips these quotes
    // and hands <str> to su, which runs it via `sh -c`. That INNER shell then
    // globs an unquoted * ? [ ] against its cwd, which is `/`. Measured on
    // device: `su -c 'echo -l s*'` -> `-l sdcard second_stage_resources storage
    // sys system system_dlkm system_ext`. So the glob must carry its own quotes
    // through the outer shell, via the '\'' close-escape-reopen idiom. -d/-o are
    // required too: the default outdir is cwd, and root (`/`) is read-only.
    expect(watchArg(25659, 'libexample*', '/data/local/tmp/anubee-onmap-20260101000000'))
      .toBe("su -c '/data/local/tmp/anubee dump -p 25659 --on-map -l '\\''libexample*'\\''" +
        " -d /data/local/tmp/anubee-onmap-20260101000000 -o /data/local/tmp/anubee-onmap-20260101000000/manifest.jsonl'")
  })

  it('watchArg emits balanced quotes, so the device shell can parse it', () => {
    // A hand-written .toBe expectation cannot catch an unbalanced quote: the
    // expectation just gets written to match the broken output. The device
    // rejects an odd count outright with "sh: no closing quote", so count them.
    for (const glob of ['libexample*', 'blob_[0-9]*', 'lib?.so']) {
      const a = watchArg(25659, glob, '/data/local/tmp/anubee-onmap-X')
      expect((a.match(/'/g) ?? []).length % 2).toBe(0)
    }
  })

  it('startWatch rejects an unsafe glob before spawning', () => {
    expect(() => startWatch(fakeSpawner([]).sp, okAdb, 1, "lib'; rm -rf /", '/data/local/tmp/d', () => {})).toThrow(/unsafe/)
  })

  it('startWatch stops with the scoped watch pattern, not the global kill', async () => {
    // okAdb is a vi.fn; inspect its .mock.calls (the real harness has no
    // .calls array). fakeSpawner([]) returns { sp, fire }.
    const adb: Adb = { run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) }
    const h = startWatch(fakeSpawner([]).sp, adb, 25659, 'libexample*', '/data/local/tmp/d', () => {})
    await h.stop()
    const calls = (adb.run as unknown as { mock: { calls: string[][][] } }).mock.calls.map(c => c[0].join(' '))
    expect(calls.some(c => c.includes('dump -p 25659 --on-map'))).toBe(true)
    expect(calls.some(c => c.includes("pkill -INT -f /data/local/tmp/anubee'"))).toBe(false) // not the global
  })
})

describe('pullWatchArtifacts', () => {
  it('returns [] when the pull fails, despite a populated dir (failed pull discriminator)', async () => {
    const failAdb: Adb = { run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such file or directory' })) }
    const d = mkdtempSync(join(tmpdir(), 'ares-onmap-'))
    // pre-populate hostDir with manifest and ELF, as if a prior pull succeeded.
    // calling pullWatchArtifacts with failAdb should still return [],
    // proving the code branches on pull failure (not just empty dir).
    const elf = Buffer.alloc(64); elf.set([0x7f, 0x45, 0x4c, 0x46]); elf[4] = 2; elf[5] = 1; elf[18] = 0xb7
    writeFileSync(join(d, 'libcaught.so'), elf)
    writeFileSync(join(d, 'manifest.jsonl'),
      '{"type":"dump","module":"libcaught.so","path":"/proc/7/libcaught.so","base":"0x3000","pid":7,"raw":false}\n')
    await expect(pullWatchArtifacts(failAdb, '/data/local/tmp/anubee-onmap-x', d)).resolves.toEqual([])
    rmSync(d, { recursive: true, force: true })
  })

  it('pulls and triages a populated dir on success', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ares-onmap-'))
    // the fake adb "pull" is a no-op, so pre-populate hostDir as if pulled
    const elf = Buffer.alloc(64); elf.set([0x7f, 0x45, 0x4c, 0x46]); elf[4] = 2; elf[5] = 1; elf[18] = 0xb7
    writeFileSync(join(d, 'libcaught.so'), elf)
    writeFileSync(join(d, 'manifest.jsonl'),
      '{"type":"dump","module":"libcaught.so","path":"/proc/7/libcaught.so","base":"0x3000","pid":7,"raw":false}\n')
    const arts = await pullWatchArtifacts(okAdb, '/data/local/tmp/anubee-onmap-x', d)
    expect(arts).toHaveLength(1)
    expect(arts[0]).toMatchObject({ module: 'libcaught.so', raw: false, arch: 'arm64' })
    rmSync(d, { recursive: true, force: true })
  })
})

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
  it('resolves the pulled .so by the manifest path basename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-'))
    const soName = 'libexample.so.21471.7284e78000.so'
    writeFileSync(join(dir, soName), 'ELF')
    writeFileSync(join(dir, 'manifest.jsonl'), JSON.stringify({
      type: 'dump',
      module: 'libexample.so',
      path: `/data/local/tmp/anubee-dump-x/${soName}`,
      base: '0x7284e78000', pid: 21471, raw: false,
    }) + '\n')
    const out = triageDir(dir)
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe(join(dir, soName))
    expect(out[0].module).toBe('libexample.so')
    rmSync(dir, { recursive: true, force: true })
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

describe('checkArg / checkByBases', () => {
  it('checkArg batches every base into one --now --check pass, exits 0', () => {
    const a = checkArg(25659, ['0x7281a0000', '0xb0'], '/data/local/tmp/anubee-check-X')
    expect(a).toContain('dump --now --check -p 25659')
    expect(a).toContain('--base 0x7281a0000')
    expect(a).toContain('--base 0xb0') // repeatable, not comma-joined
    expect(a).toContain('-o /data/local/tmp/anubee-check-X/check.jsonl')
    expect(a).not.toContain('--on-map')
    // bases are 0x-hex safe tokens: no glob metachar, so no '\'' quoting needed.
    expect(a).not.toContain("'\\''")
  })

  it('checkArg emits balanced quotes, so the device shell can parse it', () => {
    const a = checkArg(25659, ['0x7281a0000', '0xb0'], '/data/local/tmp/anubee-check-X')
    expect((a.match(/'/g) ?? []).length % 2).toBe(0)
  })

  it('checkByBases rejects an unsafe base token before spawning', async () => {
    await expect(checkByBases(fakeSpawner([]).sp, okAdb, 7, ["a'; id"], '/data/local/tmp/d', '/tmp/x', () => {}))
      .rejects.toThrow(/unsafe base token/)
  })

  it('checkByBases rejects a non-zero exit as a real error', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ares-check-'))
    await expect(checkByBases(autoSpawner(1), okAdb, 25659, ['0x1'], '/data/local/tmp/dev', d, () => {}))
      .rejects.toThrow(/ares dump --now --check exited 1/)
    rmSync(d, { recursive: true, force: true })
  })

  it('parses the pulled modcmp records on a clean exit, distinguishing real states', async () => {
    // Write a real check.jsonl into hostDir (mirroring dumpByBase's pull+triage
    // fixture setup), then assert on the actual parsed states - not a vacuous
    // Array.isArray check, which would pass even if parsing were broken.
    const d = mkdtempSync(join(tmpdir(), 'ares-check-'))
    writeFileSync(join(d, 'check.jsonl'), [
      '{"type":"modcmp","module":"libsentinel.so","path":"/data/app/~~x/base.apk","base":"0x1","pid":25659,"state":"match","mem_sha256":"aa","file_sha256":"aa"}',
      '{"type":"modcmp","module":"libfoo.so","path":"/data/local/tmp/libfoo.so","base":"0x2","pid":25659,"state":"differ","mem_sha256":"aa","file_sha256":"bb"}',
      '{"type":"modcmp","module":"libbar.so","path":"/x/libbar.so","base":"0x3","pid":25659,"state":"nofile","mem_sha256":null,"file_sha256":null}',
    ].join('\n'))
    const rs = await checkByBases(autoSpawner(0), okAdb, 25659, ['0x1', '0x2', '0x3'], '/data/local/tmp/dev', d, () => {})
    expect(rs.map(r => r.state)).toEqual(['match', 'differ', 'nofile'])
    expect(rs.map(r => r.base)).toEqual(['0x1', '0x2', '0x3'])
    rmSync(d, { recursive: true, force: true })
  })

  it('creates a not-yet-existing hostDir before pulling, since a single-file pull (unlike dumpByBase\'s whole-dir pull) needs the dir to exist first', async () => {
    // hostDir points at a subdirectory that has never been created. If
    // checkByBases' mkdirSync guard were removed, the fake pull's writeFileSync
    // below would throw ENOENT (no such directory) and this test would fail.
    const base = mkdtempSync(join(tmpdir(), 'ares-check-'))
    const hostDir = join(base, 'nested', 'deeper')
    const adb: Adb = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'pull') {
          writeFileSync(join(hostDir, 'check.jsonl'),
            '{"type":"modcmp","module":"libsentinel.so","path":"/x","base":"0x1","pid":25659,"state":"match","mem_sha256":null,"file_sha256":null}\n')
        }
        return { code: 0, stdout: '', stderr: '' }
      }),
    }
    const rs = await checkByBases(autoSpawner(0), adb, 25659, ['0x1'], '/data/local/tmp/dev', hostDir, () => {})
    expect(rs.map(r => r.state)).toEqual(['match'])
    rmSync(base, { recursive: true, force: true })
  })

  it('slices > 64 bases into multiple device passes and loses no slice\'s verdicts', async () => {
    // -o truncates on the device (fopen "w"), so each slice must complete its
    // own run+pull+parse before the next slice runs, or an earlier slice's
    // verdicts vanish when a later slice's pass overwrites check.jsonl.
    const d = mkdtempSync(join(tmpdir(), 'ares-check-'))
    const bases = Array.from({ length: 65 }, (_, i) => `0x${(i + 1).toString(16)}`)
    const spawnCalls: string[][] = []
    const sp: Spawner = {
      spawn: args => {
        spawnCalls.push(args)
        return { onLine: () => {}, onExit: cb => { queueMicrotask(() => cb(0)) }, kill: () => {} }
      },
    }
    let pullCount = 0
    const adb: Adb = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'pull') {
          pullCount++
          // Simulate the device write for THIS slice only - a real device
          // would have overwritten check.jsonl since the prior slice's pull.
          writeFileSync(join(d, 'check.jsonl'),
            `{"type":"modcmp","module":"lib${pullCount}.so","path":"/x","base":"0x${pullCount}","pid":25659,"state":"match","mem_sha256":null,"file_sha256":null}\n`)
        }
        return { code: 0, stdout: '', stderr: '' }
      }),
    }
    const rs = await checkByBases(sp, adb, 25659, bases, '/data/local/tmp/dev', d, () => {})
    const runCalls = spawnCalls.filter(a => a[0] === 'shell' && /--check/.test(a[1] ?? ''))
    expect(runCalls).toHaveLength(2) // 65 bases at a 64 cap -> two device passes
    expect((runCalls[0][1].match(/--base/g) ?? []).length).toBe(64)
    expect((runCalls[1][1].match(/--base/g) ?? []).length).toBe(1)
    // Both slices' verdicts survive in the concatenated result - neither was
    // silently lost to the next slice's device-side truncation.
    expect(rs.map(r => r.module)).toEqual(['lib1.so', 'lib2.so'])
    rmSync(d, { recursive: true, force: true })
  })
})
