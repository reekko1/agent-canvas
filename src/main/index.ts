import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { Spine, SPINE_DIR } from './spine/spine'
import { PtyRegistry } from './ptys'
import { WorkspaceStore } from './workspace'
import type { AskDecision, WorkspaceSnapshot } from '../shared/types'

let win: BrowserWindow | null = null
const spine = new Spine()
const ptys = new PtyRegistry()
const workspace = new WorkspaceStore(join(SPINE_DIR, 'workspace.json'))
let nextCard = 1

function send(channel: string, ...args: unknown[]): void {
  win?.webContents.send(channel, ...args)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1680,
    height: 1050,
    title: 'Agent Canvas',
    backgroundColor: '#0f0f14',
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  spine.onUpdate = (cardId, event) => send('card-event', cardId, event)
  spine.onAsk = (ask) => send('permission-ask', ask)
  spine.start()
  createWindow()
})

app.on('window-all-closed', () => app.quit())
// Quitting only detaches tmux clients — the fleet keeps working by design.
app.on('before-quit', () => workspace.flush())

ipcMain.handle('new-card', async () => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    message: 'Choose the folder this agent works in',
  })
  const folder = r.filePaths[0]
  if (r.canceled || !folder) return null
  const cardId = `card-${Date.now().toString(36)}-${nextCard++}`
  return { cardId, folder } // the pty spawns when the CardNode mounts (ensure-card)
})

ipcMain.handle('ensure-card', (_e, cardId: string, folder: string, cols: number, rows: number) => {
  if (ptys.has(cardId)) return
  ptys.spawn(
    cardId,
    spine.launch(cardId, folder),
    {
      onData: (d) => send('pty-data', cardId, d),
      onExit: () => send('pty-exit', cardId),
    },
    cols,
    rows,
  )
})

ipcMain.handle('load-workspace', () => workspace.load())
ipcMain.on('save-workspace', (_e, snapshot: WorkspaceSnapshot) => workspace.save(snapshot))

ipcMain.handle('kill-card', (_e, cardId: string) => {
  ptys.kill(cardId)
  spine.killSession(cardId)
})

ipcMain.on('pty-write', (_e, cardId: string, data: string) => ptys.write(cardId, data))
ipcMain.on('pty-resize', (_e, cardId: string, cols: number, rows: number) =>
  ptys.resize(cardId, cols, rows),
)
ipcMain.on('decide-ask', (_e, askId: string, decision: AskDecision) =>
  spine.decide(askId, decision),
)
ipcMain.on('release-asks', (_e, cardId: string) => spine.releaseFor(cardId))
