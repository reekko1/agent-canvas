import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Spine, SPINE_DIR } from './spine/spine'
import { PtyRegistry } from './ptys'
import { WorkspaceStore } from './workspace'
import { execFile } from 'node:child_process'
import { gitAction, gitFileDiff, gitIdentity } from './git/git'
import { DiffWatchers } from './git/watchers'
import { checkAppReadiness, checkRemoteReadiness } from './remote/readiness'
import { Orchestrator } from './orchestrator/manager'
import type {
  AskDecision,
  GitActionRequest,
  GitChange,
  MultiProjectSnapshot,
  OrchestratorCommandResult,
  QuestionAnswers,
  RemoteState,
  UpdateStatus,
} from '../shared/types'

let win: BrowserWindow | null = null
const spine = new Spine()
const ptys = new PtyRegistry()
const workspace = new WorkspaceStore(join(SPINE_DIR, 'workspace.json'))
const diffWatchers = new DiffWatchers((diffId, snap) => send('diff-snapshot', diffId, snap))
let orchestrator: Orchestrator | null = null
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
  // Cleared once an update is staged (update-downloaded), so later polls can't
  // re-surface a banner the user already dismissed.
  let poll: ReturnType<typeof setInterval> | null = null
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
    // The update is staged — stop polling so a later check can't re-emit the
    // banner after the user dismissed it. Nudge once via the OS, since the
    // in-app banner is invisible when the window is backgrounded or off-space.
    if (poll) {
      clearInterval(poll)
      poll = null
    }
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Update ready',
        body: `Agent Canvas ${i.version} is ready — restart to install.`,
      })
      n.on('click', () => {
        win?.show()
        win?.focus()
      })
      n.show()
    }
  })
  autoUpdater.on('error', (e) => {
    write('error', `update error: ${e?.message ?? e}`)
    status({ state: 'error' })
  })
  ipcMain.on('quit-and-install', () => autoUpdater.quitAndInstall())
  // Check at launch, then keep polling while the app runs — people leave it open
  // for days, so a one-shot startup check would never surface a release. The
  // poll stops once an update is staged (see update-downloaded above).
  const check = (): void =>
    void autoUpdater.checkForUpdates().catch((e) => write('error', `check failed: ${e?.message ?? e}`))
  poll = setInterval(check, 6 * 60 * 60 * 1000)
  check()
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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Explicit hardening — these are Electron's defaults, pinned so a future
      // option or version bump can't silently weaken the renderer sandbox.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // This is a local app — the only sanctioned external-link path is
  // shell.openExternal (the open-external IPC). Deny popups outright and block
  // any in-page navigation away from the app's own origin (dev server / file).
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      const devURL = process.env['ELECTRON_RENDERER_URL']
      const allowed = (!!devURL && url.startsWith(devURL)) || url.startsWith('file://')
      if (!allowed) event.preventDefault()
    })
  })
  spine.onUpdate = (cardId, event) => send('card-event', cardId, event)
  spine.onAsk = (ask) => send('permission-ask', ask)
  spine.onQuestion = (ask) => send('question-ask', ask)
  spine.start()
  // The in-app orchestrator: drives the canvas via the Agent SDK. Reads the
  // latest published RemoteState for `list_world`; dispatches mutations and
  // confirms to the renderer (see the orchestrator-* IPC below).
  orchestrator = new Orchestrator({
    send,
    getState: () => spine.remote.getLatestState(),
    writeToCard: (cardId, data) => ptys.write(cardId, data),
    getReply: (cardId) => spine.lastReply(cardId),
  })
  createWindow()
  // Updates ride GitHub releases (latest-mac.yml, the appcast equivalent):
  // download in the background, notify, install on quit. Dev builds have no
  // app-update.yml and ad-hoc builds can't verify signatures — stay dormant,
  // like the Swift app's Sparkle updater without SUFeedURL.
  if (app.isPackaged) setupUpdater()
})

app.on('window-all-closed', () => app.quit())
// Quitting only detaches tmux clients — the fleet keeps working by design.
app.on('before-quit', () => {
  workspace.flush()
  diffWatchers.disposeAll()
})

async function pickFolder(message: string): Promise<string | null> {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], message })
  return r.canceled ? null : (r.filePaths[0] ?? null)
}

ipcMain.handle('pick-folder', (_e, message: string) => pickFolder(message))

// `folder` is the active project's dir when set — cards inherit it instead of
// prompting. Default (no dir) falls back to the picker, one folder per card.
ipcMain.handle('new-card', async (_e, folder?: string) => {
  const dir = folder ?? (await pickFolder('Choose the folder this agent works in'))
  if (!dir) return null
  const cardId = `card-${Date.now().toString(36)}-${nextItem++}`
  return { cardId, folder: dir } // the pty spawns when the CardNode mounts (ensure-card)
})

ipcMain.handle('new-shell', async (_e, folder?: string) => {
  const dir = folder ?? (await pickFolder('Choose the folder for this terminal'))
  if (!dir) return null
  const cardId = `shell-${Date.now().toString(36)}-${nextItem++}`
  return { cardId, folder: dir }
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

ipcMain.handle('repo-identity', (_e, folder: string) => gitIdentity(folder))
ipcMain.handle('reveal-folder', (_e, folder: string) => shell.showItemInFolder(folder))

/** Open a folder in the first GUI editor we can find. `open -a` isn't used —
 *  it'd open Finder, not an editor — so this is best-effort over known CLIs. */
function runEditor(cmd: string, folder: string): Promise<boolean> {
  return new Promise((resolve) => execFile(cmd, [folder], (err) => resolve(!err)))
}
ipcMain.handle('open-in-editor', async (_e, folder: string) => {
  for (const cmd of ['code', 'cursor']) {
    if (await runEditor(cmd, folder)) return true
  }
  return false
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
ipcMain.handle('pane-command', (_e, cardId: string) => spine.paneCommand(cardId))
ipcMain.handle('pane-cwd', (_e, cardId: string) => spine.paneCwd(cardId))
ipcMain.handle('load-workspace', () => workspace.load())
ipcMain.on('save-workspace', (_e, snapshot: MultiProjectSnapshot) => workspace.save(snapshot))

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
ipcMain.on('answer-question', (_e, askId: string, answers: QuestionAnswers) =>
  spine.answerQuestion(askId, answers),
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
spine.remote.onAnswer = (askId, answers) => {
  spine.answerQuestion(askId, answers)
  send('question-decided', askId)
}
spine.remote.onDecline = (askId) => {
  spine.decide(askId, 'deny')
  send('question-decided', askId)
}
// Skip the phone push when you're already at the desktop.
spine.remote.isDesktopFocused = () => win?.isFocused() ?? false
ipcMain.on('open-external', (_e, url: string) => {
  if (typeof url === 'string' && url.startsWith('https://')) void shell.openExternal(url)
})

// MARK: Orchestrator — chat prompts drive a query() turn; mutations/confirms it
// issues come back to the renderer as orchestrator-command and are answered by
// id via orchestrator-result.
ipcMain.on('orchestrator-prompt', (_e, prompt: string) => void orchestrator?.run(prompt))
ipcMain.on('orchestrator-result', (_e, id: number, result: OrchestratorCommandResult) =>
  orchestrator?.resolveCommand(id, result),
)
