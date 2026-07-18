import { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, shell } from 'electron'
import { resolve } from 'path'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { GraphStore } from './graph-store'
import type { Filter } from '@shared/filter'
import { loadTags, saveTags, loadSidecarRules, saveSidecarRules, loadDismissed, saveDismissed, sidecarPath } from './sidecar'
import type { Tag, Dismissed } from '@shared/project-store'
import { serializeSidecar } from '@shared/project-store'
import { serializeProject, parseProject, type ProjectBundle } from '@shared/project-file'
import { loadRules, saveRules } from './rasp-rules-store'
import { resolveRules, BUILTIN_RULES, validateRule, type Rule, type RuleScope } from '@shared/rasp-heuristics'
import { buildFindings, renderMarkdown, renderJSON } from '@shared/findings'
import type { SyscallEvent } from '@shared/events'
import type { DiffRow } from '@shared/diff'

// --- feature 9: tracer control -------------------------------------------
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, open } from 'node:fs/promises'
import { preflight, startRun, pullResult, realAdb, realSpawner, type RunHandle } from './tracer-control'
import { startLive, dumpByBase, startWatch, pullWatchArtifacts, checkByBases, type LiveEvent } from './native-lib-live'
import { makeBatcher, type Batcher } from '@shared/batcher'
import { loadConfig, saveConfig } from './tracer-config'
import { capById, composeRunArg, outJsonlPath, resolveSavePath, isSafePattern } from '@shared/tracer-caps'
import { isElf, specNames, type PathCheck, type PathStatus } from './path-check'
import { readdir, copyFile } from 'node:fs/promises'
import { basename } from 'node:path'

// DuckDB lives here in the main process; read_json runs on its own native
// threads, off the V8 heap, so there is no event array to ship over IPC. The
// renderer only ever asks for a table page, a bounded slice, or one record by id.
const store = new GraphStore()
let win!: BrowserWindow

const adb = realAdb()
const spawner = realSpawner()
let activeRun: RunHandle | null = null
let activeLive: RunHandle | null = null
let activeWatch: RunHandle | null = null
// Device+host dirs for the current watcher run, set at nativelib:startLive
// (when a glob is given) so either teardown path (stopLive, or activeLive's
// own stream end) can pull and triage whatever the watcher caught.
let activeWatchDirs: { deviceDir: string; hostDir: string } | null = null
// Auto-check state for the current live capture: a per-run device+host check
// dir (created unconditionally, unlike the watcher's glob-gated dir), the
// batcher that coalesces mapped bases into one dump --now --check pass, the
// stream-clock origin checkedAtMs is stamped against (kept in sync with the
// map atMs origin - see nativelib:startLive), and the pid learned from the
// first [lib] line (no pid exists yet at startLive time).
let activeCheckBatcher: Batcher<string> | null = null
let liveCheckDir: { deviceDir: string; hostDir: string } | null = null
let liveT0 = 0
let livePid = 0

async function fileMd5(path: string): Promise<string> {
  try {
    return createHash('md5').update(await readFile(path)).digest('hex')
  } catch {
    return ''
  }
}

function runsDir(): string {
  const d = resolve(app.getPath('userData'), 'runs')
  mkdirSync(d, { recursive: true })
  return d
}

// Guards the window-X path: the renderer may hold an unsaved project (dirty
// tags/dismissed/rules), so 'close' is intercepted and handed to the renderer's
// save-on-close confirmation; allowClose flips true only after the renderer
// has answered (or had nothing to save).
let allowClose = false

function createWindow(): void {
  // Dev window/taskbar icon. Absent from the packaged bundle (out/** only), where
  // electron-builder's baked-in icon from build/icon.png takes over.
  const iconPath = resolve(__dirname, '../../build/icon.png')
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.js'),
      contextIsolation: true,
    },
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(resolve(__dirname, '../renderer/index.html'))

  win.on('close', e => {
    if (allowClose) return
    e.preventDefault()
    win.webContents.send('app:confirmClose')
  })

  // Open a run given on launch (ARES_OPEN_FILE). Handy for CLI use and lets the
  // screenshot harness load a fixture without driving the native file dialog.
  const preload = process.env.ARES_OPEN_FILE
  if (preload) win.webContents.once('did-finish-load', () => void loadPath(preload))

  Menu.setApplicationMenu(null) // single in-app File▾ toolbar; no native menu bar
}

// broadcast=true tells the renderer this is the new primary run (trace:loaded ->
// activeRunId + panel refresh). A compare (run B) load passes false so it stays
// off the active-run path and doesn't repaint the primary panels.
async function ingestPath(
  path: string,
  broadcast: boolean,
): Promise<{ runId: number; eventCount: number; errors: number; kinds: ('syscall' | 'funcs')[] }> {
  const summary = await store.ingest(path, pct => win.webContents.send('trace:progress', pct))
  if (broadcast) win.webContents.send('trace:loaded', summary)
  return summary
}

function loadPath(path: string): Promise<{ runId: number; eventCount: number; errors: number; kinds: ('syscall' | 'funcs')[] }> {
  return ingestPath(path, true)
}

async function openViaDialog(
  broadcast: boolean,
): Promise<{ runId: number; eventCount: number; errors: number; kinds: ('syscall' | 'funcs')[] } | null> {
  const r = await dialog.showOpenDialog(win, {
    filters: [{ name: 'ARES JSONL', extensions: ['jsonl', 'json'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths[0]) return null
  return ingestPath(r.filePaths[0], broadcast)
}

ipcMain.handle('tracer:config:get', () => loadConfig(app.getPath('userData')))
ipcMain.handle('tracer:config:set', (_e, cfg: { aresBinary: string; specsDir: string }) => {
  saveConfig(app.getPath('userData'), cfg)
})
ipcMain.handle('tracer:preflight', (_e, pkg: string) =>
  preflight(adb, loadConfig(app.getPath('userData')), pkg, fileMd5,
    c => win.webContents.send('tracer:preflight-check', c)))

// Validate the host paths the form currently holds so the Capture view can show
// green/red dots BEFORE a run. Pure decisions live in path-check; this does the
// IO. A binary is a readable ELF file; a specs dir exists and holds a .spec file.
async function checkHostPaths(binaryPath: string, specsDir: string): Promise<PathCheck> {
  let binary: PathStatus
  if (!binaryPath) {
    binary = { ok: false, detail: 'not set' }
  } else {
    try {
      const fh = await open(binaryPath, 'r')
      try {
        const buf = Buffer.alloc(4)
        await fh.read(buf, 0, 4, 0)
        binary = isElf(buf)
          ? { ok: true, detail: basename(binaryPath) }
          : { ok: false, detail: 'not an ELF binary' }
      } finally {
        await fh.close()
      }
    } catch {
      binary = { ok: false, detail: 'cannot read file' }
    }
  }

  let specs: PathStatus
  if (!specsDir) {
    specs = { ok: false, detail: 'not set' }
  } else {
    try {
      const names = await readdir(specsDir)
      const specFiles = names.filter(n => n.endsWith('.spec'))
      specs = specFiles.length
        ? { ok: true, detail: `${specFiles.length} spec(s)` }
        : { ok: false, detail: 'no .spec files here' }
    } catch {
      specs = { ok: false, detail: 'not a directory' }
    }
  }
  return { binary, specs }
}

ipcMain.handle('tracer:checkPaths', (_e, binaryPath: string, specsDir: string) =>
  checkHostPaths(binaryPath, specsDir))

ipcMain.handle('tracer:listSpecs', async (_e, specsDir: string): Promise<string[]> => {
  if (!specsDir) return []
  try {
    return specNames(await readdir(specsDir))
  } catch {
    return []
  }
})

ipcMain.handle('tracer:pickSavePath', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save captured run as', defaultPath: 'capture.jsonl',
    filters: [{ name: 'JSONL', extensions: ['jsonl'] }],
  })
  return r.canceled ? undefined : r.filePath
})

ipcMain.handle('tracer:pickBinary', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select the host ares binary', properties: ['openFile'],
  })
  return r.canceled ? undefined : r.filePaths[0]
})

ipcMain.handle('tracer:pickSpecsDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select the host specs directory', properties: ['openDirectory'],
  })
  return r.canceled ? undefined : r.filePaths[0]
})

ipcMain.handle('tracer:start', async (_e, capId: string, vals: Record<string, unknown>, timeoutSecs?: number, savePath?: string) => {
  const cap = capById(capId)
  if (!cap) throw new Error(`unknown capability ${capId}`)
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const jsonlPath = cap.outputKind === 'jsonl' ? outJsonlPath(ts) : undefined
  const runArg = composeRunArg({ cap, vals: vals as never, timeoutSecs, jsonlPath })
  activeRun = startRun(spawner, adb, runArg, line => win.webContents.send('tracer:line', line))
  const { code } = await activeRun.done
  activeRun = null

  let runId: number | undefined
  if (cap.outputKind === 'jsonl' && jsonlPath) {
    const hostPath = resolveSavePath(savePath, resolve(runsDir(), `ares-${ts}.jsonl`))
    const pulled = await pullResult(adb, 'jsonl', jsonlPath, hostPath)
    if (pulled.hostPath) {
      const summary = await loadPath(pulled.hostPath)
      runId = summary.runId
    }
  }
  return { code, kind: cap.outputKind, runId }
})

ipcMain.handle('tracer:stop', async () => {
  if (activeRun) await activeRun.stop()
})

ipcMain.handle('trace:open', () => openViaDialog(true))
ipcMain.handle('trace:openCompare', () => openViaDialog(false))
ipcMain.handle('project:save', async (_e, runId: number, layout?: unknown) => {
  const info = store.runs().find(r => r.runId === runId)
  if (!info) return { error: 'no run loaded' }
  const engine: 'syscall' | 'func' = info.kinds.includes('funcs') && !info.kinds.includes('syscall') ? 'func' : 'syscall'
  const bundle: ProjectBundle = {
    formatVersion: 1, savedAt: new Date().toISOString(),
    run: { path: info.file, engine, eventCount: info.eventCount },
    tags: loadTags(info.file).tags,
    dismissed: loadDismissed(info.file),
    ruleOverrides: loadSidecarRules(info.file).rules,
    layout,
  }
  const def = basename(info.file).replace(/\.jsonl?$/i, '') + '.aresproj.json'
  const r = await dialog.showSaveDialog(win, { defaultPath: def, filters: [{ name: 'ARES project', extensions: ['aresproj.json', 'json'] }] })
  if (r.canceled || !r.filePath) return { canceled: true }
  writeFileSync(r.filePath, serializeProject(bundle))
  return { path: r.filePath }
})

ipcMain.handle('project:open', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'ARES project', extensions: ['aresproj.json', 'json'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return { canceled: true }
  const parsed = parseProject(readFileSync(r.filePaths[0], 'utf-8'))
  if (!parsed.bundle) return { error: parsed.error ?? 'invalid project file' }
  const b = parsed.bundle
  let runPath = b.run.path
  if (!existsSync(runPath)) {
    const rel = await dialog.showOpenDialog(win, { title: `Locate the run for this project (${basename(runPath)})`, filters: [{ name: 'ARES JSONL', extensions: ['jsonl', 'json'] }], properties: ['openFile'] })
    if (rel.canceled || !rel.filePaths[0]) return { error: 'run file not found' }
    runPath = rel.filePaths[0]
  }
  // seed the run's sidecar from the bundle, then ingest (broadcasts trace:loaded -> renderer applies tags)
  writeFileSync(sidecarPath(runPath), serializeSidecar({ file: runPath, ingestedAt: b.savedAt }, b.tags, b.ruleOverrides, {}, b.dismissed))
  const summary = await loadPath(runPath)
  return { summary, layout: b.layout }
})
ipcMain.handle('app:quit', () => app.quit())
// Quit rail item and window-X both funnel through the renderer's confirm
// flow: it always answers exactly once, either 'close' (nothing to save, or
// the user resolved the prompt) or 'cancel' (stay open).
ipcMain.on('app:closeResponse', (_e, action: 'close' | 'cancel') => {
  if (action === 'cancel') return
  allowClose = true
  win.close()
})
ipcMain.on('app:requestClose', () => { win.close() })
ipcMain.handle('graph:runs', () => store.runs())
ipcMain.handle('graph:table', (_e, filter: Filter, page: { limit: number; offset: number }, runId?: number) => store.table(filter, page, runId))
ipcMain.handle('graph:count', (_e, filter: Filter, runId?: number) => store.count(filter, runId))
ipcMain.handle('graph:slice', (_e, filter: Filter, cap?: number, runId?: number) => store.slice(filter, cap, runId))
ipcMain.handle('graph:stackRollup', (_e, filter: Filter, maxChains?: number, runId?: number) =>
  store.stackRollup(filter, maxChains, runId))
ipcMain.handle('graph:eventById', (_e, id: number, runId?: number) => store.eventById(id, runId))
ipcMain.handle('graph:coverage', (_e, runId?: number) => store.coverage(runId))
ipcMain.handle('graph:nodeEvents', (_e, nodeId: string, filter: Filter, runId?: number) => store.nodeEvents(nodeId, filter, 500, runId))
ipcMain.handle('graph:nodeOffsets', (_e, nodeId: string, filter: Filter, runId?: number) =>
  store.nodeOffsets(nodeId, filter, runId))

ipcMain.handle('nativelib:table', (_e, runId?: number) => store.libTable(runId))

// Stop the watcher (if any) then pull + triage its device output dir and push
// whatever it caught to the renderer. activeWatchDirs is cleared synchronously
// before the pull's await, so a concurrent call from the other teardown path
// (stopLive vs. activeLive.done) sees it already null and no-ops - no double
// pull, no double push. pullWatchArtifacts itself never throws (the device dir
// is mkdir'd up front in nativelib:startLive, so a failed pull means a real
// device/adb fault, not "nothing matched"), but this still wraps the call so
// a rejection anywhere in the chain (e.g. adb.run itself rejecting) cannot
// escape as an unhandled rejection on this fire-and-forget teardown path.
async function pullAndPushWatchArtifacts(): Promise<void> {
  if (!activeWatchDirs) return
  const { deviceDir, hostDir } = activeWatchDirs
  activeWatchDirs = null
  try {
    const arts = await pullWatchArtifacts(adb, deviceDir, hostDir)
    if (arts.length > 0) win.webContents.send('nativelib:watchArtifacts', arts)
  } catch (e) {
    win.webContents.send('nativelib:line', `on-map artifact pull failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// Cancels any pending auto-check flush and clears the check-dir/pid state.
// Synchronous, before any await - mirrors activeWatchDirs' null-before-await
// discipline so the other teardown path (stopLive vs. activeLive.done) sees
// it already cleared and no-ops, no double fire. cancel() drops a pending
// batch outright; an already-in-flight runCheck captured its dirs as
// checkByBases arguments before this runs, so nulling liveCheckDir here is
// safe for it too.
function teardownCheck(): void {
  activeCheckBatcher?.cancel()
  activeCheckBatcher = null
  liveCheckDir = null
  livePid = 0
}

// One batched dump --now --check pass over the given bases, fire-and-forget:
// a failure lands on the device log, not as a thrown error, since this runs
// off the debounce timer (auto-check) or the Verify button - neither has a
// caller ready to catch a rejection.
async function runCheck(pid: number, bases: string[]): Promise<void> {
  if (!liveCheckDir) return
  const { deviceDir, hostDir } = liveCheckDir
  // Capture liveT0 before the await too, same as the dirs above: a concurrent
  // restart cannot swap the clock origin out from under an in-flight check.
  const t0 = liveT0
  try {
    const results = await checkByBases(spawner, adb, pid, bases, deviceDir, hostDir,
      line => win.webContents.send('nativelib:line', line))
    win.webContents.send('nativelib:checkResults', { results, atMs: Date.now() - t0 })
  } catch (e) {
    win.webContents.send('nativelib:line', `auto-check failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// The glob is validated here, at the IPC boundary, before anything is spawned:
// startWatch also guards internally (defence in depth for a pure module), but
// that guard fires from inside the [lib] stdout callback below - throwing there
// would surface as an unhandled error mid-stream, not a clean IPC rejection.
ipcMain.handle('nativelib:startLive', async (_e, pkg: string, glob?: string) => {
  if (glob && !isSafePattern(glob)) throw new Error(`unsafe on-map glob: ${glob}`)
  // The watcher dir does not depend on the pid (unlike dumpLib's per-base
  // dir), so it is created here, up front - not inside the [lib] callback
  // below, since startWatch is synchronous and called from stdout handling.
  let watchDeviceDir: string | undefined
  let watchDirs: { deviceDir: string; hostDir: string } | undefined
  if (glob) {
    const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
    watchDeviceDir = `/data/local/tmp/ares-onmap-${ts}`
    const watchHostDir = resolve(runsDir(), `ares-onmap-${ts}`)
    await adb.run(['shell', `su -c 'mkdir -p ${watchDeviceDir}'`])
    watchDirs = { deviceDir: watchDeviceDir, hostDir: watchHostDir }
  }
  // Unlike the watcher's dir, the auto-check dir is created on EVERY live
  // capture, glob or no glob - every mapped library is a candidate to check.
  const checkTs = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const checkDeviceDir = `/data/local/tmp/ares-check-${checkTs}`
  const checkHostDir = resolve(runsDir(), `ares-check-${checkTs}`)
  await adb.run(['shell', `su -c 'mkdir -p ${checkDeviceDir}'`])
  const checkDirs = { deviceDir: checkDeviceDir, hostDir: checkHostDir }
  // Coalesces a mapped-library burst into one batched check pass. livePid is
  // read at flush time (not capture time): no pid exists yet at startLive,
  // only once the first [lib] line arrives below.
  const checkBatcher = makeBatcher<string>(300, bases => { void runCheck(livePid, bases) })
  // liveT0 sits immediately before startLive (not at handler entry, above the
  // two mkdir awaits): startLive stamps its own t0 right before spawning, so
  // placing this here keeps the map atMs and checkedAtMs clocks in sync -
  // an entry-time liveT0 would drift by a device round-trip.
  liveT0 = Date.now()
  // startLive throws synchronously on an unsafe pkg token. Assign
  // activeWatchDirs only once startLive has returned without throwing, so a
  // rejected start does not orphan this run's freshly-mkdir'd dir - the next
  // run's teardown would otherwise pull a stale, unrelated directory.
  activeLive = startLive(spawner, adb, pkg, (ev: LiveEvent) => {
    if ('raw' in ev) win.webContents.send('nativelib:line', ev.raw)
    else if (ev.line.kind === 'lib') {
      win.webContents.send('nativelib:mapped', { ...ev.line, atMs: ev.atMs })
      // The pid becomes known on the first [lib] line, same as the watcher below.
      livePid = ev.line.pid
      // Queue only dumpable rows: a bracketed pseudo-path has no on-disk file
      // to compare and would just waste a slot against the 64-base cap.
      if (ev.line.library?.startsWith('/')) checkBatcher.add(ev.line.start)
      // Attach the watcher on the first [lib] line: that is where the pid becomes known.
      if (glob && watchDeviceDir && !activeWatch) {
        activeWatch = startWatch(spawner, adb, ev.line.pid, glob, watchDeviceDir, line => win.webContents.send('nativelib:watchLine', line))
      }
    } else win.webContents.send('nativelib:unmapped', { ...ev.line, atMs: ev.atMs })
  })
  activeWatchDirs = watchDirs ?? null
  liveCheckDir = checkDirs
  activeCheckBatcher = checkBatcher
  activeLive.done.then(async () => {
    activeLive = null
    teardownCheck()
    // Ack Stop immediately: artifacts arrive on their own nativelib:watchArtifacts
    // channel and the dock is independent of streaming state, so nothing depends
    // on streamEnd waiting for the watcher stop + adb pull below. Sending it here
    // also means a rejection in either await (both under the catch below) can no
    // longer strand the view in "streaming" with no way to recover.
    win.webContents.send('nativelib:streamEnd')
    if (activeWatch) { await activeWatch.stop(); activeWatch = null }
    await pullAndPushWatchArtifacts()
  }).catch(() => {})
})

ipcMain.handle('nativelib:stopLive', async () => {
  teardownCheck()
  if (activeLive) await activeLive.stop()
  if (activeWatch) { await activeWatch.stop(); activeWatch = null }
  await pullAndPushWatchArtifacts()
})

// On-demand re-check of specific bases (Verify button / re-check all). A
// memory-vs-disk check is point-in-time and does not need a live stream, so
// unlike runCheck (the auto-check path, which reuses the streaming
// liveCheckDir), this allocates its own check dir on every call - mirroring
// nativelib:dumpLib below - and works whether or not a stream is active.
ipcMain.handle('nativelib:verify', async (_e, pid: number, bases: string[]) => {
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const deviceDir = `/data/local/tmp/ares-check-${ts}`
  const hostDir = resolve(runsDir(), `ares-check-${ts}`)
  // atMs is stream-relative (same origin as a row's map time), consumed by the
  // evidence trail. Use liveT0, not Date.now(): liveT0 is module-level and not
  // reset on Stop, so `Date.now() - liveT0` stays on the map timeline even for a
  // verify run after the capture stopped. Matches runCheck's live auto-check.
  const t0 = liveT0
  try {
    const results = await checkByBases(spawner, adb, pid, bases, deviceDir, hostDir,
      line => win.webContents.send('nativelib:line', line))
    win.webContents.send('nativelib:checkResults', { results, atMs: Date.now() - t0 })
  } catch (e) {
    win.webContents.send('nativelib:line', `verify failed: ${e instanceof Error ? e.message : String(e)}`)
  }
})

ipcMain.handle('nativelib:dumpLib', async (_e, pid: number, base: string) => {
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const deviceDir = `/data/local/tmp/ares-dump-${ts}`
  const hostDir = resolve(runsDir(), `ares-dump-${ts}`)
  return dumpByBase(spawner, adb, pid, base, deviceDir, hostDir,
    line => win.webContents.send('nativelib:line', line))
})

ipcMain.handle('nativelib:revealArtifact', (_e, path: string) => { shell.showItemInFolder(path) })

ipcMain.handle('nativelib:exportArtifact', async (_e, path: string) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: basename(path) })
  if (r.canceled || !r.filePath) return { saved: false }
  await copyFile(path, r.filePath)
  return { saved: true, path: r.filePath }
})

// Copy via the main-process clipboard: navigator.clipboard is unreliable in the
// Electron renderer (permission/focus), so the popup + node menus route here.
ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))
ipcMain.handle('rasp:suggest', (_e, runId?: number) => {
  const rid = runId ?? store.runs().at(-1)?.runId
  if (rid === undefined) return []
  const global = loadRules(app.getPath('userData'))
  const project = loadSidecarRules(runFileOf(rid).file)
  const effective = resolveRules(BUILTIN_RULES, global, project)
  return store.suggest(rid, effective)
})
ipcMain.handle('rasp:rules:get', (_e, runId?: number) => {
  const rid = runId ?? store.runs().at(-1)?.runId
  const global = loadRules(app.getPath('userData'))
  const project = rid !== undefined
    ? loadSidecarRules(runFileOf(rid).file)
    : { rules: [], enabledOverrides: {} }
  const effective = resolveRules(BUILTIN_RULES, global, project)
  return { builtin: BUILTIN_RULES, global, project, effective }
})

ipcMain.handle('rasp:rules:save', (_e, scope: 'global' | 'project', ruleScope: RuleScope, runId?: number) => {
  if (scope === 'global') {
    saveRules(app.getPath('userData'), ruleScope)
    return
  }
  const rid = runId ?? store.runs().at(-1)?.runId
  if (rid === undefined) throw new Error('no active run for project-scope rules')
  const { file, ingestedAt } = runFileOf(rid)
  saveSidecarRules(file, ingestedAt, ruleScope.rules, ruleScope.enabledOverrides)
})

ipcMain.handle('rasp:rules:preview', async (_e, rule: unknown, runId?: number) => {
  const { rule: valid, error } = validateRule(rule, 'project')
  if (!valid) return { error: error ?? 'invalid rule' }
  const rid = runId ?? store.runs().at(-1)?.runId
  if (rid === undefined) return { error: 'no run loaded' }
  return store.previewRule(rid, valid)
})

ipcMain.handle('graph:diffTable', (_e, runA: number, runB: number, filter: Filter, cap?: number) =>
  store.diffTable(runA, runB, filter, cap))
ipcMain.handle('graph:diffSlice', (_e, runA: number, runB: number, nodeId: string, filter: Filter) =>
  store.diffSlice(runA, runB, nodeId, filter))

function runFileOf(runId: number): { file: string; ingestedAt: string } {
  const info = store.runs().find(r => r.runId === runId)
  if (!info) throw new Error(`unknown runId ${runId}`)
  return { file: info.file, ingestedAt: info.ingestedAt }
}

ipcMain.handle('tags:load', (_e, runId: number) => loadTags(runFileOf(runId).file))
ipcMain.handle('tags:save', (_e, runId: number, tags: Tag[]) => {
  const { file, ingestedAt } = runFileOf(runId)
  saveTags(file, ingestedAt, tags)
})
ipcMain.handle('tags:orphans', (_e, runId: number, targets: string[]) => store.orphanTargets(targets, runId))
ipcMain.handle('suggest:dismissed:get', (_e, runId: number) => loadDismissed(runFileOf(runId).file))
ipcMain.handle('suggest:dismissed:save', (_e, runId: number, dismissed: Dismissed[]) => {
  const { file, ingestedAt } = runFileOf(runId)
  saveDismissed(file, ingestedAt, dismissed)
})

ipcMain.handle('findings:export', async (_e, runId: number, format: 'md' | 'json') => {
  const { file } = runFileOf(runId)
  const { tags } = loadTags(file)
  const reps: Record<string, SyscallEvent[]> = {}
  for (const t of tags) {
    if (reps[t.target]) continue
    // findings export is a syscall-only view today; a funcs run's calls are
    // filtered out here (same shape reps has always had).
    reps[t.target] = (await store.nodeEvents(t.target, {}, 50, runId))
      .filter((e): e is SyscallEvent => e.type === 'syscall')
  }
  const findings = buildFindings(tags, reps)
  const text = format === 'md' ? renderMarkdown(findings) : renderJSON(findings)
  const r = await dialog.showSaveDialog(win, {
    defaultPath: `findings.${format}`,
    filters: [{ name: format === 'md' ? 'Markdown' : 'JSON', extensions: [format] }],
  })
  if (r.canceled || !r.filePath) return null
  writeFileSync(r.filePath, text)
  return r.filePath
})

ipcMain.handle('log:save', async (_e, text: string) => {
  const now = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}_` +
    `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
  const r = await dialog.showSaveDialog(win, {
    defaultPath: `ares_${stamp}.log`,
    filters: [{ name: 'Log', extensions: ['log'] }],
  })
  if (r.canceled || !r.filePath) return null
  writeFileSync(r.filePath, text)
  return r.filePath
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => void store.close())
