import type { CardEvent } from '../../shared/types'

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

/** One hook event, interpreted — everything the spine needs from it in a single
 *  pass. All fields optional: telemetry may carry only an `event`, a turn-ending
 *  event adds `reply`, a permission gate adds `ask`. */
export interface Interpretation {
  /** The semantic card update (status flip, feed line, plan change), if any. */
  event?: CardEvent
  /** The full final assistant reply when this event ends a turn — the spine
   *  captures it for the orchestrator's get_agent_reply. */
  reply?: string
  /** Present when the event must be HELD as a permission gate: the spine keeps
   *  the hook response open and settles it with `allow()`/`deny()` (each returns
   *  the CLI's decision body), or responds null to release the ask to the CLI's
   *  own dialog. The ask carries its own responders, so the spine can never
   *  answer with the wrong CLI's body. */
  ask?: { allow(): string; deny(): string }
}

/// The transport/config/launch + event-interpretation seam for one coding-agent
/// CLI. `ClaudeAdapter` is the reference implementation; `CodexAdapter` (and
/// later opencode) implement the same contract so the spine can drive any of
/// them through a single call site. The spine picks one per card by `CliKind`.
///
/// An adapter is constructed with its staging dir (SPINE_DIR) and the spine
/// token — the two constants of a spine's lifetime — so the methods only carry
/// what varies. Staging methods (stage*) write per-CLI config into that dir and
/// remember the paths on the instance; `launchCommand` folds them into the
/// launch string. A CLI that lacks a given capability (skills, MCP, or a
/// permission channel) no-ops the corresponding method — the spine degrades
/// gracefully rather than branching per CLI.
///
/// The spine never reads a CLI's event names or payload fields itself — every
/// schema fact flows through `interpret`.
export interface CliAdapter {
  /** Human-readable adapter id for logs (e.g. 'claude-code', 'codex'). */
  readonly name: string
  /** The CLI's executable name on PATH — probed by detection (`command -v`). */
  readonly binary: string

  /** Write this CLI's hook config, pointed at the loopback sink on `port`.
   *  Held asks ride the same sink. */
  stageHooks(port: number): void
  /** Materialize the two instruction channels — the always-on supervision
   *  baseline and the on-demand role-skill library — in this CLI's own delivery
   *  mechanisms (no-op where unsupported). */
  stageInstructions(): void
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

  /** Interpret one hook event — the semantic CardEvent (if any), the final reply
   *  (if turn-ending), and the held permission ask (if it must gate) — in one
   *  pass. The one place a CLI's event names and payload fields are read. */
  interpret(name: string, payload: Record<string, any>): Interpretation
}
