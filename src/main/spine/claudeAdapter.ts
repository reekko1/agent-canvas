import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CardEvent } from '../../shared/types'

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/// Claude Code adapter. Installs scoped HTTP hooks (via --settings, leaving
/// user config untouched), launches `claude` with them, and maps hook events to
/// rich CardEvents. (Faithful port of the Swift ClaudeCodeAdapter — the event
/// mapping there is empirically verified against real hook payloads; trust it.)
export class ClaudeAdapter {
  readonly name = 'claude-code'
  private settingsFile: string | null = null

  /** Events acked instantly (status/feed material). PermissionRequest is
   *  configured separately as the held interactive channel. */
  private readonly telemetryEvents = [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'Notification', 'Elicitation',
    'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
    'Stop', 'StopFailure', 'SessionEnd',
  ]

  installConfig(dir: string, port: number, token: string): void {
    const url = `http://127.0.0.1:${port}/hook`
    const entry = (timeout: number, statusMessage?: string): Record<string, unknown> => ({
      type: 'http',
      url,
      timeout,
      headers: { 'X-Canvas-Card': '$CANVAS_CARD_ID', 'X-Canvas-Token': token },
      allowedEnvVars: ['CANVAS_CARD_ID'],
      ...(statusMessage ? { statusMessage } : {}),
    })
    const hooks: Record<string, unknown> = {}
    for (const e of this.telemetryEvents) hooks[e] = [{ hooks: [entry(5)] }]
    hooks['PermissionRequest'] = [{ hooks: [entry(600, 'Asking Agent Canvas…')] }]

    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'hooks.json')
    writeFileSync(file, JSON.stringify({ hooks }, null, 2))
    chmodSync(file, 0o600) // carries the sink token — owner-readable only
    this.settingsFile = file
    console.log(`[adapter] wrote HTTP hooks (port ${port}) → ${file}`)
  }

  launchCommand(): string {
    if (!this.settingsFile) return 'exec claude' // sink not ready (shouldn't happen)
    return `exec claude --settings ${shellQuote(this.settingsFile)}`
  }

  isPermissionAsk(name: string): boolean {
    return name === 'PermissionRequest'
  }

  permissionAllowBody(): string {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
  }

  permissionDenyBody(): string {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied from Agent Canvas', interrupt: false },
      },
    })
  }

  // MARK: Event mapping

  event(name: string, p: Record<string, any>): CardEvent | null {
    let ev: CardEvent | null = null
    switch (name) {
      case 'SessionStart':
        ev = { status: 'idle', detail: 'Session started', model: shortModel(p.model), resetSubagents: true }
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
        ev = { status: 'idle', detail: 'Session ended', clearTask: true, resetSubagents: true }
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
    case 'TaskCreate':
      arg = input.subject
      break
    case 'TaskUpdate': {
      const status = typeof input.status === 'string' ? ` → ${input.status}` : ''
      arg = typeof input.taskId === 'string' ? `#${input.taskId}${status}` : undefined
      break
    }
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
