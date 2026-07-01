import { basename } from 'node:path'
import type { CardEvent } from '../../shared/types'
import type { Interpretation } from './cliAdapter'

/// Pure interpretation of the CANONICAL hook schema — the wire format Claude
/// Code defined and codex adopted (same PascalCase event names, same snake_case
/// payload fields: `hook_event_name`, `tool_name`, `last_assistant_message`, …).
/// No fs, no process, no class state; split out of the adapters (which keep the
/// transport/config/launch seam) so this stays testable in isolation. Both
/// ClaudeAdapter and CodexAdapter delegate here through their `interpret`
/// method — if a CLI's schema ever drifts, the divergence belongs in that
/// adapter, not in this file. (Faithful port of the Swift ClaudeCodeAdapter —
/// the event mapping there is empirically verified against real hook payloads;
/// trust it.)
///
/// Note there is no structured-question channel here: `AskUserQuestion` is
/// disallowed on every card (the CLI-agnostic `mcp__canvas__ask_user` replaces
/// it — see orchestrator/agentCanvasMcp.ts), so a question can never arrive as
/// a hook. The same goes for the native plan tools (TodoWrite/TaskCreate/
/// TaskUpdate → `mcp__canvas__update_plan`) — no plan mapping here either.

/** Interpret one hook event: the semantic CardEvent (if any), the final reply
 *  (on `Stop`), and the held permission ask (on `PermissionRequest`). */
export function interpret(name: string, p: Record<string, any>): Interpretation {
  const out: Interpretation = {}
  const event = mapEvent(name, p)
  if (event) out.event = event
  // `Stop` carries the complete reply in `last_assistant_message` (the mapped
  // CardEvent keeps only a clipped summary).
  if (name === 'Stop' && typeof p.last_assistant_message === 'string') {
    out.reply = p.last_assistant_message
  }
  // A PermissionRequest is the held decision channel. An AskUserQuestion riding
  // it can only come from a session launched before the tool was disallowed —
  // we can no longer answer those from orbit, so leave `ask` absent and the
  // spine's immediate null response releases it to the terminal's own picker.
  if (name === 'PermissionRequest' && p?.tool_name !== 'AskUserQuestion') {
    out.ask = { allow: permissionAllowBody, deny: permissionDenyBody }
  }
  return out
}

function permissionAllowBody(): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  })
}

function permissionDenyBody(): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: 'Denied from Agent Canvas', interrupt: false },
    },
  })
}

// MARK: Event mapping

function mapEvent(name: string, p: Record<string, any>): CardEvent | null {
  let ev: CardEvent | null = null
  switch (name) {
    case 'SessionStart':
      ev = {
        status: 'idle',
        detail: 'Session started',
        model: shortModel(p.model),
        resetSubagents: true,
        todoChange: { kind: 'clear' },
      }
      break

    case 'UserPromptSubmit': {
      const label = typeof p.prompt === 'string' ? clip(p.prompt, 60) : undefined
      ev = {
        status: 'running',
        detail: label ? `Working on: ${label}` : undefined,
        taskLabel: label,
        resetSubagents: true,
      }
      break
    }

    case 'PreToolUse':
    case 'PostToolUse':
      ev = { status: 'running', detail: toolDetail(p) }
      break

    case 'PostToolUseFailure': {
      // Tool failures are routine agentic life (a failing test IS the work) —
      // the agent sees the error and continues, so this stays running.
      if (p.is_interrupt === true) return null
      ev = {
        status: 'running',
        detail: `✗ ${p.tool_name ?? 'tool'}: ${clip(String(p.error ?? 'failed'), 100)}`,
        noteworthy: true,
      }
      break
    }

    case 'PermissionRequest':
      ev = { status: 'blocked', detail: toolDetail(p) }
      break

    case 'Elicitation':
      // An MCP server is waiting on the user — exactly as blocked as a
      // permission prompt. Acked instantly; never answered from orbit.
      ev = { status: 'blocked', detail: `MCP input: ${clip(String(p.message ?? 'input requested'), 80)}` }
      break

    case 'Notification':
      // The DELAYED desktop nudge — kept as fallback only.
      switch (p.notification_type) {
        case 'permission_prompt':
        case 'elicitation_dialog':
          ev = { status: 'blocked', detail: typeof p.message === 'string' ? p.message : undefined }
          break
        case 'idle_prompt':
          ev = { status: 'idle' }
          break
        default:
          return null
      }
      break

    // Subagent events drive the counter ONLY, never status — they fire
    // out-of-sync with the main Stop and would flip a finished card back.
    case 'SubagentStart':
      ev = { subagentDelta: 1 }
      break
    case 'SubagentStop':
      ev = { subagentDelta: -1 }
      break

    case 'PreCompact':
      ev = { status: 'running', detail: 'Compacting context…' }
      break
    case 'PostCompact': {
      const s = p.compact_summary
      if (typeof s !== 'string' || !s) return null
      ev = { detail: `Compacted: ${clip(s, 120)}`, noteworthy: true }
      break
    }

    case 'Stop': {
      const background: any[] = Array.isArray(p.background_tasks) ? p.background_tasks : []
      const summary =
        typeof p.last_assistant_message === 'string' ? clip(p.last_assistant_message, 140) : undefined
      if (background.length === 0) {
        ev = {
          status: 'done',
          detail: summary ?? 'Finished — waiting for you',
          clearTask: true,
          summary,
          resetSubagents: true,
        }
      } else {
        // The turn ended but the session has live background work —
        // "done" would lie.
        const what = background.map((t) => t?.type).filter(Boolean).join(', ')
        ev = {
          status: 'waiting',
          detail: `Waiting on ${background.length} background task${background.length === 1 ? '' : 's'} (${what})`,
          summary,
        }
      }
      break
    }

    case 'StopFailure': {
      // The turn died on an API error — without this the card would glow
      // "running" forever, the exact lie the canvas exists to prevent.
      const err = String(p.error ?? 'unknown')
      if (err === 'rate_limit' || err === 'overloaded') {
        ev = { status: 'stalled', detail: 'Rate limited — turn aborted', noteworthy: true }
      } else {
        const extra = typeof p.error_details === 'string' ? ` — ${clip(p.error_details, 80)}` : ''
        ev = { status: 'error', detail: `API failure: ${err}${extra}`, noteworthy: true }
      }
      break
    }

    case 'SessionEnd':
      ev = {
        status: 'idle',
        detail: 'Session ended',
        clearTask: true,
        resetSubagents: true,
        todoChange: { kind: 'clear' },
      }
      break

    default:
      return null
  }
  if (ev) {
    // Permission mode and session id ride on most payloads — capture them
    // opportunistically wherever they appear.
    if (typeof p.permission_mode === 'string') ev.permissionMode = p.permission_mode
    if (typeof p.session_id === 'string') ev.sessionId = p.session_id
  }
  return ev
}

/** "<Tool>: <salient argument>" — the triage line that distinguishes a
 *  rubber-stamp from a think-first ("Bash: rm -rf node_modules"). */
function toolDetail(p: Record<string, any>): string {
  const tool: string = typeof p.tool_name === 'string' ? p.tool_name : 'tool'
  const input: Record<string, any> = p.tool_input ?? {}
  let arg: string | undefined
  switch (tool) {
    case 'Bash':
      arg = input.command
      break
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      arg = typeof input.file_path === 'string' ? basename(input.file_path) : undefined
      break
    case 'Grep':
    case 'Glob':
      arg = input.pattern
      break
    case 'WebFetch':
      arg = input.url
      break
    case 'WebSearch':
      arg = input.query
      break
    case 'Agent':
    case 'Task':
      arg = input.description ?? input.subagent_type
      break
  }
  if (typeof arg !== 'string' || !arg) return tool
  return `${tool}: ${clip(arg, 80)}`
}

/** "claude-opus-4-8" → "opus 4.8" (joins numeric parts, drops date stamps). */
function shortModel(id: unknown): string | undefined {
  if (typeof id !== 'string' || !id) return undefined
  let s = id.startsWith('claude-') ? id.slice('claude-'.length) : id
  const words: string[] = []
  for (const part of s.split('-').filter((p) => p.length <= 4)) {
    const last = words[words.length - 1]
    if (last && /^\d+$/.test(last) && /^\d+$/.test(part)) {
      words[words.length - 1] = `${last}.${part}`
    } else {
      words.push(part)
    }
  }
  return words.length ? words.join(' ') : undefined
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\n/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n) + '…' : flat
}
