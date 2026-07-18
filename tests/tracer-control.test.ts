import { describe, it, expect } from 'vitest'
import { preflight, startRun, lineSplitter, pullResult, type Adb, type Spawner } from '../src/main/tracer-control'
import { STOP_ARG } from '../src/shared/tracer-caps'

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

const cfg = { anubeeBinary: '/host/build/anubee', specsDir: '/host/specs' }

describe('preflight', () => {
  it('passes all checks and skips push when md5 matches', async () => {
    const adb = fakeAdb([
      [/get-state/, { stdout: 'device' }],
      [/id -u/, { stdout: '0' }],
      [/btf\/vmlinux/, { stdout: '/sys/kernel/btf/vmlinux' }],
      [/pm path/, { stdout: 'package:/data/app/base.apk' }],
      [/md5sum \/data\/local\/tmp\/anubee/, { stdout: 'abc123  /data/local/tmp/anubee' }],
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
      [/md5sum \/data\/local\/tmp\/anubee/, { stdout: 'stale  /data/local/tmp/anubee' }],
    ])
    const checks = await preflight(adb, cfg, 'com.android.deskclock', async () => 'fresh')
    expect(adb.calls.some(c => c.startsWith('push /host/build/anubee'))).toBe(true)
    expect(adb.calls.some(c => /pkill -KILL -f \/data\/local\/tmp\/anubee/.test(c))).toBe(true)
    expect(checks.find(c => c.id === 'binary')!.ok).toBe(true)
  })

  // Guard the stale-binary push branch against an unconfigured host: an empty or
  // unreadable anubeeBinary (md5 '') must NOT fall through to `adb push`, and an
  // empty specsDir must NOT become `adb push /.` (the whole host filesystem).
  it('fails the binary check without pushing when the host binary is unreadable (md5 empty)', async () => {
    const adb = fakeAdb([
      [/get-state/, { stdout: 'device' }],
      [/id -u/, { stdout: '0' }],
      [/btf\/vmlinux/, { stdout: '/sys/kernel/btf/vmlinux' }],
      [/pm path/, { stdout: 'package:/data/app/base.apk' }],
    ])
    const checks = await preflight(adb, cfg, 'com.android.deskclock', async () => '')
    const binary = checks.find(c => c.id === 'binary')!
    expect(binary.ok).toBe(false)
    expect(binary.detail).toMatch(/host anubee binary/i)
    expect(adb.calls.some(c => c.startsWith('push'))).toBe(false)
  })

  it('pushes the binary but skips the specs push when specsDir is empty', async () => {
    const adb = fakeAdb([
      [/get-state/, { stdout: 'device' }],
      [/id -u/, { stdout: '0' }],
      [/btf\/vmlinux/, { stdout: '/sys/kernel/btf/vmlinux' }],
      [/pm path/, { stdout: 'package:/data/app/base.apk' }],
      [/md5sum \/data\/local\/tmp\/anubee/, { stdout: 'stale  /data/local/tmp/anubee' }],
    ])
    const checks = await preflight(adb, { anubeeBinary: '/host/build/anubee', specsDir: '' }, 'com.android.deskclock', async () => 'fresh')
    const binary = checks.find(c => c.id === 'binary')!
    expect(binary.ok).toBe(true)
    expect(adb.calls.some(c => c.startsWith('push /host/build/anubee'))).toBe(true)
    expect(adb.calls.some(c => c.startsWith('push /.'))).toBe(false)
    expect(adb.calls.some(c => /push .*\/data\/local\/tmp\/specs/.test(c))).toBe(false)
  })

  it('streams each check to onCheck in order as it resolves', async () => {
    const adb = fakeAdb([
      [/get-state/, { stdout: 'device' }],
      [/id -u/, { stdout: '0' }],
      [/btf\/vmlinux/, { stdout: '/sys/kernel/btf/vmlinux' }],
      [/pm path/, { stdout: 'package:/data/app/base.apk' }],
      [/md5sum \/data\/local\/tmp\/anubee/, { stdout: 'abc123  /data/local/tmp/anubee' }],
    ])
    const streamed: string[] = []
    const checks = await preflight(adb, cfg, 'com.android.deskclock', async () => 'abc123', c => streamed.push(c.id))
    expect(streamed).toEqual(checks.map(c => c.id))
    expect(streamed).toEqual(['device', 'root', 'btf', 'package', 'binary'])
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
    const h = startRun(sp, adb, "su -c '/data/local/tmp/anubee lib com.android.deskclock'", l => lines.push(l))
    expect(sp.lastArgs).toEqual(['shell', "su -c '/data/local/tmp/anubee lib com.android.deskclock'"])
    sp.emitLine('[lib] bionic/libc.so')
    sp.exit(0)
    const res = await h.done
    expect(res.code).toBe(0)
    expect(lines).toContain('[lib] bionic/libc.so')
  })

  it('stop() sends the run-specific graceful pkill -INT via a separate su -c', async () => {
    const sp = fakeSpawner()
    const adb = fakeAdb([])
    const stopArg = "su -c 'pkill -INT -f \"^/data/local/tmp/anubee lib -P pkg$\"'"
    const h = startRun(sp, adb, "su -c '/data/local/tmp/anubee lib -P pkg'", () => {}, stopArg)
    await h.stop()
    expect(adb.calls).toContain(`shell ${stopArg}`)
    sp.exit(130)
    await h.done
  })

  it('stop() falls back to the global STOP_ARG when no stopArg is given', async () => {
    const sp = fakeSpawner()
    const adb = fakeAdb([])
    const h = startRun(sp, adb, "su -c '/data/local/tmp/anubee syscalls x'", () => {})
    await h.stop()
    expect(adb.calls).toContain(`shell ${STOP_ARG}`)
    sp.exit(130)
    await h.done
  })
})

describe('pullResult', () => {
  it('pulls a jsonl run to the host', async () => {
    const adb = fakeAdb([[/^pull /, { code: 0 }]])
    const r = await pullResult(adb, 'jsonl', '/data/local/tmp/anubee-X.jsonl', '/host/runs/anubee-X.jsonl')
    expect(r).toEqual({ kind: 'jsonl', hostPath: '/host/runs/anubee-X.jsonl' })
    expect(adb.calls).toContain('pull /data/local/tmp/anubee-X.jsonl /host/runs/anubee-X.jsonl')
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
