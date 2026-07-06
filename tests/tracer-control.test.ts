import { describe, it, expect } from 'vitest'
import { preflight, startRun, type Adb, type Spawner } from '../src/main/tracer-control'

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

function fakeSpawner(): Spawner & { lastArgs: string[]; emitLine: (l: string) => void; exit: (c: number) => void } {
  let lineCb: (l: string) => void = () => {}
  let exitCb: (c: number) => void = () => {}
  const self = {
    lastArgs: [] as string[],
    emitLine: (l: string) => lineCb(l),
    exit: (c: number) => exitCb(c),
    spawn(args: string[]) {
      self.lastArgs = args
      return {
        onLine(cb: (l: string) => void) { lineCb = cb },
        onExit(cb: (c: number) => void) { exitCb = cb },
        kill() {},
      }
    },
  }
  return self
}

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
