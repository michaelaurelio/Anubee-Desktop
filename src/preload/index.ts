import { contextBridge, ipcRenderer } from 'electron'
import type { Filter } from '@shared/filter'
import type { Tag } from '@shared/project-store'
import type { Rule, RuleScope } from '@shared/rasp-heuristics'

// The typed surface the renderer sees as `window.ares`. Raw events never cross
// this bridge except the single record fetched by id for the inspector.
contextBridge.exposeInMainWorld('ares', {
  openFile: () => ipcRenderer.invoke('trace:open'),
  quit: () => ipcRenderer.invoke('app:quit'),
  copyToClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  runs: () => ipcRenderer.invoke('graph:runs'),
  table: (filter: Filter, page: { limit: number; offset: number }, runId?: number) =>
    ipcRenderer.invoke('graph:table', filter, page, runId),
  slice: (filter: Filter, cap?: number, runId?: number) =>
    ipcRenderer.invoke('graph:slice', filter, cap, runId),
  stackRollup: (filter: Filter, maxChains?: number, runId?: number) =>
    ipcRenderer.invoke('graph:stackRollup', filter, maxChains, runId),
  eventById: (id: number, runId?: number) => ipcRenderer.invoke('graph:eventById', id, runId),
  nodeEvents: (nodeId: string, filter: Filter, runId?: number) =>
    ipcRenderer.invoke('graph:nodeEvents', nodeId, filter, runId),
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
  onProgress: (cb: (pct: number) => void) =>
    ipcRenderer.on('trace:progress', (_e, pct) => cb(pct as number)),
  onLoaded: (cb: (s: { runId: number; eventCount: number; errors: number }) => void) =>
    ipcRenderer.on('trace:loaded', (_e, s) => cb(s as { runId: number; eventCount: number; errors: number })),
  getTracerConfig: () => ipcRenderer.invoke('tracer:config:get'),
  setTracerConfig: (cfg: { aresBinary: string; specsDir: string }) =>
    ipcRenderer.invoke('tracer:config:set', cfg),
  tracerPreflight: (pkg: string) => ipcRenderer.invoke('tracer:preflight', pkg),
  tracerStart: (capId: string, vals: Record<string, unknown>, timeoutSecs?: number, savePath?: string) =>
    ipcRenderer.invoke('tracer:start', capId, vals, timeoutSecs, savePath),
  tracerStop: () => ipcRenderer.invoke('tracer:stop'),
  pickSavePath: () => ipcRenderer.invoke('tracer:pickSavePath'),
  onTracerLine: (cb: (line: string) => void) =>
    ipcRenderer.on('tracer:line', (_e, line) => cb(line as string)),
  onTracerDone: (cb: (r: { code: number; kind: string; runId?: number }) => void) =>
    ipcRenderer.on('tracer:done', (_e, r) => cb(r as { code: number; kind: string; runId?: number })),
})
