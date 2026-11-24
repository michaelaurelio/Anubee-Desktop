import type { GraphStore } from './graph-store'
import type { Filter } from '@shared/filter'
import { writeFileSync, existsSync } from 'node:fs'
import { loadTags, saveTags, loadSidecarRules, saveSidecarRules, loadDismissed, saveDismissed } from './sidecar'
import { loadRules, saveRules } from './rasp-rules-store'
import { resolveRules, BUILTIN_RULES, validateRule, type RuleScope, type Suggestion } from '@shared/rasp-heuristics'
import { suggestionToTag, upsertTag, addDismissed, type Tag, type Dismissed } from '@shared/project-store'
import { buildFindings, renderMarkdown, renderJSON } from '@shared/findings'
import { parseFrameSymbol } from '@shared/frame-symbol'
import { parseHexAddr, moduleRelative, parseJavaFrame, type JavaFrame } from '@shared/origins'
import type { SyscallEvent } from '@shared/events'

export interface RunSummary { runId: number; eventCount: number; errors: number; kinds: ('syscall' | 'funcs')[] }

// Tier-3 device operations. The bodies drive adb and live module state in
// index.ts (in-flight guards live there), so main injects them here.
export interface DeviceOps {
  preflight(pkg: string): unknown
  start(capId: string, vals: Record<string, unknown>, timeoutSecs?: number, savePath?: string): unknown
  stop(discard?: boolean): unknown
  startLive(pkg: string, glob?: string): unknown
  stopLive(): unknown
  verify(pid: number, bases: string[]): unknown
  dumpLib(pid: number, base: string): unknown
  exportArtifact(path: string, dest: string): unknown
}

export type NativeFrame = { kind: 'native'; module: string; symbol: string | null; load_base: string | null; module_relative_offset: string }
export type BacktraceFrame = NativeFrame | JavaFrame

export type CommandMap = Record<string, (args?: any) => unknown | Promise<unknown>>

export interface CommandCtx {
  store: GraphStore
  runFileOf(runId: number): { file: string }
  /** Directory holding global rule files (electron userData). Only needed by rasp.* commands. */
  userDataDir?: () => string
  /** Existing ingest path (index.ts). broadcast=true drives the renderer as the primary run. */
  loadPath?: (path: string, broadcast: boolean) => Promise<RunSummary>
  device?: DeviceOps
}

type Page = { limit: number; offset: number }

export function buildCommands(ctx: CommandCtx): CommandMap {
  const { store } = ctx
  const userData = (): string => {
    if (!ctx.userDataDir) throw new Error('userDataDir not available')
    return ctx.userDataDir()
  }
  const activeRun = (runId?: number): number => {
    const rid = runId ?? store.activeRun()
    if (rid === undefined) throw new Error('no run loaded')
    return rid
  }
  const runInfo = (rid: number): { file: string; ingestedAt: string } => {
    const r = ctx.runFileOf(rid) as { file: string; ingestedAt?: string }
    return { file: r.file, ingestedAt: r.ingestedAt ?? store.runs().find(x => x.runId === rid)?.ingestedAt ?? new Date().toISOString() }
  }
  const loader = (): NonNullable<CommandCtx['loadPath']> => {
    if (!ctx.loadPath) throw new Error('loadPath not available')
    return ctx.loadPath
  }
  const dev = (): DeviceOps => {
    if (!ctx.device) throw new Error('device operations not available')
    return ctx.device
  }
  const persistDismissed = (rid: number, entries: Dismissed[]): void => {
    const { file, ingestedAt } = runInfo(rid)
    saveDismissed(file, ingestedAt, entries)
  }
  const persistTags = (rid: number, tags: Tag[]): void => {
    const { file, ingestedAt } = runInfo(rid)
    saveTags(file, ingestedAt, tags)
  }
  return {
    'graph.runs': () => store.runs(),
    'graph.table': ({ filter, page, runId }: { filter: Filter; page: Page; runId?: number }) => store.table(filter, page, runId),
    'graph.count': ({ filter, runId }: { filter: Filter; runId?: number }) => store.count(filter, runId),
    'graph.slice': ({ filter, cap, runId }: { filter: Filter; cap?: number; runId?: number }) => store.slice(filter, cap, runId),
    'graph.stackRollup': ({ filter, maxChains, runId }: { filter: Filter; maxChains?: number; runId?: number }) =>
      store.stackRollup(filter, maxChains, runId),
    'graph.eventById': ({ id, runId }: { id: number; runId?: number }) => store.eventById(id, runId),
    'graph.coverage': ({ runId }: { runId?: number } = {}) => store.coverage(runId),
    'graph.nodeEvents': ({ nodeId, filter, page, runId }: { nodeId: string; filter: Filter; page: Page; runId?: number }) =>
      store.nodeEvents(nodeId, filter, page.limit, runId, page.offset),
    'graph.nodeEventCount': ({ nodeId, filter, runId }: { nodeId: string; filter: Filter; runId?: number }) =>
      store.nodeEventCount(nodeId, filter, runId),
    'graph.highlightSets': ({ nodeId, filter, runId }: { nodeId: string; filter: Filter; runId?: number }) =>
      store.highlightSets(nodeId, filter, runId),
    'graph.recordChain': ({ id, runId }: { id: number; runId?: number }) => store.recordChain(id, runId),
    'graph.nodeOffsets': ({ nodeId, filter, runId }: { nodeId: string; filter: Filter; runId?: number }) =>
      store.nodeOffsets(nodeId, filter, runId),
    'graph.diffTable': ({ runA, runB, filter, cap }: { runA: number; runB: number; filter: Filter; cap?: number }) =>
      store.diffTable(runA, runB, filter, cap),
    'graph.diffSlice': ({ runA, runB, nodeId, filter }: { runA: number; runB: number; nodeId: string; filter: Filter }) =>
      store.diffSlice(runA, runB, nodeId, filter),
    'rasp.suggest': ({ runId }: { runId?: number } = {}) => {
      const rid = runId ?? store.activeRun()
      if (rid === undefined) return []
      const global = loadRules(userData())
      const project = loadSidecarRules(ctx.runFileOf(rid).file)
      const effective = resolveRules(BUILTIN_RULES, global, project)
      return store.suggest(rid, effective)
    },
    'rasp.rules.get': ({ runId }: { runId?: number } = {}) => {
      const rid = runId ?? store.activeRun()
      const global = loadRules(userData())
      const project = rid !== undefined
        ? loadSidecarRules(ctx.runFileOf(rid).file)
        : { rules: [], enabledOverrides: {} }
      const effective = resolveRules(BUILTIN_RULES, global, project)
      return { builtin: BUILTIN_RULES, global, project, effective }
    },
    'tags.load': ({ runId }: { runId: number }) => loadTags(ctx.runFileOf(runId).file),
    'tags.orphans': ({ runId, targets }: { runId: number; targets: string[] }) => store.orphanTargets(targets, runId),
    'suggest.dismissed.get': ({ runId }: { runId: number }) => loadDismissed(ctx.runFileOf(runId).file),
    'nativelib.table': ({ runId }: { runId?: number } = {}) => store.libTable(runId),

    // ---- Tier 2: loads and writes ----
    'run.loadByPath': ({ path }: { path: string }) => loader()(path, true),
    'run.loadCompareByPath': ({ path }: { path: string }) => loader()(path, false),
    'tags.save': ({ runId, tags }: { runId?: number; tags: Tag[] }) => persistTags(activeRun(runId), tags),
    'suggest.dismissed.save': ({ runId, dismissed }: { runId?: number; dismissed: Dismissed[] }) =>
      persistDismissed(activeRun(runId), dismissed),
    // Mint through the same pure helper the renderer Confirm buttons use.
    'suggest.confirm': ({ runId, suggestion, offset }: { runId?: number; suggestion: Suggestion; offset?: string }) => {
      const rid = activeRun(runId)
      const tags = upsertTag(loadTags(runInfo(rid).file).tags, suggestionToTag(suggestion, new Date().toISOString(), offset))
      persistTags(rid, tags)
      return tags
    },
    'suggest.reject': ({ runId, suggestion, offset }: { runId?: number; suggestion: Pick<Suggestion, 'target' | 'category'>; offset?: string }) => {
      const rid = activeRun(runId)
      const next = addDismissed(loadDismissed(runInfo(rid).file), suggestion.target, suggestion.category, offset)
      persistDismissed(rid, next)
      return next
    },
    'rasp.rules.save': ({ scope, ruleScope, runId }: { scope: 'global' | 'project'; ruleScope: RuleScope; runId?: number }) => {
      if (scope === 'global') { saveRules(userData(), ruleScope); return }
      const rid = runId ?? store.activeRun()
      if (rid === undefined) throw new Error('no active run for project-scope rules')
      const { file, ingestedAt } = runInfo(rid)
      saveSidecarRules(file, ingestedAt, ruleScope.rules, ruleScope.enabledOverrides)
    },
    'rasp.rules.preview': async ({ rule, runId }: { rule: unknown; runId?: number }) => {
      const { rule: valid, error } = validateRule(rule, 'project')
      if (!valid) return { error: error ?? 'invalid rule' }
      const rid = runId ?? store.activeRun()
      if (rid === undefined) return { error: 'no run loaded' }
      return store.previewRule(rid, valid)
    },
    'findings.export': async ({ runId, format, path, overwrite }: { runId?: number; format: 'md' | 'json'; path?: string; overwrite?: boolean }) => {
      if (!path) throw new Error('findings.export requires an explicit path')
      if (existsSync(path) && overwrite !== true) throw new Error(`findings.export: ${path} already exists (pass overwrite:true to replace)`)
      const rid = activeRun(runId)
      const { tags } = loadTags(ctx.runFileOf(rid).file)
      const reps: Record<string, SyscallEvent[]> = {}
      for (const t of tags) {
        if (reps[t.target]) continue
        // rasp: targets are synthetic (no graph node); skip the guaranteed-empty scan.
        if (t.target.startsWith('rasp:')) { reps[t.target] = []; continue }
        reps[t.target] = (await store.nodeEvents(t.target, {}, 50, rid))
          .filter((e): e is SyscallEvent => e.type === 'syscall')
      }
      const findings = buildFindings(tags, reps)
      const text = format === 'md' ? renderMarkdown(findings) : renderJSON(findings)
      writeFileSync(path, text)
      return path
    },

    // ---- RE pivot: coordinates only, no decompiler ----
    'backtraces': async ({ id, nodeId, runId }: { id?: number; nodeId?: string; runId?: number }) => {
      const rid = activeRun(runId)
      let eid = id
      if (eid === undefined && nodeId !== undefined) eid = (await store.nodeEvents(nodeId, {}, 1, rid))[0]?.id
      if (eid === undefined) return { frames: [] as BacktraceFrame[] }
      const ev = await store.eventById(eid, rid)
      if (!ev) return { frames: [] as BacktraceFrame[] }
      const frames: BacktraceFrame[] = []
      for (const j of (ev as { java_stack?: string[] | null }).java_stack ?? []) frames.push(parseJavaFrame(j))
      for (const f of (ev as { backtrace?: { addr: string; symbol: string }[] | null }).backtrace ?? []) {
        const p = parseFrameSymbol(f.symbol)
        if (p.module === null) continue
        const base = store.moduleBase(rid, ev.pid, p.module)
        const addr = parseHexAddr(f.addr)
        frames.push({
          kind: 'native', module: p.module, symbol: p.symbol,
          load_base: base === undefined ? null : '0x' + base.toString(16),
          module_relative_offset: base === undefined || addr === null ? '[unmapped]' : moduleRelative(addr, base),
        })
      }
      return { frames }
    },

    // ---- Tier 3: device (bodies injected from index.ts) ----
    'capture.preflight': ({ pkg }: { pkg: string }) => dev().preflight(pkg),
    'capture.start': ({ capId, vals, timeoutSecs, savePath }: { capId: string; vals: Record<string, unknown>; timeoutSecs?: number; savePath?: string }) =>
      dev().start(capId, vals, timeoutSecs, savePath),
    'capture.stop': ({ discard }: { discard?: boolean } = {}) => dev().stop(discard),
    'nativelib.startLive': ({ pkg, glob }: { pkg: string; glob?: string }) => dev().startLive(pkg, glob),
    'nativelib.stopLive': () => dev().stopLive(),
    'nativelib.verify': ({ pid, bases }: { pid: number; bases: string[] }) => dev().verify(pid, bases),
    'nativelib.dumpLib': ({ pid, base }: { pid: number; base: string }) => dev().dumpLib(pid, base),
    'nativelib.exportArtifact': ({ path, dest, overwrite }: { path: string; dest?: string; overwrite?: boolean }) => {
      if (!dest) throw new Error('nativelib.exportArtifact requires an explicit dest')
      if (existsSync(dest) && overwrite !== true) throw new Error(`nativelib.exportArtifact: ${dest} already exists (pass overwrite:true to replace)`)
      return dev().exportArtifact(path, dest)
    },
  }
}
