import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { resolve } from 'path'
import { writeFileSync } from 'node:fs'
import { GraphStore } from './graph-store'
import type { Filter } from '@shared/filter'
import { loadTags, saveTags } from './sidecar'
import type { Tag } from '@shared/project-store'
import { buildFindings, renderMarkdown, renderJSON } from '@shared/findings'
import type { SyscallEvent } from '@shared/events'
import type { DiffRow } from '@shared/diff'

// DuckDB lives here in the main process; read_json runs on its own native
// threads, off the V8 heap, so there is no event array to ship over IPC. The
// renderer only ever asks for a table page, a bounded slice, or one record by id.
const store = new GraphStore()
let win!: BrowserWindow

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.js'),
      contextIsolation: true,
    },
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(resolve(__dirname, '../renderer/index.html'))

  // Open a run given on launch (ARES_OPEN_FILE). Handy for CLI use and lets the
  // screenshot harness load a fixture without driving the native file dialog.
  const preload = process.env.ARES_OPEN_FILE
  if (preload) win.webContents.once('did-finish-load', () => void loadPath(preload))

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open JSONL...', accelerator: 'CmdOrCtrl+O', click: () => void openViaDialog() },
        { role: 'quit' },
      ],
    },
  ])
  Menu.setApplicationMenu(menu)
}

async function loadPath(path: string): Promise<{ runId: number; eventCount: number; errors: number }> {
  const summary = await store.ingest(path, pct => win.webContents.send('trace:progress', pct))
  win.webContents.send('trace:loaded', summary)
  return summary
}

async function openViaDialog(): Promise<{ runId: number; eventCount: number; errors: number } | null> {
  const r = await dialog.showOpenDialog(win, {
    filters: [{ name: 'ARES JSONL', extensions: ['jsonl', 'json'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths[0]) return null
  return loadPath(r.filePaths[0])
}

ipcMain.handle('trace:open', () => openViaDialog())
ipcMain.handle('graph:runs', () => store.runs())
ipcMain.handle('graph:table', (_e, filter: Filter, page: { limit: number; offset: number }, runId?: number) => store.table(filter, page, runId))
ipcMain.handle('graph:slice', (_e, filter: Filter, cap?: number, runId?: number) => store.slice(filter, cap, runId))
ipcMain.handle('graph:eventById', (_e, id: number, runId?: number) => store.eventById(id, runId))
ipcMain.handle('graph:nodeEvents', (_e, nodeId: string, filter: Filter, runId?: number) => store.nodeEvents(nodeId, filter, 500, runId))
ipcMain.handle('rasp:suggest', (_e, runId?: number) => store.suggest(runId))
ipcMain.handle('graph:diffTable', (_e, runA: number, runB: number, filter: Filter, cap?: number) =>
  store.diffTable(runA, runB, filter, cap))
ipcMain.handle('graph:diffSlice', (_e, runA: number, runB: number, nodeId: string) =>
  store.diffSlice(runA, runB, nodeId))

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

ipcMain.handle('findings:export', async (_e, runId: number, format: 'md' | 'json') => {
  const { file } = runFileOf(runId)
  const { tags } = loadTags(file)
  const reps: Record<string, SyscallEvent[]> = {}
  for (const t of tags) {
    if (reps[t.target]) continue
    reps[t.target] = await store.nodeEvents(t.target, {}, 50, runId)
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

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => void store.close())
