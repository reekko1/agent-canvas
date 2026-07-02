import { basename } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { clip, itemIdSeq, sessionStarted, turnDone, turnFailed, type SessionEvent } from './driver'

/// Pure(-ish) mapping from one Agent SDK stream message to zero or more
/// SessionEvents. Stateful ONLY in the sense that streaming text and pending
/// tool names must be tracked across messages within a turn — no fs/process,
/// no I/O. One instance per live session (constructed by claudeDriver per
/// card); a fresh instance per card keeps turns from bleeding into each
/// other. Ports the status vocabulary of the old hookEvents.ts mapping
/// (tool-failure-stays-running, subagent-counter-never-flips-status,
/// StopFailure semantics) onto the SDK's own message shapes instead of the
/// hook schema.
///
/// Deliberately tolerant: an SDK message type this mapper doesn't recognize
/// yields no events rather than throwing — the SDKMessage union is large
/// (control-plane messages, hook echoes, etc.) and most of it has no bearing
/// on card status or the transcript.
export class ClaudeEventMapper {
  private nextItemId = itemIdSeq()
  /** The transcript item id currently accumulating streamed text, and its
   *  text so far — reset when the block closes. */
  private streamItemId: string | null = null
  private streamText = ''
  /** True once a stream_event arrived this turn — the `assistant` message's
   *  own text blocks are a fallback for when partials never arrive (older
   *  CLI, a cached turn), so don't double-emit when they did. */
  private streamedThisTurn = false
  /** tool_use_id → tool name, so a later tool_result (is_error) can name the
   *  tool that failed — the result block itself carries no name. */
  private pendingTools = new Map<string, string>()
  /** Task ids currently counted as live subagents — task_updated's terminal
   *  statuses can arrive more than once; only decrement once. */
  private activeTasks = new Set<string>()
  /** The SDK re-emits system/init at the start of each turn in streaming-input
   *  mode; only the first is a real session start. Later ones must stay silent,
   *  or the transcript shows "Session started" (and an idle reset) per turn. */
  private started = false

  /** Map one SDK message. Returns nothing for messages with no card/
   *  transcript bearing (the large control-plane slice of SDKMessage). */
  map(m: SDKMessage): SessionEvent[] {
    switch (m.type) {
      case 'system':
        return this.mapSystem(m)
      case 'stream_event':
        return this.mapStreamEvent(m)
      case 'assistant':
        return this.mapAssistant(m)
      case 'user':
        return this.mapUser(m)
      case 'result':
        return this.mapResult(m)
      default:
        return []
    }
  }

  private mapSystem(m: Extract<SDKMessage, { type: 'system' }>): SessionEvent[] {
    switch (m.subtype) {
      case 'init': {
        this.activeTasks.clear()
        this.pendingTools.clear()
        // Re-init on later turns: the driver tracks session_id itself, so a
        // repeat has nothing to announce (and must not reset idle mid-turn).
        if (this.started) return []
        this.started = true
        return [
          sessionStarted({ model: shortModel(m.model), permissionMode: m.permissionMode, sessionId: m.session_id }),
        ]
      }
      case 'task_started':
        this.activeTasks.add(m.task_id)
        return [{ card: { subagentDelta: 1 } }]
      case 'task_updated': {
        const terminal = new Set(['completed', 'failed', 'killed'])
        if (m.patch.status && terminal.has(m.patch.status) && this.activeTasks.has(m.task_id)) {
          this.activeTasks.delete(m.task_id)
          return [{ card: { subagentDelta: -1 } }]
        }
        return []
      }
      case 'compact_boundary':
        return [{ card: { detail: 'Compacting context…' } }]
      default:
        return []
    }
  }

  private mapStreamEvent(m: Extract<SDKMessage, { type: 'stream_event' }>): SessionEvent[] {
    this.streamedThisTurn = true
    const ev = m.event
    // Turn start: the SDK has no `turn.started` (codex does) — message_start is
    // the earliest per-turn signal, so flip to running here. Without it a
    // thinking or text-only turn (no tool_use) would never leave idle.
    if (ev.type === 'message_start') {
      return [{ card: { status: 'running' } }]
    }
    if (ev.type === 'content_block_start' && ev.content_block.type === 'text') {
      this.streamItemId = this.nextItemId('assistant')
      this.streamText = ''
      return [
        {
          item: { id: this.streamItemId, ts: Date.now(), kind: 'assistant', text: '', streaming: true },
        },
      ]
    }
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && this.streamItemId) {
      this.streamText += ev.delta.text
      return [
        {
          item: {
            id: this.streamItemId,
            ts: Date.now(),
            kind: 'assistant',
            text: this.streamText,
            streaming: true,
          },
        },
      ]
    }
    if (ev.type === 'content_block_stop' && this.streamItemId) {
      const item = { id: this.streamItemId, ts: Date.now(), kind: 'assistant' as const, text: this.streamText }
      this.streamItemId = null
      this.streamText = ''
      return [{ item }]
    }
    return []
  }

  private mapAssistant(m: Extract<SDKMessage, { type: 'assistant' }>): SessionEvent[] {
    const out: SessionEvent[] = []
    for (const block of m.message.content) {
      if (block.type === 'text') {
        // Already streamed above; only emit here as a fallback if partials
        // never arrived for this turn.
        if (!this.streamedThisTurn && block.text.trim()) {
          out.push({ item: { id: this.nextItemId('assistant'), ts: Date.now(), kind: 'assistant', text: block.text } })
        }
      } else if (block.type === 'tool_use') {
        this.pendingTools.set(block.id, block.name)
        const detail = toolDetail(block.name, (block.input ?? {}) as Record<string, unknown>)
        out.push({
          card: { status: 'running', detail },
          item: { id: this.nextItemId('tool'), ts: Date.now(), kind: 'tool', text: detail, toolName: block.name },
        })
      }
    }
    return out
  }

  private mapUser(m: Extract<SDKMessage, { type: 'user' }>): SessionEvent[] {
    const content = m.message.content
    if (!Array.isArray(content)) return []
    const out: SessionEvent[] = []
    for (const block of content) {
      if (block?.type !== 'tool_result' || !block.is_error) continue
      const name = this.pendingTools.get(block.tool_use_id) ?? 'tool'
      // Tool failures are routine agentic life (a failing test IS the work)
      // — the agent sees the error and continues, so this stays running.
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
      const detail = `✗ ${name}: ${clip(text, 100)}`
      out.push({
        card: { status: 'running', detail, noteworthy: true },
        item: { id: this.nextItemId('tool'), ts: Date.now(), kind: 'tool', text: detail, toolName: name, failed: true },
      })
    }
    return out
  }

  private mapResult(m: Extract<SDKMessage, { type: 'result' }>): SessionEvent[] {
    this.streamedThisTurn = false
    this.streamItemId = null
    this.streamText = ''
    if (m.subtype === 'success') {
      return [turnDone(this.nextItemId('turn'), m.result, m.duration_ms)]
    }
    // error_max_turns / error_max_budget_usd / error_max_structured_output_retries
    // are limit-hit conditions the mastermind should nudge past — treat as
    // stalled, not a hard error. error_during_execution also covers a
    // deliberate interrupt(); claudeDriver intercepts that case itself
    // (its own interrupt latch) before this mapper ever sees the result.
    const stalled = m.subtype !== 'error_during_execution'
    return [turnFailed(this.nextItemId('turn'), stalled ? 'stalled' : 'error', `Turn ended: ${m.subtype}`, m.duration_ms)]
  }
}

/** "<Tool>: <salient argument>" — the triage line that distinguishes a
 *  rubber-stamp from a think-first ("Bash: rm -rf node_modules"). Ported
 *  verbatim from the old hookEvents.toolDetail. */
function toolDetail(tool: string, input: Record<string, unknown>): string {
  let arg: unknown
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
  const s = id.startsWith('claude-') ? id.slice('claude-'.length) : id
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
