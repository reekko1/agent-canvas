import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { ClaudeDriver } from './claudeDriver'
import { CodexDriver } from './codexDriver'
import type { AgentSession, CliDriver, McpStageOpts, SendOutcome, SessionEvent } from './driver'
import { TranscriptStore } from './transcripts'
import { RemoteServer } from '../remote/remoteServer'
import { PushService } from '../remote/push'
import type { CardEvent, CliKind, TranscriptItem } from '../../shared/types'

// DELIBERATELY ISOLATED from the shipping Swift app: own config dir. The two
// canvases can run side by side until cutover, when this becomes ~/.agentcanvas.
export const SPINE_DIR = join(homedir(), '.agentcanvas-web')

/// The spine's persistent identity — token + port registry — survives app
/// restarts. Headless sessions do NOT survive a restart (the product
/// principle: nothing runs unsupervised while the app is dead), so the token
/// and mcpPorts exist for a narrower reason than before: keeping the agent-MCP
/// servers' loopback ports stable across restarts (a codex card's config.toml
/// references a literal port; rebinding the same one avoids needless churn),
/// not for a surviving process to reconnect to.
interface SpineConfig {
  token: string
  /** The remote panel's port — persisted so a `tailscale serve` route set up
   *  once keeps pointing at the right place across app restarts. */
  remotePort?: number
  /** Agent-MCP server ports (server id → last-bound port) — persisted so the
   *  loopback servers rebind the same ports across restarts. */
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
      }
      return { token: cfg.token, remotePort: cfg.remotePort, mcpPorts }
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
  chmodSync(file, 0o600) // carries the loopback token — same secrecy rules as before
}

/// The attention spine: owns the per-CLI drivers, the live headless sessions,
/// and the transcript store; turns driver SessionEvents into (cardId,
/// CardEvent) updates, transcript pushes, and captured replies. No tmux, no
/// pty, no hooks — a card's process IS the driver's own subprocess/SDK query.
export class Spine {
  onUpdate?: (cardId: string, event: CardEvent) => void
  /** A card just finished a turn, carrying its full final reply — the
   *  orchestrator echoes it into the supervision chat. */
  onReply?: (cardId: string, reply: string) => void
  /** One transcript entry for an agent card (upsert by TranscriptItem.id). */
  onTranscriptItem?: (cardId: string, item: TranscriptItem) => void
  /** A card's headless session ended — the agent-card analogue of a pty
   *  exiting. `reason` is shown in the renderer as a status detail. */
  onSessionEnded?: (cardId: string, reason?: string) => void

  /** The remote supervision panel (loopback; exposed via Tailscale Serve). */
  readonly remote = new RemoteServer()

  // Config loads first — the token below is a constructor arg of every driver.
  private config = loadConfig()
  /** Per-CLI drivers (headless session lifecycle, MCP/skill staging, event
   *  mapping), each built on the same staging dir + token. A card resolves one
   *  by its CliKind; unknown/absent → claude. Adding a CLI = one driver class
   *  + one entry here. */
  private drivers: Record<CliKind, CliDriver> = {
    claude: new ClaudeDriver(SPINE_DIR, this.config.token),
    codex: new CodexDriver(SPINE_DIR, this.config.token),
  }
  /** Which CLI backs each agent card — set at ensureAgent() and seeded from
   *  the persisted workspace (setCardCli) on load, so a restored card resolves
   *  the right driver the moment its CardNode calls startAgent. */
  private cardCli = new Map<string, CliKind>()
  /** Live headless sessions, one per agent card. Present (idle, no live
   *  process) the moment a card's CardNode has called startAgent; a real
   *  subprocess/SDK query only spawns on the first send (or an initial
   *  prompt) — restored cards with nothing pending cost nothing. */
  private sessions = new Map<string, AgentSession>()
  private readonly transcripts = new TranscriptStore(SPINE_DIR)
  /** Last full assistant reply per card, captured from the turn-ending event —
   *  read by the orchestrator's get_agent_reply. */
  private replies = new Map<string, string>()
  /** Epoch ms of the last session event seen per card — the true liveness
   *  heartbeat. The stall sweep reads it to tell a hung worker from a slow one. */
  private lastEvent = new Map<string, number>()

  start(): void {
    // Materialize the instruction channels (baseline + role skills) + MCP
    // staging homes up front — no sink/port dependency, so every card started
    // after this is equipped.
    for (const d of this.allDrivers) d.stageInstructions()
    this.remote.push = new PushService(join(SPINE_DIR, 'push.json'))
    this.remote.start(this.config.remotePort, (port) => {
      this.config.remotePort = port
      saveConfig(this.config)
      console.log(
        `[spine] remote panel on http://127.0.0.1:${port} — expose with: tailscale serve --bg localhost:${port}`,
      )
    })
  }

  /** The spine's persistent loopback token — shared with the agent-facing MCP
   *  servers so cards authenticate to them consistently. */
  get token(): string {
    return this.config.token
  }

  /** An agent-MCP server's last-bound port (preferred on restart so a codex
   *  card's config.toml keeps pointing at the same port). Ids: `browser` /
   *  `issues` / `canvas`. */
  mcpPort(id: string): number | undefined {
    return this.config.mcpPorts[id]
  }

  /** Persist an agent-MCP server's port and stage its per-card config across
   *  every driver — cards started after are equipped with that server's
   *  `mcp__<id>__*` tools. The server declares its own needs via `opts` (e.g.
   *  the canvas server's ask_user blocks on a human → a long tool timeout). */
  attachMcp(id: string, port: number, opts?: McpStageOpts): void {
    this.config.mcpPorts[id] = port
    saveConfig(this.config)
    for (const d of this.allDrivers) d.stageMcp(id, port, opts)
  }

  /** A role skill's invocation string in a CLI's native syntax (Claude `/`,
   *  codex `$`) — resolved through the driver, so callers never branch on
   *  CliKind and a future CLI can't silently inherit the wrong prefix. */
  skillRef(cli: CliKind | undefined, name: string): string {
    return this.driverFor(cli).skillRef(name)
  }

  /** The driver for a CLI kind — unknown/absent falls back to claude (the
   *  default; a retired kind in persisted data must still resolve). */
  private driverFor(cli: CliKind = 'claude'): CliDriver {
    return this.drivers[cli] ?? this.drivers.claude
  }

  /** The driver backing a card (by its recorded CliKind). */
  private cardDriver(cardId: string): CliDriver {
    return this.driverFor(this.cardCli.get(cardId))
  }

  /** Every registered driver — staged in lockstep so a card of any CLI is equipped. */
  private get allDrivers(): CliDriver[] {
    return Object.values(this.drivers)
  }

  /** Record which CLI backs an agent card. `ensureAgent()` records its own;
   *  the host also seeds this from the persisted workspace at startup, so a
   *  card's first `startAgent` resolves the right driver. */
  setCardCli(cardId: string, cli: CliKind): void {
    this.cardCli.set(cardId, cli)
  }

  /** Which registered CLIs are installed on PATH — probed over the login shell
   *  (`command -v`) for the same PATH a started card resolves against. Feeds the
   *  spawn picker so it only offers CLIs that will actually run. `claude` first. */
  async availableClis(): Promise<CliKind[]> {
    const shell = process.env.SHELL ?? '/bin/zsh'
    const onPath = (bin: string): Promise<boolean> =>
      new Promise((res) => execFile(shell, ['-lc', `command -v ${bin}`], (err) => res(!err)))
    const found = await Promise.all(
      (Object.entries(this.drivers) as [CliKind, CliDriver][]).map(
        async ([kind, d]) => ((await onPath(d.binary)) ? kind : null),
      ),
    )
    return found.filter((k): k is CliKind => !!k)
  }

  /** Ensure an agent card's headless session exists — idempotent (a no-op if
   *  already registered), called every time the card's CardNode mounts. This
   *  does NOT necessarily spawn a live process: a driver only does that when
   *  there's an `initialPrompt` (a fresh spawn) or on the session's first
   *  `send` — a restored card with nothing pending just sits registered and
   *  idle, costing nothing. */
  ensureAgent(
    cardId: string,
    folder: string,
    opts: { cli?: CliKind; initialPrompt?: string; resume?: string } = {},
  ): void {
    if (this.sessions.has(cardId)) return
    const cli = opts.cli ?? 'claude'
    this.setCardCli(cardId, cli)
    // The user's own message is input, not something either CLI echoes back —
    // record it in the transcript here so both drivers show it uniformly.
    if (opts.initialPrompt) this.recordUserItem(cardId, opts.initialPrompt)
    const session = this.cardDriver(cardId).start(
      { cardId, folder, resume: opts.resume, initialPrompt: opts.initialPrompt },
      {
        onEvent: (ev) => this.handleSessionEvent(cardId, ev),
        onExit: (reason, detail) => this.handleSessionExit(cardId, reason, detail),
      },
    )
    this.sessions.set(cardId, session)
  }

  /** Send a message to an agent card's session (registering one first via
   *  ensureAgent is the CardNode mount's job, not this call's — a send with no
   *  registered session is a caller bug, tolerated as a silent 'sent'). */
  sendToAgent(cardId: string, text: string): SendOutcome {
    const outcome = this.sessions.get(cardId)?.send(text) ?? 'sent'
    this.recordUserItem(cardId, text)
    return outcome
  }

  /** Push the user's own message into the transcript (persisted + live), the
   *  same path a driver's items take — neither CLI echoes user input back. */
  private recordUserItem(cardId: string, text: string): void {
    const item: TranscriptItem = { id: randomUUID(), ts: Date.now(), kind: 'user', text }
    this.transcripts.append(cardId, item)
    this.onTranscriptItem?.(cardId, item)
  }

  /** Stop an agent card's in-flight turn without ending the session. */
  interruptAgent(cardId: string): void {
    void this.sessions.get(cardId)?.interrupt()
  }

  /** End a card's session for good (the ✕ path) and drop its transcript.
   *  Killing only the pty (shell cards) is ptys.ts's job — this is the agent
   *  session's lifetime. */
  killCard(cardId: string): void {
    this.sessions.get(cardId)?.kill()
    this.transcripts.delete(cardId)
    this.cardCli.delete(cardId)
    this.lastEvent.delete(cardId)
  }

  /** An agent card's persisted transcript — the initial paint before the live
   *  `onTranscriptItem` feed takes over. */
  loadTranscript(cardId: string): TranscriptItem[] {
    return this.transcripts.load(cardId)
  }

  /** Epoch ms of the last session event from a card, or undefined if it hasn't
   *  spoken this session — the stall sweep's liveness read. */
  lastEventAt(cardId: string): number | undefined {
    return this.lastEvent.get(cardId)
  }

  /** A card's last full assistant reply (from its most recent finished turn),
   *  or null if it hasn't finished a turn since launch. */
  lastReply(cardId: string): string | null {
    return this.replies.get(cardId) ?? null
  }

  /** App teardown: interrupt every live turn (fire-and-forget — both drivers
   *  persist their transcript incrementally, so a turn cut short here loses
   *  nothing but the in-flight tool call) so a graceful quit never leaves an
   *  agent executing unsupervised a moment longer than it has to. */
  shutdown(): void {
    for (const session of this.sessions.values()) void session.interrupt()
  }

  private handleSessionEvent(cardId: string, ev: SessionEvent): void {
    this.lastEvent.set(cardId, Date.now()) // any event = proof the agent is alive
    if (ev.card) this.onUpdate?.(cardId, ev.card)
    if (ev.item) {
      // Streaming deltas are ephemeral — only the finalized item is durable,
      // so a relaunch replays what a human would actually have seen land.
      if (!ev.item.streaming) this.transcripts.append(cardId, ev.item)
      this.onTranscriptItem?.(cardId, ev.item)
    }
    if (ev.reply !== undefined) {
      this.replies.set(cardId, ev.reply)
      this.onReply?.(cardId, ev.reply)
    }
  }

  private handleSessionExit(cardId: string, reason: 'killed' | 'ended' | 'error', detail?: string): void {
    this.sessions.delete(cardId)
    this.onSessionEnded?.(cardId, detail ?? reason)
  }
}
