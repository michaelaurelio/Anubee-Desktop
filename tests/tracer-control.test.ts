import { describe, it, expect } from 'vitest'
import { preflight, startRun, startLogcat, lineSplitter, pullResult, type Adb, type Spawner } from '../src/main/tracer-control'

// A scripted fake adb: matches on the joined args, returns a canned result.
function fakeAdb(routes: Array<[RegExp, { code?: number; stdout?: string; stderr?: string }]>): Adb & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async run(args) {
      const joined = args.join(' ')
      calls.push(joined)
      for (const [re, res] of routes) {
        if (re.test(joined)) return { code: res.code ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

const cfg = { aresBinary: '/host/build/ares', specsDir: '/host/specs' }

describe('preflight', () => {
  it('passes all checks and skips push when md5 matches', async () => {
    const adb = fakeAdb([
      [/get-state/, { stdout: 'device' }],
      [/id -u/, { stdout: '0' }],
      [/btf\/vmlinux/, { stdout: '/sys/kernel/btf/vmlinux' }],
      [/pm path/, { stdout: 'package:/data/app/base.apk' }],
      [/md5sum \/data\/local\/tmp\/ares/, { stdout: 'abc123  /data/local/tmp/ares' }],
    ])
    const checks = await preflight(adb, cfg, 'com.android.deskclock', async () => 'abc123')
    expect(checks.every(c => c.ok)).toBe(true)
    expect(adb.calls.some(c => c.startsWith('push'))).toBe(false)
  })

  it('fails the root check when id -u is not 0', async () => {
    const adb = fakeAdb([
      [/get-state/, { stdout: 'device' }],
      [/id -u/, { stdout: '2000' }],
    ])
    const checks = await preflight(adb, cfg, 'com.android.deskclock', async () => 'abc123')
    const root = checks.find(c => c.id === 'root')!
    expect(root.ok).toBe(false)
  })

  it('pushes the binary when the device md5 differs', async () => {
    const adb = fakeAdb([
      [/get-state/, { stdout: 'device' }],
      [/id -u/, { stdout: '0' }],
      [/btf\/vmlinux/, { stdout: '/sys/kernel/btf/vmlinux' }],
      [/pm path/, { stdout: 'package:/data/app/base.apk' }],
      [/md5sum \/data\/local\/tmp\/ares/, { stdout: 'stale  /data/local/tmp/ares' }],
    ])
    const checks = await preflight(adb, cfg, 'com.android.deskclock', async () => 'fresh')
    expect(adb.calls.some(c => c.startsWith('push /host/build/ares'))).toBe(true)
    expect(adb.calls.some(c => /pkill -KILL -f \/data\/local\/tmp\/ares/.test(c))).toBe(true)
    expect(checks.find(c => c.id === 'binary')!.ok).toBe(true)
  })
})

function fakeSpawner(): Spawner & { lastArgs: string[]; emitLine: (l: string) => void; exit: (c: number) => void; killed: boolean } {
  let lineCb: (l: string) => void = () => {}
  let exitCb: (c: number) => void = () => {}
  const self = {
    lastArgs: [] as string[],
    emitLine: (l: string) => lineCb(l),
    exit: (c: number) => exitCb(c),
    killed: false,
    spawn(args: string[]) {
      self.lastArgs = args
      return {
        onLine(cb: (l: string) => void) { lineCb = cb },
        onExit(cb: (c: number) => void) { exitCb = cb },
        kill() { self.killed = true },
      }
    },
  }
  return self
}

describe('lineSplitter', () => {
  it('emits a line split across two push chunks once, whole', () => {
    const lines: string[] = []
    const s = lineSplitter(l => lines.push(l))
    s.push(Buffer.from('hello wor'))
    s.push(Buffer.from('ld\n'))
    expect(lines).toEqual(['hello world'])
  })

  it('keeps two independent instances from cross-contaminating on interleaved partials', () => {
    const outLines: string[] = []
    const errLines: string[] = []
    const out = lineSplitter(l => outLines.push(l))
    const err = lineSplitter(l => errLines.push(l))
    out.push(Buffer.from('hello wor'))
    err.push(Buffer.from('ERR: oops\n'))
    out.push(Buffer.from('ld\n'))
    expect(errLines).toEqual(['ERR: oops'])
    expect(outLines).toEqual(['hello world'])
  })

  it('flush() emits a trailing unterminated line', () => {
    const lines: string[] = []
    const s = lineSplitter(l => lines.push(l))
    s.push(Buffer.from('trailing, no newline'))
    expect(lines).toEqual([])
    s.flush()
    expect(lines).toEqual(['trailing, no newline'])
  })

  it('flush() on an empty buffer emits nothing', () => {
    const lines: string[] = []
    const s = lineSplitter(l => lines.push(l))
    s.flush()
    expect(lines).toEqual([])
  })
})

describe('startRun', () => {
  it('spawns adb shell with the run arg and streams lines', async () => {
    const sp = fakeSpawner()
    const adb = fakeAdb([])
    const lines: string[] = []
    const h = startRun(sp, adb, "su -c '/data/local/tmp/ares lib com.android.deskclock'", l => lines.push(l))
    expect(sp.lastArgs).toEqual(['shell', "su -c '/data/local/tmp/ares lib com.android.deskclock'"])
    sp.emitLine('[lib] bionic/libc.so')
    sp.exit(0)
    const res = await h.done
    expect(res.code).toBe(0)
    expect(lines).toContain('[lib] bionic/libc.so')
  })

  it('stop() sends the graceful pkill -INT via a separate su -c', async () => {
    const sp = fakeSpawner()
    const adb = fakeAdb([])
    const h = startRun(sp, adb, "su -c '/data/local/tmp/ares lib x'", () => {})
    await h.stop()
    expect(adb.calls).toContain("shell su -c 'pkill -INT -f /data/local/tmp/ares'")
    sp.exit(130)
    await h.done
  })
})

describe('startLogcat (EPIC E2)', () => {
  it('spawns adb logcat -s SENTINEL:I -v raw and streams every line through unfiltered', async () => {
    const sp = fakeSpawner()
    const lines: string[] = []
    const h = startLogcat(sp, l => lines.push(l))
    expect(sp.lastArgs).toEqual(['logcat', '-s', 'SENTINEL:I', '-v', 'raw'])
    sp.emitLine('--------- beginning of main')
    sp.emitLine('{"check_id":"hook-scan","technique":"hook/injection","result":"DETECTED","detail":"libc.so+0x3c","ts":1720000000000}')
    sp.exit(0)
    const res = await h.done
    expect(res.code).toBe(0)
    // startLogcat itself is a thin process wrapper (mirrors startRun) - it
    // doesn't decide what's a banner vs. a JSONL row, so both lines pass
    // through untouched. That filtering lives in index.ts's sentinel:start.
    expect(lines).toEqual([
      '--------- beginning of main',
      '{"check_id":"hook-scan","technique":"hook/injection","result":"DETECTED","detail":"libc.so+0x3c","ts":1720000000000}',
    ])
  })

  it('stop() kills the adb child directly (no device-side process to signal)', async () => {
    const sp = fakeSpawner()
    const h = startLogcat(sp, () => {})
    await h.stop()
    expect(sp.killed).toBe(true)
    sp.exit(130)
    await h.done
  })
})

describe('pullResult', () => {
  it('pulls a jsonl run to the host', async () => {
    const adb = fakeAdb([[/^pull /, { code: 0 }]])
    const r = await pullResult(adb, 'jsonl', '/data/local/tmp/ares-X.jsonl', '/host/runs/ares-X.jsonl')
    expect(r).toEqual({ kind: 'jsonl', hostPath: '/host/runs/ares-X.jsonl' })
    expect(adb.calls).toContain('pull /data/local/tmp/ares-X.jsonl /host/runs/ares-X.jsonl')
  })

  it('does not pull for a stdout run', async () => {
    const adb = fakeAdb([])
    const r = await pullResult(adb, 'stdout', '', '')
    expect(r).toEqual({ kind: 'stdout' })
    expect(adb.calls).toEqual([])
  })

  it('throws when the pull fails', async () => {
    const adb = fakeAdb([[/^pull /, { code: 1, stderr: 'no such file' }]])
    await expect(pullResult(adb, 'jsonl', '/data/local/tmp/x.jsonl', '/host/x.jsonl'))
      .rejects.toThrow(/pull failed/)
  })
})
