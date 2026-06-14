import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Spine, SPINE_DIR } from './spine/spine'
import { PtyRegistry } from './ptys'
import { WorkspaceStore } from './workspace'
import { gitAction, gitFileDiff } from './git/git'
import { DiffWatchers } from './git/watchers'
import { checkAppReadiness, checkRemoteReadiness } from './remote/readiness'
import type {
  AskDecision,
  GitActionRequest,
  GitChange,
  RemoteState,
  UpdateStatus,
  WorkspaceSnapshot,
} from '../shared/types'

let win: BrowserWindow | null = null
const spine = new Spine()
const ptys = new PtyRegistry()
const workspace = new WorkspaceStore(join(SPINE_DIR, 'workspace.json'))
const diffWatchers = new DiffWatchers((diffId, snap) => send('diff-snapshot', diffId, snap))
let nextItem = 1

function send(channel: string, ...args: unknown[]): void {
  win?.webContents.send(channel, ...args)
}

// electron-updater swallows failures by default; a silent `.catch()` once hid a
// broken update check for a whole release. Log every step to <logs>/updater.log
// (~/Library/Logs/Agent Canvas/updater.log on macOS) so a stuck updater is
// diagnosable from the field, and wire up the resolution path that actually
// works in a packaged build.
function setupUpdater(): void {
  const logFile = join(app.getPath('logs'), 'updater.log')
  const write = (level: string, msg: unknown): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      const line = typeof msg === 'string' ? msg : JSON.stringify(msg)
      appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${line}\n`)
    } catch {
      /* logging must never crash startup */
    }
  }
  autoUpdater.logger = {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    debug: (m) => write('debug', m),
  }
  // Resolve the latest release via the GitHub Atom feed instead of the
  // /releases/latest HTML endpoint. electron-updater's default
  // (allowPrerelease=false) scrapes github.com/<owner>/<repo>/releases/latest
  // expecting a JSON `tag_name`, but a packaged app carries a cookie-bearing
  // session and GitHub then serves the full HTML release page instead — the
  // tag is never found and the check dies with "No published versions on
  // GitHub". The Atom feed path is cookie-insensitive and resolves reliably.
  // We only ever publish stable releases (Packaging/release.sh never passes
  // --prerelease), so this just means "use the feed" — it never pulls a real
  // pre-release.
  autoUpdater.allowPrerelease = true
  // Mirror the lifecycle into the renderer so the app shows a visible banner
  // (download progress → "Restart to update"), not just the easy-to-miss macOS
  // notification. quitAndInstall() applies the staged update on demand.
  const status = (s: UpdateStatus): void => send('update-status', s)
  autoUpdater.on('checking-for-update', () => write('info', 'checking for update'))
  autoUpdater.on('update-available', (i) => {
    write('info', `update available: ${i.version}`)
    status({ state: 'downloading', version: i.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (p) =>
    status({ state: 'downloading', percent: p.percent }),
  )
  autoUpdater.on('update-not-available', () => write('info', 'no update available'))
  autoUpdater.on('update-downloaded', (i) => {
    write('info', `downloaded ${i.version}, will install on quit`)
    status({ state: 'ready', version: i.version })
  })
  autoUpdater.on('error', (e) => {
    write('error', `update error: ${e?.message ?? e}`)
    status({ state: 'error' })
  })
  ipcMain.on('quit-and-install', () => autoUpdater.quitAndInstall())
  autoUpdater.checkForUpdatesAndNotify().catch((e) => write('error', `check failed: ${e?.message ?? e}`))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1680,
    height: 1050,
    title: 'Agent Canvas',
    // Content bleeds under the title bar; only the traffic lights remain.
    // The renderer provides the drag strip (.app-drag in Canvas).
    titleBarStyle: 'hiddenInset',
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
  // Updates ride GitHub releases (latest-mac.yml, the appcast equivalent):
  // download in the background, notify, install on quit. Dev builds have no
  // app-update.yml and ad-hoc builds can't verify signatures — stay dormant,
  // like the Swift app's Sparkle updater without SUFeedURL.
  if (app.isPackaged) setupUpdater()
})

app.on('window-all-closed', () => app.quit())
// Quitting only detaches tmux clients — the fleet keeps working by design.
app.on('before-quit', () => workspace.flush())

async function pickFolder(message: string): Promise<string | null> {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], message })
  return r.canceled ? null : (r.filePaths[0] ?? null)
}

ipcMain.handle('new-card', async () => {
  const folder = await pickFolder('Choose the folder this agent works in')
  if (!folder) return null
  const cardId = `card-${Date.now().toString(36)}-${nextItem++}`
  return { cardId, folder } // the pty spawns when the CardNode mounts (ensure-card)
})

ipcMain.handle('new-shell', async () => {
  const folder = await pickFolder('Choose the folder for this terminal')
  if (!folder) return null
  const cardId = `shell-${Date.now().toString(36)}-${nextItem++}`
  return { cardId, folder }
})

ipcMain.handle('new-diff', async () => {
  const folder = await pickFolder('Choose the repo to watch')
  if (!folder) return null
  const diffId = `diff-${Date.now().toString(36)}-${nextItem++}`
  return { diffId, folder } // the watcher starts when the DiffNode mounts (watch-diff)
})

ipcMain.handle('watch-diff', (_e, diffId: string, folder: string) =>
  diffWatchers.watch(diffId, folder),
)
ipcMain.on('unwatch-diff', (_e, diffId: string) => diffWatchers.unwatch(diffId))
ipcMain.handle('file-diff', (_e, folder: string, change: GitChange) =>
  gitFileDiff(folder, change),
)
ipcMain.handle('git-action', async (_e, folder: string, action: GitActionRequest) => {
  const r = await gitAction(folder, action)
  // Refresh right after a mutation instead of waiting for the next poll.
  if (r.ok) diffWatchers.poke(folder)
  return r
})

ipcMain.handle(
  'ensure-card',
  (_e, cardId: string, folder: string, cols: number, rows: number, kind: 'agent' | 'shell') => {
    if (ptys.has(cardId)) return
    ptys.spawn(
      cardId,
      spine.launch(cardId, folder, kind === 'shell'),
      {
        onData: (d) => send('pty-data', cardId, d),
        onExit: () => send('pty-exit', cardId),
      },
      cols,
      rows,
    )
  },
)

ipcMain.handle('read-todos', (_e, sessionId: string) => spine.todos(sessionId))
ipcMain.handle('load-workspace', () => workspace.load())
ipcMain.on('save-workspace', (_e, snapshot: WorkspaceSnapshot) => workspace.save(snapshot))

ipcMain.handle('kill-card', (_e, cardId: string) => {
  ptys.kill(cardId)
  spine.killSession(cardId)
})

ipcMain.on('pty-write', (_e, cardId: string, data: string) => ptys.write(cardId, data))
ipcMain.handle('leave-scrollback', (_e, cardId: string) => spine.leaveScrollback(cardId))
ipcMain.on('pty-resize', (_e, cardId: string, cols: number, rows: number) =>
  ptys.resize(cardId, cols, rows),
)
ipcMain.on('decide-ask', (_e, askId: string, decision: AskDecision) =>
  spine.decide(askId, decision),
)
ipcMain.on('release-asks', (_e, cardId: string) => spine.releaseFor(cardId))

// MARK: Remote panel — the renderer mirrors its attention state out, and
// decisions made on the phone flow back through the same spine.decide as the
// in-app toasts (then notify the renderer so the toast clears).
ipcMain.on('publish-remote-state', (_e, state: RemoteState) => spine.remote.publish(state))
ipcMain.handle('check-remote-readiness', () => checkRemoteReadiness(spine.remote.port))
ipcMain.handle('check-app-readiness', async () => {
  const report = await checkAppReadiness()
  // tmux landed after launch (the gate's install path) → arm the substrate
  // now so the first card spawns into a session, not a bare pty.
  if (report.tmuxFound) spine.ensureTmuxPrepared()
  return report
})
spine.remote.onDecide = (askId, allow) => {
  spine.decide(askId, allow ? 'allow' : 'deny')
  send('ask-decided', askId)
}
ipcMain.on('open-external', (_e, url: string) => {
  if (typeof url === 'string' && url.startsWith('https://')) void shell.openExternal(url)
})
