// Drives the orchestrator in the main process. Owns the real CommandBus
// (`list_world` projects the latest RemoteState; mutations and confirms are
// dispatched to the renderer over a correlation-id channel and awaited) AND the
// persistent streaming-input session.
//
// The session is one long-lived Agent SDK `query()` fed by an async generator
// (`input()`) that drains a shared queue. Two producers push into that queue:
//   • `run(prompt)`        — you typed in the chat bar          (priority 'now')
//   • `notifyAgentReply()` — an agent's Stop hook fired         (priority 'next')
// The hook is the heartbeat that wakes the session; nothing is polled.
import { runOrchestrator, type GateDecision } from './orchestrator'
import type { CommandBus, World } from './contract'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { OrchestratorCommandResult, OrchestratorEvent, RemoteState } from '../../shared/types'

/** Long agent replies are clipped before they reach the chat / the session. */
const REPLY_CLIP = 500

export interface OrchestratorDeps {
  send: (channel: string, ...args: unknown[]) => void
  getState: () => RemoteState | null
  /** Write input to a card's terminal (keystroke injection). */
  writeToCard: (cardId: string, data: string) => void
  /** A card's last full assistant reply, or null if none captured yet. */
  getReply: (cardId: string) => string | null
}

export class Orchestrator {
  private readonly pending = new Map<number, (r: OrchestratorCommandResult) => void>()
  private nextId = 1
  /** Orchestrator session id from the init message — diagnostics only; the live
   *  streaming session is the conversation, so there's no per-turn resume. */
  private sessionId: string | null = null

  // --- Streaming-input session state ---------------------------------------
  /** Messages waiting to be yielded into the live session, in arrival order. */
  private readonly queue: SDKUserMessage[] = []
  /** Resolver for the input generator's idle await, set when the queue drains. */
  private wake: (() => void) | null = null
  /** A `query()` is currently consuming the input generator. */
  private sessionActive = false
  /** App is tearing down — the input generator should end and not restart. */
  private disposed = false
  /** When true, an agent finishing a turn wakes the orchestrator (autonomous
   *  supervision). When false, replies are only echoed to the chat. */
  private autonomous = true

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Toggle whether agent reports wake the orchestrator. Off = echo only. */
  setAutonomous(on: boolean): void {
    this.autonomous = on
  }

  /** A chat prompt from the user — highest priority, processed before any
   *  queued fleet events. */
  run(prompt: string): void {
    const text = prompt.trim()
    if (!text) return
    this.enqueue({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      priority: 'now',
    })
  }

  /** A supervised agent finished a turn. Always echo its reply for visibility;
   *  when autonomous, also push a "[fleet event]" that wakes the session so the
   *  orchestrator can react. One-way still: the echo never enters the loop, only
   *  the fleet event does, and the system prompt forbids reacting without a
   *  standing instruction (which would loop forever). */
  notifyAgentReply(cardId: string, reply: string): void {
    const text = reply.trim()
    if (!text) return
    const card = this.deps.getState()?.cards.find((c) => c.id === cardId)
    if (!card || card.kind !== 'agent') return
    const clipped = text.length > REPLY_CLIP ? `${text.slice(0, REPLY_CLIP)}…` : text
    this.emit({ kind: 'agentReply', name: card.name, text: clipped })
    if (!this.autonomous) return
    const canvas = card.projectName ? ` on canvas "${card.projectName}"` : ''
    this.enqueue({
      type: 'user',
      message: {
        role: 'user',
        content:
          `[fleet event] Agent "${card.name}" (card ${card.id})${canvas} just finished a turn. Its reply:\n` +
          `"""\n${clipped}\n"""\n` +
          `Act only if the user asked you to coordinate this; otherwise acknowledge briefly and stop.`,
      },
      parent_tool_use_id: null,
      priority: 'next',
    })
  }

  /** End the live session at app teardown — the input generator returns, the
   *  `query()` completes, and nothing restarts. */
  dispose(): void {
    this.disposed = true
    this.wake?.()
  }

  /** Reply to a dispatched command (called from the renderer via IPC). */
  resolveCommand(id: number, result: OrchestratorCommandResult): void {
    const resolve = this.pending.get(id)
    if (resolve) {
      this.pending.delete(id)
      resolve(result)
    }
  }

  // --- Session plumbing -----------------------------------------------------

  private enqueue(msg: SDKUserMessage): void {
    this.queue.push(msg)
    const w = this.wake
    this.wake = null
    w?.() // unblock the input generator if it's idle
    this.ensureSession()
  }

  private ensureSession(): void {
    if (this.sessionActive || this.disposed) return
    this.sessionActive = true
    void this.startSession()
  }

  private async startSession(): Promise<void> {
    try {
      await runOrchestrator({
        bus: this.bus,
        input: this.input(),
        gate: this.gate,
        onEvent: (e) => this.emit(e),
        onSessionId: (id) => {
          this.sessionId = id
        },
      })
    } catch (e) {
      this.emit({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      this.sessionActive = false
      // The SDK ended the session (error / process abort) but work is waiting —
      // bring a fresh session up to drain it.
      if (!this.disposed && this.queue.length) this.ensureSession()
    }
  }

  /** The live input stream: yield everything queued, then idle until the next
   *  `enqueue()` wakes us. Returns only on dispose, which ends the session.
   *  Must never throw — a throwing generator aborts the SDK session opaquely. */
  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.disposed) {
      while (this.queue.length) yield this.queue.shift() as SDKUserMessage
      if (this.disposed) break
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private dispatch(
    cmd: 'focusCanvas' | 'spawnAgent' | 'renameAgent' | 'killCard' | 'confirm',
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<OrchestratorCommandResult> {
    const id = this.nextId++
    this.deps.send('orchestrator-command', { id, cmd, payload })
    return new Promise<OrchestratorCommandResult>((resolve) => {
      this.pending.set(id, resolve)
      // The renderer might never reply (window gone) — don't wedge the turn.
      setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false, message: 'no response from the app' })
      }, timeoutMs)
    })
  }

  private readonly bus: CommandBus = {
    listWorld: async (): Promise<World> => {
      const s = this.deps.getState()
      if (!s) return { canvases: [], cards: [], approvals: [], needsYou: 0 }
      return {
        canvases: s.canvases.map((c) => ({
          id: c.id,
          name: c.name,
          attention: c.attention,
          dirty: c.dirty,
          branch: c.branch,
        })),
        cards: s.cards.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          status: c.status,
          task: c.task,
          canvasId: c.projectId,
          canvasName: c.projectName,
        })),
        approvals: s.approvals.map((a) => ({
          id: a.id,
          name: a.name,
          detail: a.detail,
          canvasId: a.projectId,
        })),
        needsYou: s.needsYou,
      }
    },

    focusCanvas: async (canvasId) => {
      const r = await this.dispatch('focusCanvas', { canvasId })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? 'switched' : 'failed') }
    },

    spawnAgent: async (input) => {
      const r = await this.dispatch('spawnAgent', { ...input })
      return { ok: !!r.ok, cardId: r.cardId, message: r.message ?? (r.ok ? 'spawned' : 'failed') }
    },

    sendToAgent: async (cardId, message) => {
      const card = this.deps.getState()?.cards.find((c) => c.id === cardId)
      if (!card) return { ok: false, message: `no agent with id ${cardId}` }
      if (card.kind !== 'agent') return { ok: false, message: `${card.name} is a shell, not an agent` }
      // Keystroke injection into the agent's terminal; Enter (\r) submits the
      // line. Claude queues input when busy, so this is safe at any status.
      this.deps.writeToCard(cardId, message.endsWith('\r') ? message : `${message}\r`)
      return {
        ok: true,
        message: card.status === 'running' ? `queued for ${card.name} (busy)` : `sent to ${card.name}`,
      }
    },

    getAgentReply: async (cardId) => {
      const card = this.deps.getState()?.cards.find((c) => c.id === cardId)
      if (!card) return { ok: false, message: `no agent with id ${cardId}` }
      const reply = this.deps.getReply(cardId)
      if (!reply) return { ok: true, message: `${card.name} hasn't finished a turn yet — no reply captured` }
      return { ok: true, reply, message: `last reply from ${card.name}` }
    },

    renameAgent: async (cardId, name) => {
      const r = await this.dispatch('renameAgent', { cardId, name })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? 'renamed' : 'failed') }
    },

    killCard: async (cardId) => {
      const card = this.deps.getState()?.cards.find((c) => c.id === cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      const r = await this.dispatch('killCard', { cardId })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? `closed ${card.name}` : 'failed') }
    },
  }

  private readonly gate = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<GateDecision> => {
    // A human decides this one — give it minutes, not the 30s machine round-trip.
    const r = await this.dispatch('confirm', { toolName, input }, 5 * 60_000)
    return r.allow ? { allow: true } : { allow: false, reason: 'You denied this action.' }
  }

  private emit(e: OrchestratorEvent): void {
    this.deps.send('orchestrator-event', e)
  }
}
