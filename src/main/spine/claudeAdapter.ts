import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentTodo, CardEvent, Question, QuestionAnswers } from '../../shared/types'
import * as events from './claudeEvents'

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/// Claude Code adapter — the transport/config seam. Installs scoped HTTP hooks
/// (via --settings, leaving user config untouched), launches `claude` with them,
/// and reads the CLI's task store off disk. The pure event mapping lives in
/// ./claudeEvents; this class delegates to it so the I/O seam stays separate
/// from the (testable) mapping.
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
    return events.isPermissionAsk(name)
  }

  isQuestionAsk(name: string, payload: Record<string, any>): boolean {
    return events.isQuestionAsk(name, payload)
  }

  parseQuestions(payload: Record<string, any>): Question[] {
    return events.parseQuestions(payload)
  }

  questionAnswerBody(input: Record<string, unknown> | undefined, answers: QuestionAnswers): string {
    return events.questionAnswerBody(input, answers)
  }

  /** Read the session's plan from the CLI's own task store:
   *  `~/.claude/tasks/<session-id>/<taskId>.json`, one file per task with
   *  `{id, subject, activeForm, status, …}` (empirically verified in the
   *  Swift adapter). This is the ground truth that outlives both the app and
   *  the hook stream — used to re-hydrate a reattached session's checklist. */
  async currentTodos(sessionId: string): Promise<AgentTodo[] | null> {
    if (!/^[\w.-]+$/.test(sessionId)) return null // ids are uuids; never a path
    let files: string[]
    try {
      files = await readdir(join(homedir(), '.claude/tasks', sessionId))
    } catch {
      return null // no store for this session (or none yet)
    }
    const todos: AgentTodo[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const obj = JSON.parse(
          await readFile(join(homedir(), '.claude/tasks', sessionId, f), 'utf8'),
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
    return events.permissionAllowBody()
  }

  permissionDenyBody(): string {
    return events.permissionDenyBody()
  }

  event(name: string, p: Record<string, any>): CardEvent | null {
    return events.mapEvent(name, p)
  }
}
