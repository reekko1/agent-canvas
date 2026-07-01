import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Spine, SPINE_DIR } from './spine/spine'
import type { McpStageOpts } from './spine/cliAdapter'
import { PtyRegistry } from './ptys'
import { WorkspaceStore } from './workspace'
import { IssueStore } from './issueStore'
import { setMastermindRoot } from './mastermind/paths'
import { setSkillsChangedListener } from './mastermind/learning'
import { skillsSnapshot } from './mastermind/skills'
import { execFile } from 'node:child_process'
import { gitAction, gitFileDiff, gitIdentity } from './git/git'
import { DiffWatchers } from './git/watchers'
import { checkAppReadiness, checkRemoteReadiness } from './remote/readiness'
import { Orchestrator } from './orchestrator/manager'
import type { AgentMcpServer } from './orchestrator/agentMcp'
import { AgentBrowserMcp } from './orchestrator/agentBrowserMcp'
import { AgentCanvasMcp } from './orchestrator/agentCanvasMcp'
import { AgentIssueMcp } from './orchestrator/agentIssueMcp'
import { BrowserController } from './orchestrator/browserController'
import { SonioxVoice, validateSonioxKey } from './voice/soniox'
import { storeSonioxKey } from './voice/keyStore'
import type { WebSocket as RemoteWebSocket } from 'ws'
import type {
  AskDecision,
  CliKind,
  GitActionRequest,
  GitChange,
  IssueActionRequest,
  MultiProjectSnapshot,
  OrchestratorCommandResult,
  OrchestratorMode,
  QuestionAnswers,
  RemoteState,
  UpdateStatus,
} from '../shared/types'

let win: BrowserWindow | null = null
const spine = new Spine()
const ptys = new PtyRegistry()
const workspace = new WorkspaceStore(join(SPINE_DIR, 'workspace.json'))
// The Mastermind substrate: the Vision → Sprint → Plan → Issue store (see
// MASTERMIND.md). Main owns it; the renderer board reads/writes it over IPC.
const issues = new IssueStore(join(SPINE_DIR, 'issues.jsonl'))
// The mastermind's learning state lives under SPINE_DIR (kept explicit, not reliant on
// paths.ts's homedir default). Harmless when the reactor is off — just sets a path.
setMastermindRoot(join(SPINE_DIR, 'mastermind'))
const diffWatchers = new DiffWatchers((diffId, snap) => send('diff-snapshot', diffId, snap))
const browserController = new BrowserController({
  // Ask the renderer to wake a dormant (evicted) browser so it can be driven.
  wake: (cardId) => send('browser-wake', cardId),
})
let orchestrator: Orchestrator | null = null
// The agent canvas-core MCP (update_plan / ask_user). Module-scoped so the
// question IPC handlers can route ask_user answers to it (vs the spine's hook asks).
let agentCanvasMcp: AgentCanvasMcp | null = null
// The renderer owns canvas state and pushes whole snapshots; we keep the latest so
// main can resolve a canvas's repo dir (the off-card tournament runs there).
let latestWorkspace: MultiProjectSnapshot | null = null
let voice: SonioxVoice | null = null
let stallSweep: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let nextItem = 1
/** Initial prompts queued for a card before its pty spawns — delivered as
 *  claude's initial prompt by ensure-card (one-shot, so a spawned agent boots
 *  already working on the task instead of racing a keystroke injection). */
const pendingPrompts = new Map<string, string>()

// Single-talker voice lease. The Soniox STT socket is a singleton, so two
// simultaneous talkers would interleave tokens. The first to grab the mic —
// desktop ⌥ (`'desktop'`) or a phone push-to-talk (its WebSocket) — holds the
// floor until the utterance ends; a start from a different source is refused.
// Released by a terminal STT event (final/error, in the voice callbacks) or an
// explicit finish/cancel/socket-close.
let voiceLease: 'desktop' | RemoteWebSocket | null = null

/** Grab the mic for a source, run the barge-in (stop the spoken reply + the turn),
 *  and open a fresh STT session. Refused (no-op) if another source holds the floor. */
function startVoice(source: 'desktop' | RemoteWebSocket): void {
  if (voiceLease && voiceLease !== source) return
  voiceLease = source
  voice?.cancelSpeak()
  orchestrator?.interrupt()
  voice?.startStt()
}

function send(channel: string, ...args: unknown[]): void {
  win?.webContents.send(channel, ...args)
}

// Whole-app zoom (Cmd/Ctrl +/-/0) is applied to the HOST renderer so it scales
// the entire UI — browser cards included, since each <webview> is a child of
// that renderer. We own it ourselves (see the before-input-event hook) rather
// than leaning on the default menu's zoom role, which targets whichever web
// contents is focused — so a focused browser card's webview would otherwise
// swallow the shortcut and zoom only its page.
const ZOOM_MIN = -3
const ZOOM_MAX = 4.5
function applyZoom(level: number): void {
  const wc = win?.webContents
  if (!wc) return
  wc.setZoomLevel(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level)))
}
function zoomBy(delta: number): void {
  const wc = win?.webContents
  if (wc) applyZoom(wc.getZoomLevel() + delta)
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
      // Browser cards mount an in-DOM <webview> guest (its own process). The
      // guest carries no preload and runs in its own `persist:browser` session,
      // so it can't reach window.canvas — see the navigation exemption below.
      webviewTag: true,
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
    // Whole-app zoom on Cmd/Ctrl +/-/0, intercepted on EVERY web contents —
    // host and webview guests alike — and redirected to the host renderer.
    // preventDefault stops the focused contents (a browser card's webview) from
    // zooming only itself or the menu accelerator from firing; the host zoom
    // then scales the entire UI as it did before browser cards existed.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.meta || input.control)) return
      if (input.key === '=' || input.key === '+') {
        event.preventDefault()
        zoomBy(0.5)
      } else if (input.key === '-' || input.key === '_') {
        event.preventDefault()
        zoomBy(-0.5)
      } else if (input.key === '0') {
        event.preventDefault()
        applyZoom(0)
      }
    })
    // Browser cards ARE a web browser — their <webview> guest must navigate
    // freely. The host frame (the app's own renderer) stays locked: no popups,
    // no navigating away from the dev server / file origin.
    if (contents.getType() === 'webview') return
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      const devURL = process.env['ELECTRON_RENDERER_URL']
      const allowed = (!!devURL && url.startsWith(devURL)) || url.startsWith('file://')
      if (!allowed) event.preventDefault()
    })
  })
  // Push-to-talk needs the microphone (`media`). Some setups don't grant it
  // without an explicit handler; granting it here makes getUserMedia reliable
  // (the OS still gates the mic with its own TCC prompt on first use). Every
  // other permission stays as it was before this handler existed — approved — so
  // clipboard copies and the like keep working; this is local, first-party content.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true))
  session.defaultSession.setPermissionCheckHandler(() => true)
  spine.onUpdate = (cardId, event) => send('card-event', cardId, event)
  spine.onAsk = (ask) => {
    send('permission-ask', ask)
    orchestrator?.notifyAsk(ask) // second heartbeat: wake on blocks, not just turns
  }
  spine.onQuestion = (ask) => send('question-ask', ask)
  spine.start()
  // The issue store: replay the log into memory before the window can ask for it,
  // and re-push the whole projection to the board on every applied action.
  issues.onChange = (snapshot) => send('issue-update', snapshot)
  issues.load()
  // The in-app orchestrator: drives the canvas via the Agent SDK. Reads the
  // latest published RemoteState for `list_world`; dispatches mutations and
  // confirms to the renderer (see the orchestrator-* IPC below).
  // Voice I/O for the orchestrator: mic PCM streams up over IPC, transcripts and
  // synthesized audio stream back. No-ops gracefully when SONIOX_API_KEY is unset.
  // Each callback fans to BOTH the desktop renderer (IPC) and every connected
  // phone (the /orch socket) — voice is shared output. A terminal STT event
  // (final / error) also releases the single-talker lease (see startVoice).
  voice = new SonioxVoice({
    onPartial: (text) => {
      send('voice-stt-partial', text)
      spine.remote.broadcastVoice({ t: 'stt-partial', text })
    },
    onFinal: (text) => {
      send('voice-stt-final', text)
      spine.remote.broadcastVoice({ t: 'stt-final', text })
      voiceLease = null
    },
    onError: (message) => {
      send('voice-stt-error', message)
      spine.remote.broadcastVoice({ t: 'stt-error', message })
      voiceLease = null
    },
    onTtsAudio: (pcm) => {
      send('voice-tts-audio', pcm)
      spine.remote.broadcastTtsAudio(pcm)
    },
    onTtsReset: () => {
      send('voice-tts-reset')
      spine.remote.broadcastVoice({ t: 'tts-reset' })
    },
  })
  orchestrator = new Orchestrator({
    send,
    // The voice taps the orchestrator's typed events (speaks the assistant lines)
    // and paces actions to playback — both owned by SonioxVoice, see voice/soniox.ts.
    speak: (e) => voice?.speakEvent(e),
    awaitVoiceCaughtUp: () => voice?.awaitCaughtUp() ?? Promise.resolve(),
    getState: () => spine.remote.getLatestState(),
    // The autonomous cascade reads the winning idea + a canvas's active sprints here.
    issueSnapshot: () => issues.snapshot(),
    // The off-card idea tournament writes its Conception and runs in the canvas repo.
    applyIssue: (a) => issues.apply(a),
    canvasDir: (projectId) => latestWorkspace?.projects.find((p) => p.id === projectId)?.dir,
    writeToCard: (cardId, data) => ptys.write(cardId, data),
    getReply: (cardId) => spine.lastReply(cardId),
    // A role skill's invocation in the target CLI's native syntax — resolved by
    // the spine's adapter registry, so the bus never branches on CliKind.
    skillRef: (cli, name) => spine.skillRef(cli, name),
    decideAsk: (askId, decision) => {
      spine.decide(askId, decision)
      send('ask-decided', askId) // clear the renderer's toast (as the phone path does)
    },
    // Tier-B CDP browser driving (falls back to the renderer path on failure).
    browser: browserController,
    // Play the scan-line flourish on a browser card when its page is captured.
    notifyBrowserScan: (cardId) => send('browser-scan', cardId),
    // The phone is a second client: fan events to it, and show/clear its copy of
    // the manual-mode confirm gate under the same id as the desktop command.
    remoteEmit: (e) => spine.remote.broadcastOrchEvent(e),
    remoteConfirm: (id, title, detail) => spine.remote.broadcastConfirm(id, title, detail),
    remoteClearConfirm: (id) => spine.remote.broadcastConfirmClear(id),
    remoteMode: (mode) => spine.remote.broadcastMode(mode),
    // Proactive reach-out: a web-push so the mastermind's unprompted line reaches Rakan
    // even with the app backgrounded (skipped when the desktop is focused).
    pushToPhone: (title, body) => spine.remote.pushNote(title, body),
  })
  // Echo every agent's finished turn into the supervision chat the instant its
  // Stop hook fires — the orchestrator becomes aware of the fleet, not just
  // commanded by it.
  spine.onReply = (cardId, reply) => orchestrator?.notifyAgentReply(cardId, reply)
  // Board milestones (e.g. a plan was approved) wake the mastermind to drive the
  // next cascade step — partner/autonomous only; manual ignores them.
  issues.onMilestone = (m) => orchestrator?.notifyMilestone(m)
  // When the reactor's reviewers author/patch a skill: recycle the orchestrator session so
  // it reloads the library (the SDK can't hot-swap skills mid-session — the reactor learns,
  // the orchestrator uses), AND push the fresh snapshot so the renderer's Skills gallery
  // refreshes live.
  setSkillsChangedListener(() => {
    orchestrator?.notifySkillsChanged()
    send('skills-update', skillsSnapshot())
  })
  // Agent-facing browser tools: a loopback HTTP MCP server attached to every
  // card via --mcp-config, driving browsers through the orchestrator's bus. It
  // shares the spine's token (cards authenticate as their hooks do) and a stable
  // port (surviving sessions read their mcp.json url once at launch).
  const agentBrowserMcp = new AgentBrowserMcp({
    bus: orchestrator.commandBus,
    getState: () => spine.remote.getLatestState(),
    token: spine.token,
    ensureReady: (cardId) => browserController.ensureReady(cardId),
  })
  // Agent-facing issue tools: a second loopback MCP server attached per card via
  // --mcp-config, talking directly to the IssueStore (main is the single arbiter),
  // scoped to the caller card's canvas.
  const orch = orchestrator // non-null here; captured for the deferred dep below
  const agentIssueMcp = new AgentIssueMcp({
    apply: (action) => issues.apply(action),
    snapshot: () => issues.snapshot(),
    getState: () => spine.remote.getLatestState(),
    token: spine.token,
    requestWorkers: (leadCardId, count, brief) =>
      orch.requestWorkers(leadCardId, count, brief),
  })
  // Agent-facing canvas-core tools: the CLI-agnostic update_plan / ask_user,
  // attached to every card. update_plan pushes the checklist to the renderer over
  // the same `card-event` channel the spine uses for hook-derived status.
  const canvasMcp = new AgentCanvasMcp({
    token: spine.token,
    emitCardEvent: (cardId, event) => send('card-event', cardId, event),
    onQuestion: (ask) => send('question-ask', ask),
  })
  agentCanvasMcp = canvasMcp
  // Every agent-facing MCP server rides the same lifecycle: bind its stable
  // (persisted) port, then attachMcp persists it and stages the per-card config
  // across every CLI adapter. The id doubles as the card's tool namespace
  // (`mcp__<id>__*`). Adding a server = construct it above, list it here.
  const agentMcps: [id: string, server: AgentMcpServer, opts?: McpStageOpts][] = [
    ['browser', agentBrowserMcp],
    ['issues', agentIssueMcp],
    // ask_user blocks on a human decision — declare the long per-tool timeout
    // here, where the server's behavior is known.
    ['canvas', canvasMcp, { toolTimeoutSec: 3600 }],
  ]
  for (const [id, server, opts] of agentMcps) {
    server.start(spine.mcpPort(id), (port) => {
      spine.attachMcp(id, port, opts)
      console.log(`[${id}-mcp] ready on 127.0.0.1:${port}`)
    })
  }
  // Stall detection: an assigned worker can go silent (hung, not just slow). A card's
  // statusSince only moves on a status change, so a long `running` task is indistinguishable
  // from a hang — the true signal is the per-card last hook event (spine.lastEventAt). Sweep
  // owned, in-flight issues each minute; when the owner is `running` yet silent past the
  // threshold, latch the issue stalled (fires the `stalled` milestone). Edge-triggered via
  // issue.setStall, so the log only grows on an actual transition.
  const STALL_THRESHOLD_MS = 8 * 60 * 1000
  // Cards we've flipped to `stalled` from the heartbeat — edge-trigger so we emit only on
  // the running→silent transition and can re-trigger once a card shows life again.
  const stalledCards = new Set<string>()
  stallSweep = setInterval(() => {
    const state = spine.remote.getLatestState()
    if (!state) return
    const now = Date.now()
    const cardStatus = new Map(state.cards.map((c) => [c.id, c.status]))
    for (const issue of issues.snapshot().issues) {
      if (!issue.owner) continue
      if (issue.status !== 'claimed' && issue.status !== 'in_progress') continue
      const last = spine.lastEventAt(issue.owner)
      // Judge only on positive evidence. No heartbeat yet (e.g. just after a restart,
      // before the reattached card has emitted) → can't tell hung from quiet, so leave
      // the latch untouched (a persisted stall survives until the card shows life).
      if (last === undefined) continue
      // A stall = the card thinks it's working yet has gone silent past the threshold.
      // waiting-on-human / done flips status off `running`, which clears the latch.
      const silent = cardStatus.get(issue.owner) === 'running' && now - last > STALL_THRESHOLD_MS
      if (silent === (issue.stalledAt != null)) continue // no edge → nothing to do
      issues.apply({ kind: 'issue.setStall', id: issue.id, stalled: silent })
    }
    // Card-level stall — the CLI-agnostic guard against a card glowing `running` forever.
    // Claude gets `StopFailure` on an API-error turn death; codex has no such event, so a
    // dead codex turn is only detectable as silence. Any agent card that thinks it's
    // `running` yet has gone silent past the threshold is flipped to `stalled` (the honest
    // "hung or just quiet — can't tell" label; a real event revives it). Self-healing: the
    // card's next hook overrides this, and clearing the mark lets a later silence re-fire.
    for (const c of state.cards) {
      if (c.kind !== 'agent') continue
      if (c.status !== 'running') {
        // Moved off `running` by a real event (done/blocked/idle) — allow re-trigger later.
        // `stalled` itself is our own emit; leave it marked so we don't re-emit each tick.
        if (c.status !== 'stalled') stalledCards.delete(c.id)
        continue
      }
      const last = spine.lastEventAt(c.id)
      if (last === undefined) continue // no heartbeat yet — can't judge (see above)
      if (now - last <= STALL_THRESHOLD_MS) {
        stalledCards.delete(c.id) // fresh activity — clear the mark so a future silence re-fires
        continue
      }
      if (stalledCards.has(c.id)) continue // already flipped — no re-emit
      stalledCards.add(c.id)
      send('card-event', c.id, {
        status: 'stalled',
        detail: `Silent for ${STALL_THRESHOLD_MS / 60000}m — possibly hung`,
        noteworthy: true,
      })
    }
  }, 60 * 1000)
  // ponytail: skill-library aging (mastermind/curator.ts ageSkills) is unwired — the
  // library is empty until the reviewer authors skills over weeks, so there's nothing to
  // age yet. Wire a timer here when the library is worth aging.
  // Heartbeat: a slow idle tick that wakes the mastermind in a quiet moment. It looks
  // over Rakan's whole world (already in its context) and decides for itself whether
  // anything needs him — reaching out via the notify_user tool if so, staying silent if
  // not. Manual mode and a live turn skip it (guarded in heartbeat()). Cleared in before-quit.
  heartbeatTimer = setInterval(() => orchestrator?.heartbeat(), 20 * 60 * 1000)
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
  issues.compact() // no-op today (each apply is durable); the future-compaction seam
  if (stallSweep) clearInterval(stallSweep)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  diffWatchers.disposeAll()
  orchestrator?.dispose()
  voice?.dispose()
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

// A browser card has no pty and no tmux/spine session — it's an in-DOM
// <webview>. We only mint its id here (so the `browser-` prefix is consistent
// with `card-`/`shell-`); the renderer owns its url. `folder` just tags it with
// the active project's dir; the picker is never shown.
ipcMain.handle('new-browser', async (_e, folder?: string, _url?: string) => {
  const dir = folder ?? (await pickFolder('Choose the folder for this browser'))
  if (!dir) return null
  const cardId = `browser-${Date.now().toString(36)}-${nextItem++}`
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
  (
    _e,
    cardId: string,
    folder: string,
    cols: number,
    rows: number,
    kind: 'agent' | 'shell',
    cli?: CliKind,
  ) => {
    if (ptys.has(cardId)) return
    const initialPrompt = pendingPrompts.get(cardId)
    pendingPrompts.delete(cardId)
    ptys.spawn(
      cardId,
      spine.launch(cardId, folder, { bareShell: kind === 'shell', initialPrompt, cli }),
      {
        onData: (d) => send('pty-data', cardId, d),
        onExit: () => send('pty-exit', cardId),
      },
      cols,
      rows,
    )
  },
)

ipcMain.handle('available-clis', () => spine.availableClis())
ipcMain.handle('pane-command', (_e, cardId: string) => spine.paneCommand(cardId))
ipcMain.handle('pane-cwd', (_e, cardId: string) => spine.paneCwd(cardId))
ipcMain.handle('load-workspace', async () => {
  const ws = await workspace.load()
  latestWorkspace = ws // seed the dir lookup before the renderer's first save-back
  // Seed each agent card's CLI into the spine, so hooks from tmux sessions that
  // survived the restart resolve the right adapter before their cards remount.
  for (const c of ws?.cards ?? []) {
    if (c.kind === 'agent' && c.cli) spine.setCardCli(c.id, c.cli)
  }
  return ws
})
ipcMain.on('save-workspace', (_e, snapshot: MultiProjectSnapshot) => {
  latestWorkspace = snapshot
  workspace.save(snapshot)
})
ipcMain.handle('load-issue-store', () => issues.snapshot())
ipcMain.handle('issue-action', (_e, action: IssueActionRequest) => issues.apply(action))
ipcMain.handle('load-mastermind-skills', () => skillsSnapshot())

ipcMain.handle('kill-card', (_e, cardId: string) => {
  ptys.kill(cardId)
  spine.killSession(cardId)
})

ipcMain.on('pty-write', (_e, cardId: string, data: string) => ptys.write(cardId, data))
ipcMain.handle('leave-scrollback', (_e, cardId: string) => spine.leaveScrollback(cardId))
ipcMain.on('pty-resize', (_e, cardId: string, cols: number, rows: number) =>
  ptys.resize(cardId, cols, rows),
)
// Question/ask decisions route to whichever holder owns the id: a `q-<n>` ask_user
// call lives in the canvas MCP (answer/decline settle the held tool call); an
// `ask-<n>` hook ask lives in the spine. The canvas MCP's methods return false when
// they don't own the id, so we fall through to the spine.
ipcMain.on('decide-ask', (_e, askId: string, decision: AskDecision) => {
  if (!agentCanvasMcp?.decline(askId)) spine.decide(askId, decision)
})
ipcMain.on('answer-question', (_e, askId: string, answers: QuestionAnswers) => {
  if (!agentCanvasMcp?.answer(askId, answers)) spine.answerQuestion(askId, answers)
})
ipcMain.on('release-asks', (_e, cardId: string) => {
  spine.releaseFor(cardId)
  agentCanvasMcp?.releaseFor(cardId)
})

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
  if (!agentCanvasMcp?.answer(askId, answers)) spine.answerQuestion(askId, answers)
  send('question-decided', askId)
}
spine.remote.onDecline = (askId) => {
  if (!agentCanvasMcp?.decline(askId)) spine.decide(askId, 'deny')
  send('question-decided', askId)
}
// Skip the phone push when you're already at the desktop.
spine.remote.isDesktopFocused = () => win?.isFocused() ?? false
// The phone as a second orchestrator client (over the /orch socket). Prompts /
// mode / confirm decisions drive the same shared session; voice is lease-guarded
// so only the active talker's mic audio is honored. Optional-chained like the
// callbacks above so wiring at module load is safe before app.whenReady assigns
// the singletons.
spine.remote.getMode = () => orchestrator?.currentMode ?? 'manual'
spine.remote.voiceAvailable = () => voice?.available ?? false
spine.remote.onOrchPrompt = (text) => void orchestrator?.run(text)
spine.remote.onOrchMode = (mode) => orchestrator?.setMode(mode)
spine.remote.onOrchConfirm = (id, allow) => orchestrator?.resolveRemoteConfirm(id, allow)
spine.remote.onVoiceStart = (ws) => startVoice(ws)
spine.remote.onVoiceAudio = (ws, pcm) => {
  if (voiceLease === ws) voice?.pushAudio(pcm)
}
spine.remote.onVoiceFinish = (ws) => {
  if (voiceLease === ws) voice?.finishStt() // lease released on the final/error callback
}
spine.remote.onVoiceCancel = (ws) => {
  if (voiceLease === ws) {
    voice?.cancelStt()
    voiceLease = null
  }
}
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
// A browser card's guest reached dom-ready (number id) or was torn down (null) —
// feeds the readiness map that browser tools await instead of a fixed delay.
ipcMain.on('browser-ready', (_e, cardId: string, webContentsId: number | null) => {
  if (typeof webContentsId === 'number' && webContentsId >= 0) {
    browserController.markReady(cardId, webContentsId)
  } else {
    browserController.markGone(cardId)
  }
})
// Set the orchestrator's mode (manual / partner / autonomous).
ipcMain.on('orchestrator-mode', (_e, mode: OrchestratorMode) => orchestrator?.setMode(mode))

// MARK: Voice — push-to-talk STT and the orchestrator's spoken replies. The
// renderer captures mic PCM and plays back TTS PCM; main owns the Soniox sockets.
ipcMain.handle('voice-available', () => voice?.available ?? false)
// Onboarding: validate the pasted key against Soniox, then store it OS-encrypted.
// The plaintext key crosses IPC only this once (local, first-party) and is never
// sent back; the renderer only learns success and that voice is now available.
ipcMain.handle('voice-save-key', async (_e, key: string) => {
  const result = await validateSonioxKey(key)
  if (!result.ok) return result
  if (!storeSonioxKey(key)) {
    return { ok: false, message: 'Secure storage is unavailable on this system.' }
  }
  send('voice-availability', true)
  return { ok: true }
})
ipcMain.on('voice-stt-start', () => {
  // Barge-in: grabbing the mic talks over the orchestrator. startVoice drops the
  // audio still playing AND interrupts the turn (so a multi-block turn can't start
  // a fresh spoken line a beat later) — refused if a phone holds the floor.
  startVoice('desktop')
})
ipcMain.on('voice-stt-audio', (_e, chunk: ArrayBuffer | Uint8Array) => {
  if (voiceLease === 'desktop') voice?.pushAudio(Buffer.from(chunk as ArrayBuffer))
})
ipcMain.on('voice-stt-finish', () => {
  if (voiceLease === 'desktop') voice?.finishStt() // lease released on final/error
})
ipcMain.on('voice-stt-cancel', () => {
  if (voiceLease === 'desktop') {
    voice?.cancelStt()
    voiceLease = null
  }
})
// The renderer's TTS player reports playback start/stop; drives action pacing.
ipcMain.on('voice-playing', (_e, playing: boolean) => voice?.setPlaying(playing))
// Queue an initial prompt for a not-yet-spawned card (set just before mount).
ipcMain.on('set-initial-prompt', (_e, cardId: string, prompt: string) => {
  if (typeof cardId === 'string' && typeof prompt === 'string' && prompt) {
    pendingPrompts.set(cardId, prompt)
  }
})
