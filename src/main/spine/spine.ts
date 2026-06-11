import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HookSink, type HookRequest } from './hookSink'
import { ClaudeAdapter, shellQuote } from './claudeAdapter'
import { Tmux } from './tmux'
import type { AskDecision, CardEvent, PermissionAskInfo } from '../../shared/types'

// DELIBERATELY ISOLATED from the shipping Swift app: own config dir, own tmux
// socket. The two canvases can run side by side until cutover, when this
// becomes ~/.agentcanvas + 'agentcanvas' and inherits the production fleet.
const DIR = join(homedir(), '.agentcanvas-web')
const SOCKET = 'agentcanvas-web'

/// The spine's persistent identity — token + sink port — survives app restarts.
/// tmux sessions outlive the app: a running `claude` read its hook URL + token
/// once at launch, so a fresh port or token after relaunch would leave every
/// surviving session posting into the void.
interface SpineConfig {
  token: string
  sinkPort?: number
}

function loadConfig(): SpineConfig {
  try {
    const cfg = JSON.parse(readFileSync(join(DIR, 'spine.json'), 'utf8'))
    if (typeof cfg.token === 'string' && cfg.token) return cfg
  } catch {
    // first run / unreadable → fresh identity
  }
  return { token: randomUUID() }
}

function saveConfig(cfg: SpineConfig): void {
  mkdirSync(DIR, { recursive: true })
  const file = join(DIR, 'spine.json')
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
}

/// The attention spine: owns the sink, the adapter, and the tmux launch path;
/// turns raw hook payloads into (cardId, CardEvent) updates plus held
/// permission asks decided by id. (Port of the Swift Spine.)
export class Spine {
  onUpdate?: (cardId: string, event: CardEvent) => void
  onAsk?: (ask: PermissionAskInfo) => void

  private adapter = new ClaudeAdapter()
  private tmux = new Tmux(DIR, SOCKET)
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
      this.adapter.installConfig(DIR, port, this.config.token)
      console.log(`[spine] sink ready on 127.0.0.1:${port}`)
    })
  }

  /** How a card's process launches: the tmux client (`new-session -A` creates
   *  or reattaches), running `claude` under the user's login shell inside the
   *  session so it resolves from their real PATH. No tmux → direct spawn
   *  (dies with the app — the canvas never refuses to work). */
  launch(cardId: string, folder: string): LaunchSpec {
    const shell = process.env.SHELL ?? '/bin/zsh'
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CANVAS_CARD_ID: cardId,
      TERM: 'xterm-256color',
    }
    const inner = `${shell} -lc ${shellQuote(this.adapter.launchCommand())}`
    const client = this.tmux.clientCommand(`canvas-${cardId}`, inner, folder, cardId)
    if (client) return { file: client.file, args: client.args, cwd: folder, env }
    return { file: shell, args: ['-lc', this.adapter.launchCommand()], cwd: folder, env }
  }

  /** End a card's tmux session (✕ delete). Killing only the terminal client
   *  would merely *detach* — the agent would keep running headless, exactly
   *  the unsupervised state the canvas exists to prevent. */
  killSession(cardId: string): void {
    this.tmux.kill(`canvas-${cardId}`)
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
    if (this.adapter.isPermissionAsk(req.event)) {
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
