import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HookSink, type HookRequest } from './hookSink'
import { ClaudeAdapter, shellQuote } from './claudeAdapter'
import { Tmux } from './tmux'
import { RemoteServer } from '../remote/remoteServer'
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
  input?: Record<string, any>
}

/// The attention spine: owns the sink, the adapter, and the tmux launch path;
/// turns raw hook payloads into (cardId, CardEvent) updates plus held
/// permission asks decided by id. (Port of the Swift Spine.)
export class Spine {
  onUpdate?: (cardId: string, event: CardEvent) => void
  onAsk?: (ask: PermissionAskInfo) => void
  onQuestion?: (ask: QuestionAskInfo) => void

  /** The remote supervision panel (loopback; exposed via Tailscale Serve). */
  readonly remote = new RemoteServer()

  private adapter = new ClaudeAdapter()
  private tmux = new Tmux(SPINE_DIR, SOCKET)
  private config = loadConfig()
  private sink = new HookSink(this.config.token)
  private asks = new Map<string, HeldAsk>()
  private askSeq = 1

  start(): void {
    this.tmux.prepare()
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
    this.remote.start(this.config.remotePort, (port) => {
      this.config.remotePort = port
      saveConfig(this.config)
      console.log(
        `[spine] remote panel on http://127.0.0.1:${port} — expose with: tailscale serve --bg localhost:${port}`,
      )
    })
  }

  /** How a card's process launches: the tmux client (`new-session -A` creates
   *  or reattaches), running `claude` under the user's login shell inside the
   *  session so it resolves from their real PATH — or, for a plain-shell
   *  card, just the login shell itself (no agent, no hooks). No tmux →
   *  direct spawn (dies with the app — the canvas never refuses to work). */
  launch(cardId: string, folder: string, bareShell = false): LaunchSpec {
    const shell = process.env.SHELL ?? '/bin/zsh'
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CANVAS_CARD_ID: cardId,
      TERM: 'xterm-256color',
    }
    const inner = bareShell ? `${shell} -l` : `${shell} -lc ${shellQuote(this.adapter.launchCommand())}`
    const client = this.tmux.clientCommand(`canvas-${cardId}`, inner, folder, cardId)
    if (client) return { file: client.file, args: client.args, cwd: folder, env }
    return {
      file: shell,
      args: bareShell ? ['-l'] : ['-lc', this.adapter.launchCommand()],
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
    this.tmux.kill(`canvas-${cardId}`)
  }

  /** Snap a card's session out of scrollback (tmux copy-mode), if it's in
   *  it — the renderer awaits this before the first keystroke after a
   *  wheel-scroll. */
  leaveScrollback(cardId: string): Promise<void> {
    return this.tmux.cancelCopyMode(`canvas-${cardId}`)
  }

  /** The CLI's stored plan for a session — the re-hydration read. */
  todos(sessionId: string) {
    return this.adapter.currentTodos(sessionId)
  }

  /** The foreground process in a card's pane — feeds the shell card's title. */
  paneCommand(cardId: string): Promise<string | null> {
    return this.tmux.paneCommand(`canvas-${cardId}`)
  }

  /** The card pane's current working directory — feeds the shell card's title. */
  paneCwd(cardId: string): Promise<string | null> {
    return this.tmux.paneCwd(`canvas-${cardId}`)
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
        input: req.payload.tool_input as Record<string, any>,
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
      const event = this.adapter.event(req.event, req.payload)
      if (event) this.onUpdate?.(req.cardId, event)
    }
  }
}
