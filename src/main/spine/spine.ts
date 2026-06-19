import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HookSink, type HookRequest } from './hookSink'
import { ClaudeAdapter, shellQuote } from './claudeAdapter'
import { Tmux } from './tmux'
import * as pty from 'node-pty'
import { RemoteServer, type TermSession } from '../remote/remoteServer'
import { PushService } from '../remote/push'
import type {
  AskDecision,
  CardEvent,
  PermissionAskInfo,
  QuestionAnswers,
  QuestionAskInfo,
} from '../../shared/types'

// DELIBERATELY ISOLATED from the shipping Swift app: own config dir, own tmux
// socket. The two canvases can run side by side until cutover, when this
// becomes ~/.agentcanvas + 'agentcanvas' and inherits the production fleet.
export const SPINE_DIR = join(homedir(), '.agentcanvas-web')
const SOCKET = 'agentcanvas-web'

/// The spine's persistent identity — token + sink port — survives app restarts.
/// tmux sessions outlive the app: a running `claude` read its hook URL + token
/// once at launch, so a fresh port or token after relaunch would leave every
/// surviving session posting into the void.
interface SpineConfig {
  token: string
  sinkPort?: number
  /** The remote panel's port — persisted so a `tailscale serve` route set up
   *  once keeps pointing at the right place across app restarts. */
  remotePort?: number
  /** The agent-browser MCP server's port — persisted for the same reason as the
   *  sink: surviving tmux sessions read their mcp.json url once at launch. */
  browserMcpPort?: number
  /** The agent-issue MCP server's port — persisted for the same reason. */
  issueMcpPort?: number
}

function loadConfig(): SpineConfig {
  try {
    const cfg = JSON.parse(readFileSync(join(SPINE_DIR, 'spine.json'), 'utf8'))
    if (typeof cfg.token === 'string' && cfg.token) return cfg
  } catch {
    // first run / unreadable → fresh identity
  }
  return { token: randomUUID() }
}

function saveConfig(cfg: SpineConfig): void {
  mkdirSync(SPINE_DIR, { recursive: true })
  const file = join(SPINE_DIR, 'spine.json')
  writeFileSync(file, JSON.stringify(cfg, null, 2))
  chmodSync(file, 0o600) // carries the sink token — same secrecy rules as hooks.json
}

export interface LaunchSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

interface HeldAsk {
  cardId: string
  respond: (body: string | null) => void
  /** The original tool_input — present for question asks, whose answer body
   *  must spread it back so `questions` survives the round-trip. */
  input?: Record<string, unknown>
}

/// The attention spine: owns the sink, the adapter, and the tmux launch path;
/// turns raw hook payloads into (cardId, CardEvent) updates plus held
/// permission asks decided by id. (Port of the Swift Spine.)
export class Spine {
  onUpdate?: (cardId: string, event: CardEvent) => void
  onAsk?: (ask: PermissionAskInfo) => void
  onQuestion?: (ask: QuestionAskInfo) => void
  /** A card just finished a turn, carrying its full final reply — the
   *  orchestrator echoes it into the supervision chat. */
  onReply?: (cardId: string, reply: string) => void

  /** The remote supervision panel (loopback; exposed via Tailscale Serve). */
  readonly remote = new RemoteServer()

  private adapter = new ClaudeAdapter()
  private tmux = new Tmux(SPINE_DIR, SOCKET)
  private config = loadConfig()
  private sink = new HookSink(this.config.token)
  private asks = new Map<string, HeldAsk>()
  private askSeq = 1
  /** Last full assistant reply per card, captured from the Stop hook's
   *  `last_assistant_message` — read by the orchestrator's get_agent_reply. */
  private replies = new Map<string, string>()

  start(): void {
    this.tmux.prepare()
    // Materialize the curated skill plugin up front (no sink/port dependency) so
    // every card launched after this is equipped via --plugin-dir.
    this.adapter.stageSkills(SPINE_DIR)
    this.sink.onRequest = (req) => this.handle(req)
    // hooks.json embeds the sink's URL, so it's written once the port is
    // bound. Cards spawn lazily, long after.
    this.sink.start(this.config.sinkPort, (port) => {
      this.config.sinkPort = port
      saveConfig(this.config)
      this.adapter.installConfig(SPINE_DIR, port, this.config.token)
      console.log(`[spine] sink ready on 127.0.0.1:${port}`)
    })
    this.remote.push = new PushService(join(SPINE_DIR, 'push.json'))
    this.remote.openTerminal = (cardId, cols, rows) => this.openTerminal(cardId, cols, rows)
    this.remote.start(this.config.remotePort, (port) => {
      this.config.remotePort = port
      saveConfig(this.config)
      console.log(
        `[spine] remote panel on http://127.0.0.1:${port} — expose with: tailscale serve --bg localhost:${port}`,
      )
    })
  }

  /** The spine's persistent loopback token — shared with the agent-browser MCP
   *  server so cards authenticate to it the same way their hooks do. */
  get token(): string {
    return this.config.token
  }

  /** The agent-browser MCP server's last-bound port (preferred on restart so
   *  surviving sessions' mcp.json url stays valid). */
  get browserMcpPort(): number | undefined {
    return this.config.browserMcpPort
  }

  /** Persist the agent-browser MCP port and stage the per-card `--mcp-config`
   *  (the adapter writes browser-mcp.json; cards launched after are equipped). */
  attachBrowserMcp(port: number): void {
    this.config.browserMcpPort = port
    saveConfig(this.config)
    this.adapter.stageBrowserMcp(SPINE_DIR, port, this.config.token)
  }

  /** The agent-issue MCP server's last-bound port (preferred on restart). */
  get issueMcpPort(): number | undefined {
    return this.config.issueMcpPort
  }

  /** Persist the agent-issue MCP port and stage its per-card `--mcp-config`
   *  (the adapter writes issue-mcp.json alongside the browser one). */
  attachIssueMcp(port: number): void {
    this.config.issueMcpPort = port
    saveConfig(this.config)
    this.adapter.stageIssueMcp(SPINE_DIR, port, this.config.token)
  }

  /** The single source of truth for a card's tmux session name. The one mapping
   *  to change at the future ~/.agentcanvas namespace cutover. */
  private sessionName(cardId: string): string {
    return `canvas-${cardId}`
  }

  /** How a card's process launches: the tmux client (`new-session -A` creates
   *  or reattaches), running `claude` under the user's login shell inside the
   *  session so it resolves from their real PATH — or, for a plain-shell
   *  card, just the login shell itself (no agent, no hooks). No tmux →
   *  direct spawn (dies with the app — the canvas never refuses to work). */
  launch(cardId: string, folder: string, bareShell = false, initialPrompt?: string): LaunchSpec {
    const shell = process.env.SHELL ?? '/bin/zsh'
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CANVAS_CARD_ID: cardId,
      TERM: 'xterm-256color',
    }
    const launch = this.adapter.launchCommand(initialPrompt)
    const inner = bareShell ? `${shell} -l` : `${shell} -lc ${shellQuote(launch)}`
    const client = this.tmux.clientCommand(this.sessionName(cardId), inner, folder, cardId)
    if (client) return { file: client.file, args: client.args, cwd: folder, env }
    return {
      file: shell,
      args: bareShell ? ['-l'] : ['-lc', launch],
      cwd: folder,
      env,
    }
  }

  /** Re-probe the tmux substrate if it was missing at startup — the setup
   *  gate installs it mid-session, and new cards should land in tmux without
   *  an app restart. No-op once the binary is known. */
  ensureTmuxPrepared(): void {
    if (!this.tmux.binary) this.tmux.prepare()
  }

  /** End a card's tmux session (✕ delete). Killing only the terminal client
   *  would merely *detach* — the agent would keep running headless, exactly
   *  the unsupervised state the canvas exists to prevent. */
  killSession(cardId: string): void {
    this.tmux.kill(this.sessionName(cardId))
  }

  /** Snap a card's session out of scrollback (tmux copy-mode), if it's in
   *  it — the renderer awaits this before the first keystroke after a
   *  wheel-scroll. */
  leaveScrollback(cardId: string): Promise<void> {
    return this.tmux.cancelCopyMode(this.sessionName(cardId))
  }

  /** The CLI's stored plan for a session — the re-hydration read. */
  todos(sessionId: string) {
    return this.adapter.currentTodos(sessionId)
  }

  /** A card's last full assistant reply (from its most recent finished turn),
   *  or null if it hasn't finished a turn since launch. */
  lastReply(cardId: string): string | null {
    return this.replies.get(cardId) ?? null
  }

  /** The foreground process in a card's pane — feeds the shell card's title. */
  paneCommand(cardId: string): Promise<string | null> {
    return this.tmux.paneCommand(this.sessionName(cardId))
  }

  /** The card pane's current working directory — feeds the shell card's title. */
  paneCwd(cardId: string): Promise<string | null> {
    return this.tmux.paneCwd(this.sessionName(cardId))
  }

  /** Answer a held permission ask. Exactly one decision wins; the rest no-op. */
  decide(askId: string, decision: AskDecision): void {
    const ask = this.asks.get(askId)
    if (!ask) return
    this.asks.delete(askId)
    if (decision === 'allow') ask.respond(this.adapter.permissionAllowBody())
    else if (decision === 'deny') ask.respond(this.adapter.permissionDenyBody())
    else ask.respond(null) // no decision → the native dialog falls through to the terminal
  }

  /** Answer a held AskUserQuestion with the chosen options — allows the tool
   *  with the answers injected into its input. Declining is `decide(_, 'deny')`,
   *  which the CLI renders as "User declined to answer questions". */
  answerQuestion(askId: string, answers: QuestionAnswers): void {
    const ask = this.asks.get(askId)
    if (!ask) return
    this.asks.delete(askId)
    ask.respond(this.adapter.questionAnswerBody(ask.input, answers))
  }

  /** Attach a fresh tmux client to a card's session for the mobile terminal —
   *  a second, live-mirrored view alongside the desktop (tmux is multi-client).
   *  One pty per phone connection (not the card's primary pty); killing it just
   *  detaches that client. Null when tmux is unavailable. */
  openTerminal(cardId: string, cols: number, rows: number): TermSession | null {
    const session = this.sessionName(cardId)
    const cmd = this.tmux.attachCommand(session)
    if (!cmd) return null
    const p = pty.spawn(cmd.file, cmd.args, {
      name: 'xterm-256color',
      cols: cols > 0 ? cols : 80,
      rows: rows > 0 ? rows : 24,
      cwd: SPINE_DIR,
      env: process.env as Record<string, string>,
    })
    return {
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit(() => cb()),
      write: (d) => p.write(d),
      resize: (c, r) => {
        if (c > 0 && r > 0) p.resize(c, r)
      },
      scroll: (lines) => this.tmux.scroll(session, lines),
      kill: () => p.kill(),
    }
  }

  /** Release every held ask for a card — the fly-in path: while held, the
   *  terminal shows no dialog, so focusing the terminal must release. */
  releaseFor(cardId: string): void {
    for (const [askId, ask] of this.asks) {
      if (ask.cardId === cardId) {
        this.asks.delete(askId)
        ask.respond(null)
      }
    }
  }

  private handle(req: HookRequest): void {
    // AskUserQuestion rides the PermissionRequest channel but is a question, not
    // a gate — siphon it off first so it gets the chooser, never an Allow/Deny.
    if (this.adapter.isQuestionAsk(req.event, req.payload)) {
      const event = this.adapter.event(req.event, req.payload)
      if (event) this.onUpdate?.(req.cardId, event)
      const questions = this.adapter.parseQuestions(req.payload)
      const askId = `ask-${this.askSeq++}`
      this.asks.set(askId, {
        cardId: req.cardId,
        respond: req.respond,
        input:
          typeof req.payload.tool_input === 'object' && req.payload.tool_input !== null
            ? (req.payload.tool_input as Record<string, unknown>)
            : undefined,
      })
      // Nobody to render it (or nothing parseable) → fall through to the
      // terminal's own picker rather than strand the agent.
      if (this.onQuestion && questions.length) {
        this.onQuestion({ askId, cardId: req.cardId, questions })
      } else {
        this.decide(askId, 'release')
      }
    } else if (this.adapter.isPermissionAsk(req.event)) {
      // Status first (the card goes loud), then hold the response open as the
      // decision channel. While held, the CLI's own dialog is deferred.
      const event = this.adapter.event(req.event, req.payload)
      if (event) this.onUpdate?.(req.cardId, event)
      const askId = `ask-${this.askSeq++}`
      this.asks.set(askId, { cardId: req.cardId, respond: req.respond })
      if (this.onAsk) {
        this.onAsk({ askId, cardId: req.cardId, detail: event?.detail ?? 'Permission requested' })
      } else {
        this.decide(askId, 'release') // nobody to decide → terminal dialog
      }
    } else {
      req.respond(null) // telemetry never blocks the agent
      // Capture the agent's full final reply when a turn finishes — the
      // orchestrator reads it back via get_agent_reply. Stop carries the
      // complete text in last_assistant_message; the CardEvent keeps only a
      // clipped summary.
      if (req.event === 'Stop' && typeof req.payload.last_assistant_message === 'string') {
        this.replies.set(req.cardId, req.payload.last_assistant_message)
        this.onReply?.(req.cardId, req.payload.last_assistant_message)
      }
      const event = this.adapter.event(req.event, req.payload)
      if (event) this.onUpdate?.(req.cardId, event)
    }
  }
}
