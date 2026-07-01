import type { CardEvent, Question, QuestionAnswers } from '../../shared/types'

/** Single-quote a string for the POSIX shell. Used by every adapter's
 *  `launchCommand` and by the spine's tmux inner command — lives here in the CLI
 *  seam because launch strings are the seam's output. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Options for staging one agent-facing MCP server (see `stageMcp`). */
export interface McpStageOpts {
  /** Per-tool-call timeout for servers whose tools block on a human (e.g. the
   *  canvas server's ask_user). An adapter whose CLI default is already generous
   *  may ignore it. */
  toolTimeoutSec?: number
}

/** A held (bidirectional) hook event, classified: a permission gate to
 *  allow/deny, or a structured question to answer. Telemetry events classify as
 *  null. `input` is the question tool's original input, echoed back by
 *  `questionAnswerBody` so the answer round-trips — opaque to the spine. */
export type HookAsk =
  | { kind: 'permission' }
  | { kind: 'question'; questions: Question[]; input?: Record<string, unknown> }

/// The transport/config/launch + event-mapping seam for one coding-agent CLI.
/// `ClaudeAdapter` is the reference implementation; `CodexAdapter` (and later
/// opencode) implement the same contract so the spine can drive any of them
/// through a single call site. The spine picks one per card by `CliKind`.
///
/// An adapter is constructed with its staging dir (SPINE_DIR) and the spine
/// token — the two constants of a spine's lifetime — so the methods only carry
/// what varies. Staging methods (stage*) write per-CLI config into that dir and
/// remember the paths on the instance; `launchCommand` folds them into the
/// launch string. A CLI that lacks a given capability (skills, MCP, or a
/// structured question channel) no-ops the corresponding method — the spine
/// degrades gracefully rather than branching per CLI.
///
/// The spine never reads a CLI's event names or payload fields itself — every
/// schema fact flows through `classifyAsk` / `event` / `finalReply`.
export interface CliAdapter {
  /** Human-readable adapter id for logs (e.g. 'claude-code', 'codex'). */
  readonly name: string
  /** The CLI's executable name on PATH — probed by detection (`command -v`). */
  readonly binary: string

  /** Write this CLI's hook config, pointed at the loopback sink on `port`.
   *  Held asks ride the same sink. */
  stageHooks(port: number): void
  /** Materialize the curated skill library for this CLI (no-op if unsupported). */
  stageSkills(): void
  /** Materialize one agent-facing MCP server's per-card config (no-op if the CLI
   *  lacks MCP). `id` is the server key — it becomes the card's tool namespace
   *  (`mcp__<id>__*`), so it must match what the loopback server registered
   *  (`browser` / `issues` / `canvas`). Called as each server's port binds;
   *  re-staging an id replaces that server's previous config, never the others'. */
  stageMcp(id: string, port: number, opts?: McpStageOpts): void

  /** The shell command that launches the CLI inside its tmux session, with the
   *  staged config folded in and an optional initial prompt. */
  launchCommand(initialPrompt?: string): string

  /** The invocation a role card's initial prompt leads with to boot straight into
   *  its role (turn 0, before anything else — no reliance on skill auto-discovery),
   *  in this CLI's native syntax (Claude `/plugin:skill`, codex `$plugin:skill`).
   *  Adapter-owned so no CLI-specific syntax leaks into the orchestrator. */
  skillRef(name: string): string

  /** Classify a hook event: a held permission ask, a held structured question
   *  (with its parsed questions), or null — plain telemetry to ack immediately. */
  classifyAsk(name: string, payload: Record<string, any>): HookAsk | null
  /** The hook response body that answers a structured question (`input` is the
   *  value `classifyAsk` returned for it). */
  questionAnswerBody(input: Record<string, unknown> | undefined, answers: QuestionAnswers): string
  /** The hook response body that allows / denies a held permission ask. */
  permissionAllowBody(): string
  permissionDenyBody(): string

  /** Map a CLI lifecycle event to a `CardEvent` (or `null` to ignore it). */
  event(name: string, p: Record<string, any>): CardEvent | null
  /** The full final assistant reply carried by a turn-ending event, or null for
   *  every other event — the spine captures it for the orchestrator's
   *  get_agent_reply. */
  finalReply(name: string, payload: Record<string, any>): string | null
}
