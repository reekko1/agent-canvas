import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AgentTodo, CardEvent, Question, QuestionAnswers, TodoChange } from '../../shared/types'

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

  /** Is this held PermissionRequest actually an AskUserQuestion? The CLI models
   *  AskUserQuestion as a permission (its checkPermissions returns "ask"), so it
   *  arrives on the same channel — but it's a question to answer, not an action
   *  to gate, and must be siphoned off before the generic permission path. */
  isQuestionAsk(name: string, payload: Record<string, any>): boolean {
    return name === 'PermissionRequest' && payload?.tool_name === 'AskUserQuestion'
  }

  /** The structured questions from an AskUserQuestion payload, defensively
   *  parsed (the payload is external input). Empty array → fall through to the
   *  terminal rather than show an empty chooser. */
  parseQuestions(payload: Record<string, any>): Question[] {
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
  questionAnswerBody(input: Record<string, any> | undefined, answers: QuestionAnswers): string {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { ...(input ?? {}), answers } },
      },
    })
  }

  /** Read the session's plan from the CLI's own task store:
   *  `~/.claude/tasks/<session-id>/<taskId>.json`, one file per task with
   *  `{id, subject, activeForm, status, …}` (empirically verified in the
   *  Swift adapter). This is the ground truth that outlives both the app and
   *  the hook stream — used to re-hydrate a reattached session's checklist. */
  currentTodos(sessionId: string): AgentTodo[] | null {
    if (!/^[\w.-]+$/.test(sessionId)) return null // ids are uuids; never a path
    let files: string[]
    try {
      files = readdirSync(join(homedir(), '.claude/tasks', sessionId))
    } catch {
      return null // no store for this session (or none yet)
    }
    const todos: AgentTodo[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const obj = JSON.parse(
          readFileSync(join(homedir(), '.claude/tasks', sessionId, f), 'utf8'),
        )
        if (typeof obj?.id !== 'string' || typeof obj?.subject !== 'string') continue
        const status = typeof obj.status === 'string' ? obj.status : 'pending'
        if (status === 'deleted') continue
        todos.push({
          id: obj.id,
          content: obj.subject,
          status,
          activeForm: typeof obj.activeForm === 'string' ? obj.activeForm : undefined,
        })
      } catch {
        // unreadable task file — skip it, keep the rest of the plan
      }
    }
    // An existing-but-empty dir reads as "no data", not "empty plan": the CLI
    // creates the dir before the first task file lands, so a read in that
    // window must not wipe todos already accumulated from deltas.
    if (!todos.length) return null
    // Task ids are a numeric sequence — creation order is the plan's order.
    return todos.sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0))
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
