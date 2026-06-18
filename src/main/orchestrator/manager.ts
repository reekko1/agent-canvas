// Drives the orchestrator in the main process. Owns the persistent streaming-input
// session and the renderer command channel (`dispatch` + the correlation-id pending
// map), and wires up the live bus (mainBus.ts) and speech-pacing. Most mutations
// dispatch to the renderer and await it; agent I/O (send/reply) and ask decisions
// are main-owned and bypass that round-trip.
//
// The session is one long-lived Agent SDK `query()` fed by an async generator
// (`input()`) that drains a shared queue. Three producers push into that queue:
//   • `run(prompt)`        — you typed in the chat bar          (priority 'now')
//   • `notifyAgentReply()` — an agent's Stop hook fired         (priority 'next')
//   • `notifyAsk()`        — an agent's permission ask fired    (priority 'next')
// The hooks are the heartbeat that wakes the session; nothing is polled.
import { runOrchestrator, type GateDecision } from './orchestrator'
import { makeMainBus, type BrowserDriver, type DispatchCommand, type ResultFor } from './mainBus'
import type { CommandBus } from './contract'
import { TRACER_TRAVEL_MS } from '../../shared/types'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  OrchestratorCommand,
  OrchestratorCommandResult,
  OrchestratorEvent,
  OrchestratorMode,
  OrchestratorTarget,
  PermissionAskInfo,
  RemoteState,
} from '../../shared/types'

/** Long agent replies are clipped before they reach the chat / the session. */
const REPLY_CLIP = 500

/** The ` on canvas "X"` qualifier the fleet-event prompts share (empty when the
 *  card isn't on a named canvas). */
const onCanvas = (name?: string): string => (name ? ` on canvas "${name}"` : '')

export interface OrchestratorDeps {
  send: (channel: string, ...args: unknown[]) => void
  getState: () => RemoteState | null
  /** Write input to a card's terminal (keystroke injection). */
  writeToCard: (cardId: string, data: string) => void
  /** A card's last full assistant reply, or null if none captured yet. */
  getReply: (cardId: string) => string | null
  /** Decide a held permission ask (main-owned — no renderer round-trip). */
  decideAsk: (askId: string, decision: 'allow' | 'deny') => void
  /** Tier-B CDP browser driver (BrowserController) — the bus drives browsers
   *  through this, falling back to the renderer path when CDP is unavailable. */
  browser: BrowserDriver
  /** Voice the orchestrator's turn — receives every typed event; routes the
   *  assistant lines to TTS. Beside the typed event, not a channel-string sniff. */
  speak?: (e: OrchestratorEvent) => void
  /** Resolve once the voice has finished narrating what's been said so far, so a
   *  mutating action lands with its narration instead of ahead of it. No-op when
   *  voice is unavailable. */
  awaitVoiceCaughtUp?: () => Promise<void>
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
  /** Stop the live turn (barge-in), set per session from the SDK query handle.
   *  Null between sessions. */
  private interruptTurn: (() => Promise<void>) | null = null
  /** A turn is producing output right now — gates `interrupt()` so a barge-in
   *  while idle is a no-op. Flipped from the event stream in `emit`. */
  private turnActive = false
  /** We just interrupted the turn — so the SDK's resulting non-success `result`
   *  (it reports an aborted turn as `error_during_execution`) is expected, not a
   *  failure, and must be swallowed instead of whispered as a red error. Cleared
   *  on the next turn-closing event in `emit`. */
  private interrupted = false

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

  /** A supervised agent finished a turn. When autonomous, push a "[fleet event]"
   *  that wakes the session so the orchestrator can react; it is NOT echoed to
   *  the user — the orchestrator digests the reply and speaks its own line (the
   *  ambient whisper). One-way still: the fleet event never auto-orders work, and
   *  the system prompt forbids reacting without a standing instruction (which
   *  would loop forever). */
  notifyAgentReply(cardId: string, reply: string): void {
    const text = reply.trim()
    if (!text) return
    const card = this.findCard(cardId)
    if (!card || card.kind !== 'agent') return
    if (this.mode === 'manual') return
    const clipped = text.length > REPLY_CLIP ? `${text.slice(0, REPLY_CLIP)}…` : text
    const canvas = onCanvas(card.projectName)
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
      // Comet flies to the blocked agent, then it's cleared on landing.
      this.signalTarget({ kind: 'approve', cardId: ask.cardId })
      setTimeout(() => this.deps.decideAsk(ask.askId, 'allow'), TRACER_TRAVEL_MS)
      this.emit({ kind: 'auto', text: `auto-approved ${who}: ${ask.detail}` })
      return
    }
    const canvas = onCanvas(card?.projectName)
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

  /** Barge-in: stop the current turn so it stops narrating and runs no further
   *  tools. Fired when the user grabs the mic to talk over the orchestrator (the
   *  voice audio is dropped separately in main). No-op when no turn is live; the
   *  interrupt promise is best-effort, so a races-with-teardown rejection is fine. */
  interrupt(): void {
    if (!this.turnActive) return
    this.turnActive = false
    this.interrupted = true // swallow the aborted-turn result that follows
    void this.interruptTurn?.().catch(() => {})
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
        beforeTool: this.deps.awaitVoiceCaughtUp,
        onSession: (c) => (this.interruptTurn = c.interrupt),
      })
    } catch (e) {
      this.emit({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      this.sessionActive = false
      this.interruptTurn = null
      this.turnActive = false
      this.interrupted = false
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

  private dispatch<C extends DispatchCommand>(
    command: C,
    timeoutMs = 30_000,
  ): Promise<ResultFor<C['cmd']>> {
    const id = this.nextId++
    this.deps.send('orchestrator-command', { id, ...command } as OrchestratorCommand)
    return new Promise<ResultFor<C['cmd']>>((resolve) => {
      this.pending.set(id, resolve as (r: OrchestratorCommandResult) => void)
      // The renderer might never reply (window gone) — don't wedge the turn. A
      // missing confirm reply denies; a missing mutation reply reports failure.
      setTimeout(() => {
        if (!this.pending.delete(id)) return
        resolve(
          (command.cmd === 'confirm'
            ? { allow: false }
            : { ok: false, message: 'no response from the app' }) as ResultFor<C['cmd']>,
        )
      }, timeoutMs)
    })
  }

  // The live CommandBus lives in mainBus.ts; the manager just supplies the seams
  // it needs (renderer dispatch, state, main-owned agent I/O, the comet signal).
  // Deps are lazy arrows: this field initializes before `this.deps` is assigned,
  // so each access must be deferred to call time.
  private readonly bus = makeMainBus({
    getState: () => this.deps.getState(),
    dispatch: (command) => this.dispatch(command),
    writeToCard: (cardId, data) => this.deps.writeToCard(cardId, data),
    getReply: (cardId) => this.deps.getReply(cardId),
    decideAsk: (askId, decision) => this.deps.decideAsk(askId, decision),
    signalTarget: (t) => this.signalTarget(t),
    // Lazy arrows like the rest: this.deps isn't assigned when this field inits,
    // so defer each call to the live driver.
    browser: {
      read: (id) => this.deps.browser.read(id),
      act: (id, a) => this.deps.browser.act(id, a),
      screenshot: (id) => this.deps.browser.screenshot(id),
    },
  })

  /** The live CommandBus — shared with the agent-facing browser MCP server, which
   *  drives browsers through the same renderer dispatch the orchestrator uses. */
  get commandBus(): CommandBus {
    return this.bus
  }

  private readonly gate = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<GateDecision> => {
    // Speech-pacing lives in canUseTool (beforeTool) now — it covers every tool,
    // so the gate only decides permission.
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
    const r = await this.dispatch({ cmd: 'confirm', payload: { toolName, input } }, 5 * 60_000)
    return r.allow ? { allow: true } : { allow: false, reason: 'You denied this action.' }
  }

  private emit(e: OrchestratorEvent): void {
    // Track whether a turn is live so a barge-in only interrupts real output:
    // assistant/tool events mean it's producing; result/error close the turn.
    if (e.kind === 'assistant' || e.kind === 'tool') this.turnActive = true
    else if (e.kind === 'result' || e.kind === 'error') {
      this.turnActive = false
      // The turn we just interrupted closes with a non-success result; that's the
      // barge-in landing, not a failure. Swallow the error (don't whisper/speak
      // it); let a genuine success through. Either way the interrupt is consumed.
      if (this.interrupted) {
        this.interrupted = false
        if (e.kind === 'error') return
      }
    }
    this.deps.send('orchestrator-event', e)
    this.deps.speak?.(e) // voice tap, beside the typed event
  }

  /** Tell the renderer the orchestrator just acted on an agent, so it can draw a
   *  tracer from the chat bar to that card. */
  private signalTarget(target: OrchestratorTarget): void {
    this.deps.send('orchestrator-target', target)
  }
}
