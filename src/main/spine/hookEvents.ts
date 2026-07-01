import { basename } from 'node:path'
import type { AgentTodo, CardEvent, Question, QuestionAnswers, TodoChange } from '../../shared/types'
import type { HookAsk } from './cliAdapter'

/// Pure mapping for the CANONICAL hook schema — the wire format Claude Code
/// defined and codex adopted (same PascalCase event names, same snake_case
/// payload fields: `hook_event_name`, `tool_name`, `last_assistant_message`, …).
/// No fs, no process, no class state; split out of the adapters (which keep the
/// transport/config/launch seam) so this stays testable in isolation. Both
/// ClaudeAdapter and CodexAdapter delegate here through their own methods — if a
/// CLI's schema ever drifts, the divergence belongs in that adapter, not in this
/// file. Siphons AskUserQuestion off the PermissionRequest channel, parses
/// questions, builds decision bodies, and maps lifecycle events to rich
/// CardEvents. (Faithful port of the Swift ClaudeCodeAdapter — the event mapping
/// there is empirically verified against real hook payloads; trust it.)

/** Classify a hook event for routing: a held permission gate, a held structured
 *  question, or null (telemetry). AskUserQuestion is siphoned off first — the
 *  CLI models it as a permission (its checkPermissions returns "ask"), so it
 *  arrives on the PermissionRequest channel, but it's a question to answer, not
 *  an action to gate. The question's original `tool_input` rides along so
 *  `questionAnswerBody` can spread it back into the answer. */
export function classifyAsk(name: string, payload: Record<string, any>): HookAsk | null {
  if (name !== 'PermissionRequest') return null
  if (payload?.tool_name !== 'AskUserQuestion') return { kind: 'permission' }
  const raw = payload?.tool_input
  const input =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined
  return { kind: 'question', questions: parseQuestions(payload), input }
}

/** The full final assistant reply carried by a turn-ending event, or null for
 *  every other event. `Stop` carries the complete text in
 *  `last_assistant_message` (the mapped CardEvent keeps only a clipped summary) —
 *  the spine captures it for the orchestrator's get_agent_reply. */
export function finalReply(name: string, p: Record<string, any>): string | null {
  return name === 'Stop' && typeof p.last_assistant_message === 'string'
    ? p.last_assistant_message
    : null
}

/** The structured questions from an AskUserQuestion payload, defensively
 *  parsed (the payload is external input). Empty array → fall through to the
 *  terminal rather than show an empty chooser. */
function parseQuestions(payload: Record<string, any>): Question[] {
  const raw = payload?.tool_input?.questions
  if (!Array.isArray(raw)) return []
  const out: Question[] = []
  for (const q of raw) {
    if (typeof q?.question !== 'string' || !Array.isArray(q?.options)) continue
    const options = q.options.flatMap((o: any) =>
      typeof o?.label === 'string'
        ? [{ label: o.label, description: typeof o.description === 'string' ? o.description : undefined }]
        : [],
    )
    if (!options.length) continue
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : undefined,
      options,
      multiSelect: q.multiSelect === true,
    })
  }
  return out
}

/** Answer an AskUserQuestion: allow the tool, injecting the chosen answers
 *  into its input via `updatedInput`. The tool's own `call` reads them, so the
 *  agent proceeds as if the human had picked them in the terminal. (The whole
 *  original input is spread back — `questions` must survive the round-trip.) */
export function questionAnswerBody(
  input: Record<string, unknown> | undefined,
  answers: QuestionAnswers,
): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { ...(input ?? {}), answers } },
    },
  })
}

export function permissionAllowBody(): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  })
}

export function permissionDenyBody(): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: 'Denied from Agent Canvas', interrupt: false },
    },
  })
}

// MARK: Event mapping

export function mapEvent(name: string, p: Record<string, any>): CardEvent | null {
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
      ev = { status: 'running', detail: toolDetail(p), todoChange: todoChange(name, p) }
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

/** The plan-changing tools, mapped to TodoChange (port of the Swift
 *  todoChange — field paths empirically verified there against real payloads):
 *  - TaskCreate: `tool_input {subject, activeForm}`; the PostToolUse
 *    `tool_response.task.id` carries the assigned id.
 *  - TaskUpdate: `tool_input {taskId, status?, subject?, activeForm?}`
 *    (status includes "deleted"); `tool_response.statusChange.to` confirms.
 *  - TodoWrite (older CLIs): `tool_input.todos` replaces the plan wholesale. */
function todoChange(name: string, p: Record<string, any>): TodoChange | undefined {
  const input: Record<string, any> = p.tool_input ?? {}
  const response: Record<string, any> = p.tool_response ?? {}
  const isPost = name === 'PostToolUse'
  switch (p.tool_name) {
    case 'TodoWrite': {
      if (!Array.isArray(input.todos)) return undefined
      const todos: AgentTodo[] = (input.todos as any[]).flatMap((t, i) =>
        typeof t?.content === 'string'
          ? [
              {
                id: `todo-${i}`,
                content: t.content,
                status: typeof t.status === 'string' ? t.status : 'pending',
                activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
              },
            ]
          : [],
      )
      return todos.length ? { kind: 'replace', todos } : undefined
    }
    case 'TaskCreate': {
      const id = response?.task?.id
      if (!isPost || typeof input.subject !== 'string' || typeof id !== 'string') return undefined
      return {
        kind: 'add',
        todo: {
          id,
          content: input.subject,
          status: 'pending',
          activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
        },
      }
    }
    case 'TaskUpdate': {
      if (!isPost || typeof input.taskId !== 'string') return undefined
      const confirmed = response?.statusChange?.to
      return {
        kind: 'update',
        id: input.taskId,
        status:
          typeof confirmed === 'string'
            ? confirmed
            : typeof input.status === 'string'
              ? input.status
              : undefined,
        content: typeof input.subject === 'string' ? input.subject : undefined,
        activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
      }
    }
  }
  return undefined
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
    case 'AskUserQuestion': {
      const q = Array.isArray(input.questions) ? input.questions[0] : undefined
      arg = typeof q?.header === 'string' ? q.header : q?.question
      break
    }
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
