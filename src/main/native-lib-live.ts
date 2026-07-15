import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DEVICE_BIN, isSafeToken, stopArgLive } from '@shared/tracer-caps'
import { parseLibLine } from '@shared/lib-line'
import { parseElfHeader } from '@shared/elf-triage'
import type { LibLine, Artifact, DumpManifest } from '@shared/native-lib'
import { startRun, type Adb, type Spawner, type RunHandle } from './tracer-control'

// A live [lib]/[unlib] stream event: a parsed line with its host arrival time
// (ms since stream start), or a raw non-matching stdout line.
export type LiveEvent = { line: LibLine; atMs: number } | { raw: string }

// `ares lib -P <pkg>`: continuous mmap/munmap stream to stdout ([lib]/[unlib]).
export function liveLibArg(pkg: string): string {
  return `su -c '${DEVICE_BIN} lib -P ${pkg}'`
}

// `ares dump --now -p PID --base ADDR`: snapshot the module at this exact load
// base from the live process and exit 0. No BPF, no wait-for-Ctrl-C. -d writes
// the rebuilt .so; -o writes the manifest. Selecting by base (not name) is
// immune to per-run library renaming and is the only selector that reaches an
// APK-embedded library.
export function dumpArg(pid: number, base: string, dir: string): string {
  return `su -c '${DEVICE_BIN} dump --now -p ${pid} --base ${base} -d ${dir} -o ${dir}/manifest.jsonl'`
}

// Start the live stream. Reuses tracer-control's spawn/line plumbing; parses
// each line and stamps a host-side arrival time (the JSONL carries no clock).
export function startLive(sp: Spawner, adb: Adb, pkg: string, onEvent: (e: LiveEvent) => void): RunHandle {
  if (!isSafeToken(pkg)) throw new Error(`unsafe package token: ${pkg}`)
  const t0 = Date.now()
  return startRun(sp, adb, liveLibArg(pkg), line => {
    const parsed = parseLibLine(line)
    if (parsed) onEvent({ line: parsed, atMs: Date.now() - t0 })
    else onEvent({ raw: line })
  }, stopArgLive(pkg))
}

// Snapshot one module by base, pull the output dir, triage every rebuilt .so.
// --now exits 0 on success and non-zero on real failure, so `code !== 0` is a
// correct error test - unlike the old dump-on-exit path, which only ended when
// an external SIGINT (exit 130) arrived.
export async function dumpByBase(
  sp: Spawner, adb: Adb, pid: number, base: string,
  deviceDir: string, hostDir: string, onLine: (l: string) => void,
): Promise<Artifact[]> {
  if (!isSafeToken(base)) throw new Error(`unsafe base token: ${base}`)
  await adb.run(['shell', `su -c 'mkdir -p ${deviceDir}'`])
  const run = startRun(sp, adb, dumpArg(pid, base, deviceDir), onLine)
  const { code } = await run.done
  if (code !== 0) throw new Error(`ares dump --now exited ${code}`)
  const pull = await adb.run(['pull', deviceDir, hostDir])
  if (pull.code !== 0) throw new Error(`dump pull failed: ${pull.stderr.trim() || pull.stdout.trim()}`)
  return triageDir(hostDir)
}

// Read the pulled manifest.jsonl and triage each referenced .so on disk.
export function triageDir(hostDir: string): Artifact[] {
  const manifestPath = resolve(hostDir, 'manifest.jsonl')
  if (!existsSync(manifestPath)) return []
  const records: DumpManifest[] = []
  for (const line of readFileSync(manifestPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let rec: DumpManifest
    try { rec = JSON.parse(line) as DumpManifest } catch { continue } // skip a truncated/partial device-write line
    if (rec.type === 'dump') records.push(rec)
  }
  const out: Artifact[] = []
  for (const r of records) {
    // The manifest `path` is the device path; the pulled copy sits in hostDir
    // under the module basename.
    const base = r.module.split('/').pop() as string
    const soPath = resolve(hostDir, base)
    if (!existsSync(soPath)) continue
    const bytes = readFileSync(soPath)
    const elf = parseElfHeader(bytes)
    out.push({
      module: r.module, path: soPath, base: r.base, pid: r.pid, raw: r.raw,
      size: statSync(soPath).size, arch: elf.arch, elfValid: elf.valid,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return out
}

// Best-effort: list .so basenames actually present in a pulled dir (used when a
// manifest is absent - e.g. an older ares without -o support).
export function listSoFiles(hostDir: string): string[] {
  if (!existsSync(hostDir)) return []
  return readdirSync(hostDir).filter(f => f.endsWith('.so'))
}
