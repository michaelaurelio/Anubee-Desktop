// Feature 9 orchestration (Electron main): drive the host `adb` CLI to preflight,
// deploy, run, stream, stop, and pull the ARES tracer. The adb runner is
// injected (Adb) so the logic is testable without a device. Command strings are
// built by src/shared/tracer-caps (pure).
import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { DEVICE_BIN, DEVICE_SPECS, STOP_ARG } from '@shared/tracer-caps'

export interface Adb {
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface PreflightCheck {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface TracerConfig {
  aresBinary: string
  specsDir: string
}

const DEVICE_MD5 = (out: string): string => out.trim().split(/\s+/)[0] ?? ''

export async function preflight(
  adb: Adb,
  cfg: TracerConfig,
  pkg: string,
  md5: (path: string) => Promise<string>,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []

  const state = await adb.run(['get-state'])
  const reachable = state.code === 0 && /device/.test(state.stdout)
  checks.push({ id: 'device', label: 'device reachable', ok: reachable, detail: state.stdout.trim() || state.stderr.trim() })
  if (!reachable) return checks

  const uid = await adb.run(['shell', "su -c 'id -u'"])
  const rooted = uid.stdout.trim() === '0'
  checks.push({ id: 'root', label: 'root available (su)', ok: rooted, detail: rooted ? 'uid 0' : `uid ${uid.stdout.trim()}` })
  if (!rooted) return checks

  const btf = await adb.run(['shell', "su -c 'ls /sys/kernel/btf/vmlinux'"])
  const hasBtf = /btf\/vmlinux/.test(btf.stdout)
  checks.push({ id: 'btf', label: 'kernel BTF present', ok: hasBtf, detail: hasBtf ? 'CO-RE ok' : 'missing /sys/kernel/btf/vmlinux' })
  if (!hasBtf) return checks

  const path = await adb.run(['shell', `pm path ${pkg}`])
  const installed = /package:/.test(path.stdout)
  checks.push({ id: 'package', label: `package installed (${pkg})`, ok: installed, detail: installed ? 'installed' : 'not installed' })
  if (!installed) return checks

  // Binary freshness: md5-compare, push if stale (kill_ares first -> no ETXTBSY).
  const hostSum = await md5(cfg.aresBinary)
  const devOut = await adb.run(['shell', `md5sum ${DEVICE_BIN}`])
  const devSum = DEVICE_MD5(devOut.stdout)
  if (hostSum && hostSum === devSum) {
    checks.push({ id: 'binary', label: 'on-device binary up to date', ok: true, detail: `md5 ${hostSum.slice(0, 8)}` })
  } else {
    await adb.run(['shell', "su -c 'pkill -INT -f /data/local/tmp/ares; sleep 1; pkill -KILL -f /data/local/tmp/ares'"])
    const push = await adb.run(['push', cfg.aresBinary, DEVICE_BIN])
    await adb.run(['shell', `chmod 755 ${DEVICE_BIN}`])
    await adb.run(['shell', `mkdir -p ${DEVICE_SPECS}`])
    await adb.run(['push', `${cfg.specsDir}/.`, DEVICE_SPECS])
    checks.push({ id: 'binary', label: 'binary pushed', ok: push.code === 0, detail: push.code === 0 ? 'pushed + chmod 755' : push.stderr.trim() })
  }
  return checks
}

export interface RunHandle {
  stop(): Promise<void>
  done: Promise<{ code: number }>
}

export interface Spawner {
  spawn(args: string[]): {
    onLine(cb: (line: string) => void): void
    onExit(cb: (code: number) => void): void
    kill(): void
  }
}

export function realAdb(): Adb {
  return {
    run(args) {
      return new Promise(resolve => {
        execFile('adb', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr })
        })
      })
    },
  }
}

export function realSpawner(): Spawner {
  return {
    spawn(args) {
      const child = nodeSpawn('adb', args)
      let buf = ''
      const feed = (chunk: Buffer): string[] => {
        buf += chunk.toString()
        const parts = buf.split('\n')
        buf = parts.pop() ?? ''
        return parts
      }
      let lineCb: (l: string) => void = () => {}
      child.stdout.on('data', c => feed(c).forEach(l => lineCb(l)))
      child.stderr.on('data', c => feed(c).forEach(l => lineCb(l)))
      return {
        onLine(cb) { lineCb = cb },
        onExit(cb) { child.on('close', code => { if (buf) lineCb(buf); cb(code ?? 0) }) },
        kill() { child.kill('SIGINT') },
      }
    },
  }
}

export function startRun(sp: Spawner, adb: Adb, runArg: string, onLine: (line: string) => void): RunHandle {
  const proc = sp.spawn(['shell', runArg])
  proc.onLine(onLine)
  const done = new Promise<{ code: number }>(resolve => proc.onExit(code => resolve({ code })))
  return {
    async stop() {
      // Graceful device-side stop: ares' 2-stage handler catches SIGINT. The
      // adb-shell child then sees EOF and exits on its own.
      await adb.run(['shell', STOP_ARG])
    },
    done,
  }
}
