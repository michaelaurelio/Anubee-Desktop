import { contextBridge, ipcRenderer } from 'electron'
import type { Filter } from '@shared/filter'
import type { Tag } from '@shared/project-store'
import type { Rule, RuleScope } from '@shared/rasp-heuristics'
import type { LibLine, Artifact, Modcmp } from '@shared/native-lib'

// The typed surface the renderer sees as `window.anubee`. Raw events never cross
// this bridge except the single record fetched by id for the inspector.
contextBridge.exposeInMainWorld('anubee', {
  openFile: () => ipcRenderer.invoke('trace:open'),
  openFileForCompare: () => ipcRenderer.invoke('trace:openCompare'),
  saveProject: (runId: number, layout?: unknown) => ipcRenderer.invoke('project:save', runId, layout),
  openProject: () => ipcRenderer.invoke('project:open'),
  quit: () => ipcRenderer.invoke('app:quit'),
  requestClose: () => ipcRenderer.send('app:requestClose'),
  onConfirmClose: (cb: () => void) => ipcRenderer.on('app:confirmClose', () => cb()),
  respondClose: (action: 'close' | 'cancel') => ipcRenderer.send('app:closeResponse', action),
  copyToClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  runs: () => ipcRenderer.invoke('graph:runs'),
  table: (filter: Filter, page: { limit: number; offset: number }, runId?: number) =>
    ipcRenderer.invoke('graph:table', filter, page, runId),
  count: (filter: Filter, runId?: number) => ipcRenderer.invoke('graph:count', filter, runId),
  slice: (filter: Filter, cap?: number, runId?: number) =>
    ipcRenderer.invoke('graph:slice', filter, cap, runId),
  stackRollup: (filter: Filter, maxChains?: number, runId?: number) =>
    ipcRenderer.invoke('graph:stackRollup', filter, maxChains, runId),
  eventById: (id: number, runId?: number) => ipcRenderer.invoke('graph:eventById', id, runId),
  coverage: (runId?: number) => ipcRenderer.invoke('graph:coverage', runId),
  nodeEvents: (nodeId: string, filter: Filter, page: { limit: number; offset: number }, runId?: number) =>
    ipcRenderer.invoke('graph:nodeEvents', nodeId, filter, page, runId),
  nodeEventCount: (nodeId: string, filter: Filter, runId?: number) =>
    ipcRenderer.invoke('graph:nodeEventCount', nodeId, filter, runId),
  highlightSets: (nodeId: string, filter: Filter, runId?: number) =>
    ipcRenderer.invoke('graph:highlightSets', nodeId, filter, runId),
  recordChain: (id: number, runId?: number) =>
    ipcRenderer.invoke('graph:recordChain', id, runId),
  nodeOffsets: (nodeId: string, filter: Filter, runId?: number) =>
    ipcRenderer.invoke('graph:nodeOffsets', nodeId, filter, runId),
  suggest: (runId?: number) => ipcRenderer.invoke('rasp:suggest', runId),
  rulesGet: (runId?: number) => ipcRenderer.invoke('rasp:rules:get', runId),
  rulesSave: (scope: 'global' | 'project', ruleScope: RuleScope, runId?: number) =>
    ipcRenderer.invoke('rasp:rules:save', scope, ruleScope, runId),
  rulesPreview: (rule: Rule, runId?: number) => ipcRenderer.invoke('rasp:rules:preview', rule, runId),
  diffTable: (runA: number, runB: number, filter: Filter, cap?: number) =>
    ipcRenderer.invoke('graph:diffTable', runA, runB, filter, cap),
  diffSlice: (runA: number, runB: number, nodeId: string, filter: Filter) =>
    ipcRenderer.invoke('graph:diffSlice', runA, runB, nodeId, filter),
  loadTags: (runId: number) => ipcRenderer.invoke('tags:load', runId),
  saveTags: (runId: number, tags: Tag[]) => ipcRenderer.invoke('tags:save', runId, tags),
  dismissedGet: (runId: number) => ipcRenderer.invoke('suggest:dismissed:get', runId),
  dismissedSave: (runId: number, dismissed: { target: string; category: string }[]) =>
    ipcRenderer.invoke('suggest:dismissed:save', runId, dismissed),
  orphans: (runId: number, targets: string[]) => ipcRenderer.invoke('tags:orphans', runId, targets),
  exportFindings: (runId: number, format: 'md' | 'json') =>
    ipcRenderer.invoke('findings:export', runId, format),
  logSave: (text: string) => ipcRenderer.invoke('log:save', text),
  onProgress: (cb: (pct: number) => void) =>
    ipcRenderer.on('trace:progress', (_e, pct) => cb(pct as number)),
  onEstimate: (cb: (e: { fileBytes: number; throughput: number }) => void) =>
    ipcRenderer.on('trace:estimate', (_e, e) => cb(e as { fileBytes: number; throughput: number })),
  onIngestFail: (cb: (e: { message: string; file: string }) => void) =>
    ipcRenderer.on('trace:fail', (_e, e) => cb(e as { message: string; file: string })),
  onLoaded: (cb: (s: { runId: number; eventCount: number; errors: number; kinds: ('syscall' | 'funcs')[] }) => void) =>
    ipcRenderer.on('trace:loaded', (_e, s) => cb(s as { runId: number; eventCount: number; errors: number; kinds: ('syscall' | 'funcs')[] })),
  getTracerConfig: () => ipcRenderer.invoke('tracer:config:get'),
  setTracerConfig: (cfg: { anubeeBinary: string; specsDir: string }) =>
    ipcRenderer.invoke('tracer:config:set', cfg),
  tracerPreflight: (pkg: string) => ipcRenderer.invoke('tracer:preflight', pkg),
  tracerStart: (capId: string, vals: Record<string, unknown>, timeoutSecs?: number, savePath?: string) =>
    ipcRenderer.invoke('tracer:start', capId, vals, timeoutSecs, savePath),
  tracerStop: (discard?: boolean) => ipcRenderer.invoke('tracer:stop', discard),
  tracerIsRunning: () => ipcRenderer.invoke('tracer:isRunning') as
    Promise<{ running: boolean; argv: string | null; phase: 'idle' | 'device' | 'finishing' }>,
  onTracerDone: (cb: (result: { code: number; kind: string; runId?: number; error?: string }) => void) =>
    ipcRenderer.on('tracer:done', (_e, r) =>
      cb(r as { code: number; kind: string; runId?: number; error?: string })),
  // Fired once, when the device-side process exits and pull+ingest takes
  // over ('finishing' - see run-lifecycle.ts). There is no live process left
  // to signal at that point, so the Capture footer swaps to a non-interactive
  // busy state instead of offering Stop buttons that can no longer act.
  onTracerPhase: (cb: (p: { phase: 'finishing' }) => void) =>
    ipcRenderer.on('tracer:phase', (_e, p) => cb(p as { phase: 'finishing' })),
  pickSavePath: () => ipcRenderer.invoke('tracer:pickSavePath'),
  tracerCheckPaths: (binaryPath: string, specsDir: string) =>
    ipcRenderer.invoke('tracer:checkPaths', binaryPath, specsDir),
  tracerListSpecs: (specsDir: string) => ipcRenderer.invoke('tracer:listSpecs', specsDir),
  tracerPickBinary: () => ipcRenderer.invoke('tracer:pickBinary'),
  tracerPickSpecsDir: () => ipcRenderer.invoke('tracer:pickSpecsDir'),
  onTracerLines: (cb: (lines: string[]) => void) =>
    ipcRenderer.on('tracer:lines', (_e, lines) => cb(lines as string[])),
  onPreflightCheck: (cb: (c: { id: string; label: string; ok: boolean; detail: string }) => void) =>
    ipcRenderer.on('tracer:preflight-check', (_e, c) =>
      cb(c as { id: string; label: string; ok: boolean; detail: string })),
  libTable: (runId?: number) => ipcRenderer.invoke('nativelib:table', runId),
  startLive: (pkg: string, glob?: string) => ipcRenderer.invoke('nativelib:startLive', pkg, glob),
  stopLive: () => ipcRenderer.invoke('nativelib:stopLive'),
  dumpLib: (pid: number, base: string) => ipcRenderer.invoke('nativelib:dumpLib', pid, base),
  verify: (pid: number, bases: string[]) => ipcRenderer.invoke('nativelib:verify', pid, bases),
  revealArtifact: (path: string) => ipcRenderer.invoke('nativelib:revealArtifact', path),
  exportArtifact: (path: string) => ipcRenderer.invoke('nativelib:exportArtifact', path),
  onLibMapped: (cb: (l: LibLine & { atMs: number }) => void) =>
    ipcRenderer.on('nativelib:mapped', (_e, l) => cb(l as LibLine & { atMs: number })),
  onLibUnmapped: (cb: (l: LibLine & { atMs: number }) => void) =>
    ipcRenderer.on('nativelib:unmapped', (_e, l) => cb(l as LibLine & { atMs: number })),
  onLibLine: (cb: (line: string) => void) => ipcRenderer.on('nativelib:line', (_e, l) => cb(l as string)),
  onWatchLine: (cb: (line: string) => void) => ipcRenderer.on('nativelib:watchLine', (_e, l) => cb(l as string)),
  onWatchArtifacts: (cb: (a: Artifact[]) => void) =>
    ipcRenderer.on('nativelib:watchArtifacts', (_e, a) => cb(a as Artifact[])),
  onLibStreamEnd: (cb: () => void) => ipcRenderer.on('nativelib:streamEnd', () => cb()),
  onCheckResults: (cb: (results: Modcmp[], atMs: number) => void) =>
    ipcRenderer.on('nativelib:checkResults', (_e, p) => {
      const { results, atMs } = p as { results: Modcmp[]; atMs: number }
      cb(results, atMs)
    }),
})
