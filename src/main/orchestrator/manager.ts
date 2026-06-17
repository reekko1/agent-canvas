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
import type {
  OrchestratorActionResult,
  OrchestratorCommand,
  OrchestratorCommandResult,
  OrchestratorConfirmResult,
  OrchestratorEvent,
  OrchestratorMode,
  PermissionAskInfo,
  RemoteState,
} from '../../shared/types'

/** Long agent replies are clipped before they reach the chat / the session. */
const REPLY_CLIP = 500

/** The reply shape the renderer sends back for a given command: `confirm` is a
 *  gate decision, every mutation an action result. */
type ResultFor<C extends OrchestratorCommand['cmd']> = C extends 'confirm'
  ? OrchestratorConfirmResult
  : OrchestratorActionResult

export interface OrchestratorDeps {
  send: (channel: string, ...args: unknown[]) => void
  getState: () => RemoteState | null
  /** Write input to a card's terminal (keystroke injection). */
  writeToCard: (cardId: string, data: string) => void
  /** A card's last full assistant reply, or null if none captured yet. */
  getReply: (cardId: string) => string | null
  /** Decide a held permission ask (main-owned — no renderer round-trip). */
  decideAsk: (askId: string, decision: 'allow' | 'deny') => void
}

export class Orchestrator {
  private readonly pending = new Map<number, (r: OrchestratorCommandResult) => void>()
  private nextId = 1

  // --- Streaming-input session state ---------------------------------------
  /** Messages waiting to be yielded into the live session, in arrival order. */
  private readonly queue: SDKUserMessage[] = []
  /** Resolver for the input generator's idle await, set when the queue drains. */
  private wake: (() => void) | null = null
  /** A `query()` is currently consuming the input generator. */
  private sessionActive = false
  /** App is tearing down — the input generator should end and not restart. */
  private disposed = false
  /** How autonomous the orchestrator is. See OrchestratorMode. Default to the
   *  supervised middle: it wakes on events but every action needs a click. */
  private mode: OrchestratorMode = 'supervising'

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Switch autonomy mode. Entering autopilot is loud — it bypasses every
   *  confirmation — so announce both edges in the chat log. */
  setMode(mode: OrchestratorMode): void {
    if (mode === this.mode) return
    const was = this.mode
    this.mode = mode
    if (mode === 'autopilot') {
      this.emit({ kind: 'mode', text: 'autopilot engaged — all confirmations bypassed' })
    } else if (was === 'autopilot') {
      this.emit({ kind: 'mode', text: `autopilot off — now ${mode}` })
    }
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
    const card = this.findCard(cardId)
    if (!card || card.kind !== 'agent') return
    const clipped = text.length > REPLY_CLIP ? `${text.slice(0, REPLY_CLIP)}…` : text
    this.emit({ kind: 'agentReply', name: card.name, text: clipped })
    if (this.mode === 'manual') return
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

  /** An agent is blocked on a permission request — the second heartbeat source.
   *  When autonomous, wake the orchestrator so it can clear the block via
   *  approve_ask IF the user gave a standing instruction (the system prompt
   *  forbids acting otherwise). The user still sees the normal permission
   *  prompt; this is awareness, not a replacement for it. */
  notifyAsk(ask: PermissionAskInfo): void {
    if (this.mode === 'manual') return
    const card = this.findCard(ask.cardId)
    const who = card?.name ?? 'An agent'
    // Autopilot clears the block immediately — no wake, no model, no click.
    if (this.mode === 'autopilot') {
      this.deps.decideAsk(ask.askId, 'allow')
      this.emit({ kind: 'auto', text: `auto-approved ${who}: ${ask.detail}` })
      return
    }
    const canvas = card?.projectName ? ` on canvas "${card.projectName}"` : ''
    this.enqueue({
      type: 'user',
      message: {
        role: 'user',
        content:
          `[fleet event] ${who} (card ${ask.cardId})${canvas} is BLOCKED, asking permission to:\n` +
          `"""\n${ask.detail}\n"""\n` +
          `Ask id "${ask.askId}". Clear it with approve_ask only if the user gave you a standing ` +
          `instruction covering this; otherwise do nothing — the user will decide from the prompt.`,
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

  /** The card with this id in the latest published state, or undefined. */
  private findCard(id: string): RemoteState['cards'][number] | undefined {
    return this.deps.getState()?.cards.find((c) => c.id === id)
  }

  private dispatch<C extends OrchestratorCommand['cmd']>(
    cmd: C,
    payload: Extract<OrchestratorCommand, { cmd: C }>['payload'],
    timeoutMs = 30_000,
  ): Promise<ResultFor<C>> {
    const id = this.nextId++
    this.deps.send('orchestrator-command', { id, cmd, payload } as OrchestratorCommand)
    return new Promise<ResultFor<C>>((resolve) => {
      this.pending.set(id, resolve as (r: OrchestratorCommandResult) => void)
      // The renderer might never reply (window gone) — don't wedge the turn. A
      // missing confirm reply denies; a missing mutation reply reports failure.
      setTimeout(() => {
        if (!this.pending.delete(id)) return
        resolve(
          (cmd === 'confirm'
            ? { allow: false }
            : { ok: false, message: 'no response from the app' }) as ResultFor<C>,
        )
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
      const card = this.findCard(cardId)
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
      const card = this.findCard(cardId)
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
      const card = this.findCard(cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      const r = await this.dispatch('killCard', { cardId })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? `closed ${card.name}` : 'failed') }
    },

    approveAsk: async (askId, decision) => {
      const ask = this.deps.getState()?.approvals.find((a) => a.id === askId)
      if (!ask) return { ok: false, message: `no pending ask with id ${askId}` }
      // Main-owned decision — straight to spine.decide, no renderer round-trip.
      this.deps.decideAsk(askId, decision)
      return { ok: true, message: `${decision === 'allow' ? 'approved' : 'denied'} ${ask.name}'s request` }
    },
  }

  private readonly gate = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<GateDecision> => {
    // The orchestrator has full autonomy over its own tools in supervising and
    // autopilot — approve_ask included. If the user said "approve this", a
    // re-confirm would just ask for permission they already gave verbally. Only
    // manual gates the orchestrator's actions.
    //
    // The supervising/autopilot difference is about AGENTS and lives in
    // notifyAsk: autopilot auto-clears every agent ask the instant it fires;
    // supervising leaves an unattended ask for a human decision — the user, or
    // the orchestrator acting on the user's instruction (the system prompt
    // forbids it from approving on its own judgement).
    if (this.mode !== 'manual') return { allow: true }
    // manual → a human decides; give it minutes, not the 30s machine round-trip.
    const r = await this.dispatch('confirm', { toolName, input }, 5 * 60_000)
    return r.allow ? { allow: true } : { allow: false, reason: 'You denied this action.' }
  }

  private emit(e: OrchestratorEvent): void {
    this.deps.send('orchestrator-event', e)
  }
}
