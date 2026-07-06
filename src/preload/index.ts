import { contextBridge, ipcRenderer } from 'electron'
import type { Filter } from '@shared/filter'
import type { Tag } from '@shared/project-store'

// The typed surface the renderer sees as `window.ares`. Raw events never cross
// this bridge except the single record fetched by id for the inspector.
contextBridge.exposeInMainWorld('ares', {
  openFile: () => ipcRenderer.invoke('trace:open'),
  runs: () => ipcRenderer.invoke('graph:runs'),
  table: (filter: Filter, page: { limit: number; offset: number }, runId?: number) =>
    ipcRenderer.invoke('graph:table', filter, page, runId),
  slice: (filter: Filter, cap?: number, runId?: number) =>
    ipcRenderer.invoke('graph:slice', filter, cap, runId),
  eventById: (id: number, runId?: number) => ipcRenderer.invoke('graph:eventById', id, runId),
  nodeEvents: (nodeId: string, filter: Filter, runId?: number) =>
    ipcRenderer.invoke('graph:nodeEvents', nodeId, filter, runId),
  suggest: (runId?: number) => ipcRenderer.invoke('rasp:suggest', runId),
  diffTable: (runA: number, runB: number, filter: Filter, cap?: number) =>
    ipcRenderer.invoke('graph:diffTable', runA, runB, filter, cap),
  diffSlice: (runA: number, runB: number, nodeId: string, filter: Filter) =>
    ipcRenderer.invoke('graph:diffSlice', runA, runB, nodeId, filter),
  loadTags: (runId: number) => ipcRenderer.invoke('tags:load', runId),
  saveTags: (runId: number, tags: Tag[]) => ipcRenderer.invoke('tags:save', runId, tags),
  orphans: (runId: number, targets: string[]) => ipcRenderer.invoke('tags:orphans', runId, targets),
  exportFindings: (runId: number, format: 'md' | 'json') =>
    ipcRenderer.invoke('findings:export', runId, format),
  onProgress: (cb: (pct: number) => void) =>
    ipcRenderer.on('trace:progress', (_e, pct) => cb(pct as number)),
  onLoaded: (cb: (s: { runId: number; eventCount: number; errors: number }) => void) =>
    ipcRenderer.on('trace:loaded', (_e, s) => cb(s as { runId: number; eventCount: number; errors: number })),
})
