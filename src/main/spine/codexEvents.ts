import type { SessionEvent } from './driver'

/// Pure(-ish) mapping from one parsed line of `codex exec --json` JSONL to
/// zero or more SessionEvents. Schema facts about codex's wire format live
/// ONLY here — parsed tolerantly (an unrecognized `type`/`item.type` yields no
/// events rather than throwing), since the exact field set was verified only
/// empirically against the installed codex (0.136.0) and may drift across
/// versions. One instance per live turn-batched session (constructed by
/// codexDriver per card) — it tracks the last agent message across a turn
/// (turn.completed carries only usage, not the text) and each command's
/// started-detail so a later exit code can report it correctly.
export class CodexEventMapper {
  private itemSeq = 0
  private lastAgentMessage = ''
  /** Wall-clock start of the current turn — codex reports no duration (nor USD
   *  cost), so we time it ourselves for the turn hairline's `· Ns` (parity with
   *  claude's cost·duration line). */
  private turnStartTs = 0
  /** codex spawns a fresh `codex exec` per turn, each emitting `thread.started`
   *  — but only the first is a real session start; resumes must stay silent, or
   *  the transcript shows "Session started" (and a plan-clearing reset) per turn. */
  private started = false

  private nextItemId(prefix: string): string {
    return `${prefix}-${++this.itemSeq}`
  }

  /** Map one parsed JSONL line. `line` is untyped — codex's `--json` schema
   *  isn't part of our type surface, so every field access is guarded. */
  map(line: Record<string, unknown>): SessionEvent[] {
    const type = line.type
    switch (type) {
      case 'thread.started':
        return this.mapThreadStarted(line)
      case 'turn.started':
        this.lastAgentMessage = ''
        this.turnStartTs = Date.now()
        return [{ card: { status: 'running' } }]
      case 'item.started':
        return this.mapItemStarted(line)
      case 'item.completed':
        return this.mapItemCompleted(line)
      case 'turn.completed':
        return this.mapTurnCompleted(line)
      case 'turn.failed':
      case 'error':
        return this.mapTurnFailed(line)
      default:
        return []
    }
  }

  private mapThreadStarted(line: Record<string, unknown>): SessionEvent[] {
    // Resume turns re-fire thread.started; the driver already recaptures the
    // thread id itself, so a resume has nothing to announce here.
    if (this.started) return []
    this.started = true
    const threadId = typeof line.thread_id === 'string' ? line.thread_id : undefined
    return [
      {
        card: {
          status: 'idle',
          detail: 'Session started',
          model: 'codex',
          permissionMode: 'unattended',
          sessionId: threadId,
          resetSubagents: true,
          todoChange: { kind: 'clear' },
        },
      },
    ]
  }

  private mapItemStarted(line: Record<string, unknown>): SessionEvent[] {
    const item = line.item as Record<string, unknown> | undefined
    if (!item || item.type !== 'command_execution') return []
    const command = typeof item.command === 'string' ? item.command : 'command'
    return [{ card: { status: 'running', detail: `Bash: ${clip(command, 80)}` } }]
  }

  private mapItemCompleted(line: Record<string, unknown>): SessionEvent[] {
    const item = line.item as Record<string, unknown> | undefined
    if (!item || typeof item.type !== 'string') return []
    switch (item.type) {
      case 'agent_message': {
        const text = typeof item.text === 'string' ? item.text : ''
        this.lastAgentMessage = text
        if (!text.trim()) return []
        return [{ item: { id: this.nextItemId('assistant'), ts: Date.now(), kind: 'assistant', text } }]
      }
      case 'command_execution': {
        const command = typeof item.command === 'string' ? item.command : 'command'
        const failed = typeof item.exit_code === 'number' && item.exit_code !== 0
        const text = `Bash: ${clip(command, 80)}`
        return [
          {
            card: { status: 'running', detail: failed ? `✗ ${text}` : text, noteworthy: failed },
            item: {
              id: this.nextItemId('tool'),
              ts: Date.now(),
              kind: 'tool',
              text,
              toolName: 'Bash',
              detail: typeof item.aggregated_output === 'string' ? clip(item.aggregated_output, 4000) : undefined,
              failed,
            },
          },
        ]
      }
      case 'mcp_tool_call': {
        const name = typeof item.tool === 'string' ? item.tool : typeof item.name === 'string' ? item.name : 'mcp tool'
        return [
          {
            card: { status: 'running', detail: `MCP: ${name}` },
            item: { id: this.nextItemId('tool'), ts: Date.now(), kind: 'tool', text: `MCP: ${name}`, toolName: name },
          },
        ]
      }
      case 'file_change': {
        const path = typeof item.path === 'string' ? item.path : 'file'
        return [
          {
            card: { status: 'running', detail: `Edit: ${path}` },
            item: { id: this.nextItemId('tool'), ts: Date.now(), kind: 'tool', text: `Edit: ${path}`, toolName: 'Edit' },
          },
        ]
      }
      default:
        return [] // reasoning / todo_list / etc. — no card or transcript bearing
    }
  }

  private mapTurnCompleted(line: Record<string, unknown>): SessionEvent[] {
    const summary = clip(this.lastAgentMessage, 140)
    const durationMs = this.turnStartTs ? Date.now() - this.turnStartTs : undefined
    return [
      {
        card: { status: 'done', detail: summary || 'Finished — waiting for you', clearTask: true, summary, resetSubagents: true },
        reply: this.lastAgentMessage || undefined,
        item: { id: this.nextItemId('turn'), ts: Date.now(), kind: 'turn', text: 'Turn complete', ok: true, durationMs },
      },
    ]
  }

  private mapTurnFailed(line: Record<string, unknown>): SessionEvent[] {
    const message =
      typeof line.message === 'string' ? line.message : typeof line.error === 'string' ? line.error : 'unknown'
    const detail = `Turn failed: ${clip(message, 100)}`
    return [
      {
        card: { status: 'error', detail, noteworthy: true },
        item: { id: this.nextItemId('turn'), ts: Date.now(), kind: 'turn', text: detail, ok: false },
      },
    ]
  }
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\n/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n) + '…' : flat
}
