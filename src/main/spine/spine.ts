import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { HookSink, type HookRequest } from './hookSink'
import { ClaudeAdapter } from './claudeAdapter'
import { shellQuote, type CliAdapter, type McpStageOpts } from './cliAdapter'
import { CodexAdapter } from './codexAdapter'
import { Tmux } from './tmux'
import * as pty from 'node-pty'
import { RemoteServer, type TermSession } from '../remote/remoteServer'
import { PushService } from '../remote/push'
import type {
  AskDecision,
  AvailableCli,
  CardEvent,
  CliKind,
  PermissionAskInfo,
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
  /** Agent-MCP server ports (server id → last-bound port) — persisted for the
   *  same reason as the sink: surviving tmux sessions read their staged MCP
   *  config once at launch, so a fresh port would strand them. */
  mcpPorts: Record<string, number>
}

function loadConfig(): SpineConfig {
  try {
    const cfg = JSON.parse(readFileSync(join(SPINE_DIR, 'spine.json'), 'utf8'))
    if (typeof cfg.token === 'string' && cfg.token) {
      // Migrate the pre-registry per-server fields into the mcpPorts registry.
      const mcpPorts: Record<string, number> = { ...(cfg.mcpPorts ?? {}) }
      const legacy = { browserMcpPort: 'browser', issueMcpPort: 'issues', canvasMcpPort: 'canvas' }
      for (const [field, id] of Object.entries(legacy)) {
        if (typeof cfg[field] === 'number' && mcpPorts[id] === undefined) mcpPorts[id] = cfg[field]
        delete cfg[field]
      }
      return { ...cfg, mcpPorts }
    }
  } catch {
    // first run / unreadable → fresh identity
  }
  return { token: randomUUID(), mcpPorts: {} }
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
  /** The ask's own decision bodies, closed over by the adapter's `interpret` —
   *  so a decision can never be answered with the wrong CLI's shape. */
  allow: () => string
  deny: () => string
}

/// The attention spine: owns the sink, the adapter, and the tmux launch path;
/// turns raw hook payloads into (cardId, CardEvent) updates plus held
/// permission asks decided by id. (Port of the Swift Spine.)
export class Spine {
  onUpdate?: (cardId: string, event: CardEvent) => void
  onAsk?: (ask: PermissionAskInfo) => void
  /** A card just finished a turn, carrying its full final reply — the
   *  orchestrator echoes it into the supervision chat. */
  onReply?: (cardId: string, reply: string) => void

  /** The remote supervision panel (loopback; exposed via Tailscale Serve). */
  readonly remote = new RemoteServer()

  // Config loads first — the token below is a constructor arg of every adapter.
  private config = loadConfig()
  /** Per-CLI adapters (launch string, hook config, event mapping), each built on
   *  the same staging dir + token. A card resolves one by its CliKind; unknown/
   *  absent → claude. Adding a CLI = one adapter class + one entry here. */
  private adapters: Record<CliKind, CliAdapter> = {
    claude: new ClaudeAdapter(SPINE_DIR, this.config.token),
    codex: new CodexAdapter(SPINE_DIR, this.config.token),
  }
  /** Which CLI backs each agent card — set at launch() and seeded from the
   *  persisted workspace (setCardCli) so hooks from a session that survived an
   *  app restart resolve the right adapter even before its card relaunches. */
  private cardCli = new Map<string, CliKind>()
  private tmux = new Tmux(SPINE_DIR, SOCKET)
  private sink = new HookSink(this.config.token)
  private asks = new Map<string, HeldAsk>()
  private askSeq = 1
  /** Last full assistant reply per card, captured from the Stop hook's
   *  `last_assistant_message` — read by the orchestrator's get_agent_reply. */
  private replies = new Map<string, string>()
  /** Epoch ms of the last hook event seen per card — the true liveness heartbeat
   *  (every hook refreshes it, unlike CardMeta.statusSince which only moves on a
   *  status change). The stall sweep reads it to tell a hung worker from a slow one. */
  private lastEvent = new Map<string, number>()

  start(): void {
    this.tmux.prepare()
    // Materialize the instruction channels (baseline + role skills) up front (no
    // sink/port dependency) so every card launched after this is equipped.
    for (const a of this.allAdapters) a.stageInstructions()
    this.sink.onRequest = (req) => this.handle(req)
    // hooks.json embeds the sink's URL, so it's written once the port is
    // bound. Cards spawn lazily, long after.
    this.sink.start(this.config.sinkPort, (port) => {
      this.config.sinkPort = port
      saveConfig(this.config)
      for (const a of this.allAdapters) a.stageHooks(port)
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

  /** An agent-MCP server's last-bound port (preferred on restart so surviving
   *  sessions' staged config urls stay valid). Ids: `browser` / `issues` / `canvas`. */
  mcpPort(id: string): number | undefined {
    return this.config.mcpPorts[id]
  }

  /** Persist an agent-MCP server's port and stage its per-card config across
   *  every adapter — cards launched after are equipped with that server's
   *  `mcp__<id>__*` tools. The server declares its own needs via `opts` (e.g.
   *  the canvas server's ask_user blocks on a human → a long tool timeout). */
  attachMcp(id: string, port: number, opts?: McpStageOpts): void {
    this.config.mcpPorts[id] = port
    saveConfig(this.config)
    for (const a of this.allAdapters) a.stageMcp(id, port, opts)
  }

  /** A role skill's invocation string in a CLI's native syntax (Claude `/`,
   *  codex `$`) — resolved through the adapter, so callers never branch on
   *  CliKind and a future CLI can't silently inherit the wrong prefix. */
  skillRef(cli: CliKind | undefined, name: string): string {
    return this.adapterFor(cli).skillRef(name)
  }

  /** The adapter for a CLI kind — unknown/absent falls back to claude (the
   *  default; a retired kind in persisted data must still resolve). */
  private adapterFor(cli: CliKind = 'claude'): CliAdapter {
    return this.adapters[cli] ?? this.adapters.claude
  }

  /** The adapter backing a card (by its recorded CliKind). */
  private cardAdapter(cardId: string): CliAdapter {
    return this.adapterFor(this.cardCli.get(cardId))
  }

  /** Every registered adapter — staged in lockstep so a card of any CLI is equipped. */
  private get allAdapters(): CliAdapter[] {
    return Object.values(this.adapters)
  }

  /** Record which CLI backs an agent card. `launch()` records its own; the host
   *  also seeds this from the persisted workspace at startup, so a tmux session
   *  that survived a restart maps to the right adapter before its card remounts. */
  setCardCli(cardId: string, cli: CliKind): void {
    this.cardCli.set(cardId, cli)
  }

  /** Which registered CLIs are installed on PATH — probed over the login shell
   *  (`command -v`) for the same PATH a launched card resolves against. Feeds the
   *  spawn picker so it only offers CLIs that will actually run, each carrying
   *  its adapter-declared `unattended` fact (no permission holds — the picker
   *  says so before the human spawns one). `claude` first. */
  async availableClis(): Promise<AvailableCli[]> {
    const shell = process.env.SHELL ?? '/bin/zsh'
    const onPath = (bin: string): Promise<boolean> =>
      new Promise((res) => execFile(shell, ['-lc', `command -v ${bin}`], (err) => res(!err)))
    const found = await Promise.all(
      (Object.entries(this.adapters) as [CliKind, CliAdapter][]).map(async ([kind, a]) =>
        (await onPath(a.binary))
          ? { kind, unattended: !a.capabilities.permissionHolds }
          : null,
      ),
    )
    return found.filter((c): c is AvailableCli => !!c)
  }

  /** The single source of truth for a card's tmux session name. The one mapping
   *  to change at the future ~/.agentcanvas namespace cutover. */
  private sessionName(cardId: string): string {
    return `canvas-${cardId}`
  }

  /** How a card's process launches: the tmux client (`new-session -A` creates
   *  or reattaches), running the agent CLI under the user's login shell inside
   *  the session so it resolves from their real PATH — or, for a plain-shell
   *  card, just the login shell itself (no agent, no hooks). No tmux →
   *  direct spawn (dies with the app — the canvas never refuses to work). */
  launch(
    cardId: string,
    folder: string,
    opts: { bareShell?: boolean; initialPrompt?: string; cli?: CliKind } = {},
  ): LaunchSpec {
    const { bareShell = false, initialPrompt, cli = 'claude' } = opts
    const shell = process.env.SHELL ?? '/bin/zsh'
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CANVAS_CARD_ID: cardId,
      TERM: 'xterm-256color',
    }
    if (!bareShell) this.setCardCli(cardId, cli) // agent cards resolve their adapter in handle()
    const launch = this.adapterFor(cli).launchCommand(initialPrompt)
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
    this.lastEvent.delete(cardId)
    this.cardCli.delete(cardId)
  }

  /** Epoch ms of the last hook event from a card, or undefined if it hasn't spoken
   *  this session — the stall sweep's liveness read. */
  lastEventAt(cardId: string): number | undefined {
    return this.lastEvent.get(cardId)
  }

  /** Snap a card's session out of scrollback (tmux copy-mode), if it's in
   *  it — the renderer awaits this before the first keystroke after a
   *  wheel-scroll. */
  leaveScrollback(cardId: string): Promise<void> {
    return this.tmux.cancelCopyMode(this.sessionName(cardId))
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
    if (decision === 'allow') ask.respond(ask.allow())
    else if (decision === 'deny') ask.respond(ask.deny())
    else ask.respond(null) // no decision → the native dialog falls through to the terminal
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
    this.lastEvent.set(req.cardId, Date.now()) // any hook = proof the agent is alive
    // The payload is opaque here — every schema fact (event names, fields) is
    // the adapter's, read in ONE interpret pass. Status first (the card goes
    // loud), then settle or hold the response.
    const { event, reply, ask } = this.cardAdapter(req.cardId).interpret(req.event, req.payload)
    if (event) this.onUpdate?.(req.cardId, event)

    if (!ask) {
      req.respond(null) // telemetry never blocks the agent
      // Capture the agent's full final reply when a turn finishes — the
      // orchestrator reads it back via get_agent_reply.
      if (reply !== undefined) {
        this.replies.set(req.cardId, reply)
        this.onReply?.(req.cardId, reply)
      }
      return
    }

    // A held ask: keep the response open as the decision channel. While held,
    // the CLI's own dialog is deferred; nobody to render it → release, so the
    // agent falls through to its terminal dialog rather than stranding.
    const askId = `ask-${this.askSeq++}`
    this.asks.set(askId, { cardId: req.cardId, respond: req.respond, allow: ask.allow, deny: ask.deny })
    if (this.onAsk) {
      this.onAsk({ askId, cardId: req.cardId, detail: event?.detail ?? 'Permission requested' })
    } else {
      this.decide(askId, 'release') // nobody to decide → terminal dialog
    }
  }
}
