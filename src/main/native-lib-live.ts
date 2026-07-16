import { readFileSync, statSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DEVICE_BIN, isSafeToken, isSafePattern, stopArgLive, stopArgWatch } from '@shared/tracer-caps'
import { parseLibLine } from '@shared/lib-line'
import { parseElfHeader } from '@shared/elf-triage'
import { parseModcmpJsonl } from '@shared/lib-modcmp'
import type { LibLine, Artifact, DumpManifest, Modcmp } from '@shared/native-lib'
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

// `ares dump -p PID --on-map -l <glob>`: attach to the live process and dump any
// module matching <glob> the instant it maps. Catches file-backed transient
// payloads (decrypt-to-a-file-then-dlopen). It matches the RESOLVED maps path,
// so it CANNOT catch an APK-embedded library (path is base.apk) or an anonymous
// mapping (no path) - those are caught in the table / by base. The UI says so.
//
// The glob carries its own single quotes via the '\'' close-escape-reopen idiom.
// isSafePattern stops shell INJECTION, not shell EXPANSION: * ? [ ] are
// exactly the characters it allows and a shell expands. `su -c '<str>'` is
// re-parsed twice - the device's outer shell strips the quotes and hands <str>
// to su, which runs it through `sh -c`, and that inner shell globs against its
// cwd of `/`. An unquoted `-l s*` was measured on device expanding to `-l sdcard
// second_stage_resources storage sys system system_dlkm system_ext`: one wrong
// -l plus six stray positional args that dump.c folds in as extra patterns via
// ARGP_KEY_ARG, silently, with no error. Quoted, ares receives the glob intact.
export function watchArg(pid: number, glob: string, dir: string): string {
  return `su -c '${DEVICE_BIN} dump -p ${pid} --on-map -l '\\''${glob}'\\'' -d ${dir} -o ${dir}/manifest.jsonl'`
}

export function startWatch(sp: Spawner, adb: Adb, pid: number, glob: string, dir: string, onLine: (l: string) => void): RunHandle {
  if (!isSafePattern(glob)) throw new Error(`unsafe on-map glob: ${glob}`)
  return startRun(sp, adb, watchArg(pid, glob, dir), onLine, stopArgWatch(pid))
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

// `ares dump --now --check -p PID --base A --base B ...`: compare each module's
// executable memory against its on-disk baseline and emit {"type":"modcmp"}
// records to -o, writing no .so. --check requires --now (Phase 1 argp rule).
// Bases are 0x-hex (isSafeToken-clean, no glob metachar), so no shell quoting is
// needed - unlike the on-map glob. -o must be a writable dir: the device default
// outdir is cwd = / = read-only erofs.
export function checkArg(pid: number, bases: string[], dir: string): string {
  const baseArgs = bases.map(b => `--base ${b}`).join(' ')
  return `su -c '${DEVICE_BIN} dump --now --check -p ${pid} ${baseArgs} -o ${dir}/check.jsonl'`
}

// Phase 1's --base cap: a single device pass tolerates at most this many.
const CHECK_BASE_CAP = 64

// Run one batched check, pull check.jsonl, parse its modcmp records. --now
// exits 0 on success and non-zero on real failure, so code !== 0 is a correct
// error test. An empty result (nothing matched) is NOT an error - it returns
// []. `-o` opens with fopen(path, "w") on the device (../ARES/src/common/emit.c),
// which TRUNCATES: a device write from an earlier pass is gone once a later
// pass starts. Above the 64-base cap, bases are processed in slices, and each
// slice's run+pull+parse completes in full before the next slice's device pass
// begins - running every slice first and pulling once at the end would lose
// every slice's verdicts but the last.
export async function checkByBases(
  sp: Spawner, adb: Adb, pid: number, bases: string[],
  deviceDir: string, hostDir: string, onLine: (l: string) => void,
): Promise<Modcmp[]> {
  for (const b of bases) if (!isSafeToken(b)) throw new Error(`unsafe base token: ${b}`)
  if (bases.length === 0) return []
  // Unlike dumpByBase (pulls a whole dir, which adb creates), this pulls one
  // FILE - adb pull fails if hostDir doesn't exist yet.
  mkdirSync(hostDir, { recursive: true })
  const out: Modcmp[] = []
  for (let i = 0; i < bases.length; i += CHECK_BASE_CAP) {
    out.push(...await checkOneSlice(sp, adb, pid, bases.slice(i, i + CHECK_BASE_CAP), deviceDir, hostDir, onLine))
  }
  return out
}

async function checkOneSlice(
  sp: Spawner, adb: Adb, pid: number, bases: string[],
  deviceDir: string, hostDir: string, onLine: (l: string) => void,
): Promise<Modcmp[]> {
  await adb.run(['shell', `su -c 'mkdir -p ${deviceDir}'`])
  const run = startRun(sp, adb, checkArg(pid, bases, deviceDir), onLine)
  const { code } = await run.done
  if (code !== 0) throw new Error(`ares dump --now --check exited ${code}`)
  const pull = await adb.run(['pull', `${deviceDir}/check.jsonl`, `${hostDir}/check.jsonl`])
  if (pull.code !== 0) {
    // A missing file after a clean exit means nothing was written (no match) -
    // treat as empty, not a fault. A real adb error still surfaces on the log.
    onLine(`check pull: ${pull.stderr.trim() || pull.stdout.trim()}`)
    return []
  }
  return parseModcmpJsonl(readFileSync(resolve(hostDir, 'check.jsonl'), 'utf-8'))
}

// Pull the watcher's device output dir and triage it. Unlike dumpByBase, a
// failed pull must NOT throw: the caller (`nativelib:startLive` in
// src/main/index.ts) mkdir's the device dir up front, before the stream even
// starts, so the no-match case (nothing ever matched the glob) is a
// successful pull of an empty dir - no manifest, triageDir returns []. A
// failed pull here means an actual device/adb fault (disconnect mid-pull,
// etc.), and this runs on a teardown path (stopLive / activeLive.done) where
// throwing would surface as an unhandled rejection instead of a clean
// "nothing caught" result. Callers log a [] result if they want to note it.
export async function pullWatchArtifacts(adb: Adb, deviceDir: string, hostDir: string): Promise<Artifact[]> {
  const pull = await adb.run(['pull', deviceDir, hostDir])
  if (pull.code !== 0) return []
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
