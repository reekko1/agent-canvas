import type { CardEvent, ModelChoice, TranscriptItem } from '../../shared/types'

/** Single-quote a string for the POSIX shell. Used by both drivers' spawn
 *  commands (codex's `$SHELL -lc`) — lives here in the CLI seam because launch
 *  strings are the seam's output. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Options for staging one agent-facing MCP server (see `stageMcp`). */
export interface McpStageOpts {
  /** Per-tool-call timeout for servers whose tools block on a human (e.g. the
   *  canvas server's ask_user). A driver whose CLI default is already generous
   *  may ignore it. */
  toolTimeoutSec?: number
}

/** What a headless session is started with. `resume` is the CLI's own session
 *  id (claude `session_id` / codex thread id) — present when reviving a card
 *  whose prior session ended (app restart, or the driver's live session
 *  exited). `initialPrompt` is turn 0 (the mastermind's skillRef-prefixed
 *  role prompt, or a hand-typed spawn prompt) — absent for a plain restore
 *  with no pending work. */
export interface SessionSpec {
  cardId: string
  folder: string
  resume?: string
  initialPrompt?: string
  /** Selected model id (from the persisted `CardRecord.model`). Absent = the
   *  CLI's default. claude → `query` `options.model`; codex → `exec -m`. */
  model?: string
}

/** Whether `AgentSession.send` delivered a message into the live turn
 *  ('sent') or queued it behind an in-flight turn ('queued') — codex only;
 *  claude's SDK input stream accepts a send mid-turn, so it is always 'sent'. */
export type SendOutcome = 'sent' | 'queued'

/** One live headless session backing an agent card. A driver constructs one
 *  per card via `start()`; the spine holds it until the card is killed or the
 *  session ends on its own (`SessionCallbacks.onExit`). */
export interface AgentSession {
  readonly cardId: string
  /** The CLI's own session/thread id, once captured from the stream — becomes
   *  `CardEvent.sessionId` → persisted on `CardRecord.session` → the `resume`
   *  a future `start()` is given. Undefined until the first turn reports it. */
  readonly sessionId: string | undefined
  /** Send a message into this session. claude: always delivered into the live
   *  turn (the SDK input generator queues it). codex: delivered as a fresh
   *  `resume` turn if idle, else queued until the in-flight turn's child
   *  process exits. */
  send(text: string): SendOutcome
  /** Stop the in-flight turn without ending the session — queued sends and
   *  session state survive; the session stays resumable. claude:
   *  `query.interrupt()`. codex: SIGKILL the turn's child process (verified
   *  safe — codex persists its transcript incrementally, so a killed turn
   *  resumes with zero redone work). */
  interrupt(): Promise<void>
  /** Switch the session's model. claude: `query.setModel` — live, no restart.
   *  codex: store it for the next `exec` turn (turn-batched, so it takes effect
   *  on the following turn). */
  setModel(model: string): void
  /** The models this session can run — claude enumerates live via the SDK,
   *  codex returns its maintained static list. */
  supportedModels(): Promise<ModelChoice[]>
  /** End the session for good (the card's ✕ path). Idempotent. */
  kill(): void
}

/** One semantic update a driver emits per stream message it reads — any
 *  subset. `card` rides the existing `card-event` channel unchanged (a state
 *  patch folded into CardMeta); `item` is a transcript feed entry (persisted
 *  + pushed); `reply` is the turn's full final text, captured by the spine
 *  for the orchestrator's get_agent_reply. */
export interface SessionEvent {
  card?: CardEvent
  item?: TranscriptItem
  reply?: string
}

export interface SessionCallbacks {
  onEvent(ev: SessionEvent): void
  /** The session's process/loop ended on its own (not via `kill()`) — the
   *  spine's analogue of a pty exiting. `reason` distinguishes a clean turn
   *  loop end from a crash, for the transcript's system-item text. */
  onExit(reason: 'killed' | 'ended' | 'error', detail?: string): void
}

/// The transport/config/launch seam for one coding-agent CLI, headless. Two
/// drivers implement this — `ClaudeDriver` (one long-lived Agent SDK query()
/// per card) and `CodexDriver` (turn-batched `codex exec --json` subprocesses)
/// — so the spine drives either through one call site, keyed by `CliKind`.
///
/// A driver is constructed with its staging dir (SPINE_DIR) and the spine
/// token — the two constants of a spine's lifetime — so `start()` only
/// carries what varies per card. Staging methods (stage*) write per-CLI
/// config into that dir; `start()` folds the staged config into the session.
export interface CliDriver {
  /** The CLI's executable name on PATH — probed by `availableClis`. */
  readonly binary: string

  /** Materialize the two instruction channels — the always-on supervision
   *  baseline and the on-demand role-skill library — in this CLI's own
   *  delivery mechanism. Rebuilt from scratch each call (a removed/renamed
   *  skill never lingers), sink-independent, called at spine start. */
  stageInstructions(): void

  /** Materialize one agent-facing MCP server's config (browser/issues/canvas
   *  loopback servers). `id` is the server key — it becomes the card's tool
   *  namespace (`mcp__<id>__*`). Called as each server's port binds;
   *  re-staging an id replaces that server's previous config, never the
   *  others'. A card started before a server binds simply lacks that
   *  server's tools. */
  stageMcp(id: string, port: number, opts?: McpStageOpts): void

  /** The invocation a role card's initial prompt leads with to boot straight
   *  into its role (turn 0, before anything else), in this CLI's native
   *  syntax (Claude `/plugin:skill`, codex `$plugin:skill`). */
  skillRef(name: string): string

  /** Start (or resume) a headless session for one card. Never throws
   *  synchronously — spawn/auth/resume failures surface via `onExit('error')`
   *  so the spine can react uniformly. */
  start(spec: SessionSpec, cb: SessionCallbacks): AgentSession
}
