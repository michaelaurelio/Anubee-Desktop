import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { resolve } from 'path'
import { GraphStore } from './graph-store'
import type { Filter } from '@shared/filter'

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

async function loadPath(path: string): Promise<{ eventCount: number; errors: number }> {
  const summary = await store.ingest(path, pct => win.webContents.send('trace:progress', pct))
  win.webContents.send('trace:loaded', summary)
  return summary
}

async function openViaDialog(): Promise<{ eventCount: number; errors: number } | null> {
  const r = await dialog.showOpenDialog(win, {
    filters: [{ name: 'ARES JSONL', extensions: ['jsonl', 'json'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths[0]) return null
  return loadPath(r.filePaths[0])
}

ipcMain.handle('trace:open', () => openViaDialog())
ipcMain.handle('graph:table', (_e, filter: Filter, page: { limit: number; offset: number }) => store.table(filter, page))
ipcMain.handle('graph:slice', (_e, filter: Filter, cap?: number) => store.slice(filter, cap))
ipcMain.handle('graph:eventById', (_e, id: number) => store.eventById(id))
ipcMain.handle('graph:nodeEvents', (_e, nodeId: string, filter: Filter) => store.nodeEvents(nodeId, filter))

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => void store.close())
