import { contextBridge, ipcRenderer } from 'electron'
import type { Filter } from '@shared/filter'

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
  loadTags: (runId: number) => ipcRenderer.invoke('tags:load', runId),
  saveTags: (runId: number, tags: unknown[]) => ipcRenderer.invoke('tags:save', runId, tags),
  onProgress: (cb: (pct: number) => void) =>
    ipcRenderer.on('trace:progress', (_e, pct) => cb(pct as number)),
  onLoaded: (cb: (s: { runId: number; eventCount: number; errors: number }) => void) =>
    ipcRenderer.on('trace:loaded', (_e, s) => cb(s as { runId: number; eventCount: number; errors: number })),
})
