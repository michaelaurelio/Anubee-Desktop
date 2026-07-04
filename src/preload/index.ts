import { contextBridge, ipcRenderer } from 'electron'
import type { Filter } from '@shared/filter'

// The typed surface the renderer sees as `window.ares`. Raw events never cross
// this bridge except the single record fetched by id for the inspector.
contextBridge.exposeInMainWorld('ares', {
  openFile: () => ipcRenderer.invoke('trace:open'),
  table: (filter: Filter, page: { limit: number; offset: number }) =>
    ipcRenderer.invoke('graph:table', filter, page),
  slice: (filter: Filter, cap?: number) => ipcRenderer.invoke('graph:slice', filter, cap),
  eventById: (id: number) => ipcRenderer.invoke('graph:eventById', id),
  onProgress: (cb: (pct: number) => void) =>
    ipcRenderer.on('trace:progress', (_e, pct) => cb(pct as number)),
  onLoaded: (cb: (s: { eventCount: number; errors: number }) => void) =>
    ipcRenderer.on('trace:loaded', (_e, s) => cb(s as { eventCount: number; errors: number })),
})
