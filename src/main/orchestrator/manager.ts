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
  IssueMilestone,
  IssueSnapshot,
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
  /** The issue-store projection — the strategist cascade reads the winning idea
   *  (on idea-ready) and a canvas's active sprints (the idle check) from it. */
  issueSnapshot: () => IssueSnapshot
  /** Write input to a card's terminal (keystroke injection). */
  writeToCard: (cardId: string, data: string) => void
  /** A card's last full assistant reply, or null if none captured yet. */
  getReply: (cardId: string) => string | null
  /** Decide a held permission ask (main-owned — no renderer round-trip). */
  decideAsk: (askId: string, decision: 'allow' | 'deny') => void
  /** Tier-B CDP browser driver (BrowserController) — the bus drives browsers
   *  through this, falling back to the renderer path when CDP is unavailable. */
  browser: BrowserDriver
  /** Tell the renderer to play the scan flourish on a browser card (screenshot). */
  notifyBrowserScan: (cardId: string) => void
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
  /** How a sprint is born + how much it drives. See OrchestratorMode. Default to
   *  manual: it does nothing on its own until you pick partner or autonomous. */
  private mode: OrchestratorMode = 'manual'
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

  /** Canvas ids with a strategist spawn in flight — a synchronous latch so a
   *  getState()-lagged double-trigger (setMode + outcome-verified) can't spawn two. */
  private readonly strategistSpawning = new Set<string>()

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Switch mode — announce it (it changes how work is born and whether the
   *  cascade runs without you). */
  setMode(mode: OrchestratorMode): void {
    if (mode === this.mode) return
    this.mode = mode
    const note =
      mode === 'manual'
        ? 'manual — I act only on your command'
        : mode === 'partner'
          ? 'partner — talk to a planner; I drive the cascade once you confirm the plan'
          : 'autonomous — I find the work and drive it end to end'
    this.emit({ kind: 'mode', text: note })
    // Entering autonomous on an idle canvas births a strategist at once — the head
    // that finds the first sprint. (Each later sprint's DONE is the next trigger.)
    if (mode === 'autonomous') {
      const active = this.deps.getState()?.canvases.find((c) => c.active)
      if (active) this.spawnStrategist(active.id)
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
    // Cascade role cards (planner/lead/worker) run unattended — auto-approve their
    // asks so the sprint doesn't stall waiting on a human. A PLAIN agent's asks
    // still wake the orchestrator as a fleet event (and the human sees the prompt).
    if (card?.role) {
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

  /** A board milestone fired (e.g. a sprint's plan was approved). In partner /
   *  autonomous mode this wakes the orchestrator to drive the next cascade step —
   *  currently PLAN READY → spawn a lead. Manual ignores it, like every event. */
  notifyMilestone(m: IssueMilestone): void {
    if (this.mode === 'manual') return
    if (m.kind === 'issue-assigned') {
      if (!m.ownerId) return
      // Deterministic nudge — deliver the assignment to the worker directly so it
      // can't be missed if the worker checked before the lead assigned (the race).
      void this.bus.sendToAgent(
        m.ownerId,
        `You've been assigned issue "${m.detail ?? m.issueId}". Run get_issue to read it, do the work, ` +
          `self-audit (adversarial subagents), then mark it done. See your mastermind-worker skill.`,
      )
      return
    }
    if (m.kind === 'issue-done' || m.kind === 'issue-blocked') {
      // A worker hit a terminal state — notify the lead (no polling). Symmetric
      // with the assignment nudge: the mastermind is the routing hub.
      const lead = this.deps
        .getState()
        ?.cards.find((c) => c.role === 'lead' && c.projectId === m.projectId)
      if (!lead) return
      const freed = m.ownerId ? ` Worker card ${m.ownerId} is now free.` : ''
      void this.bus.sendToAgent(
        lead.id,
        m.kind === 'issue-done'
          ? `Issue "${m.detail ?? m.issueId}" is DONE.${freed} Re-check list_issues and assign any ` +
              `newly-unblocked issue to a free worker. When every issue is done, run your outcome ` +
              `self-audit and set the sprint to done.`
          : `Issue "${m.detail ?? m.issueId}" is BLOCKED — the worker hit a wall (see its comment). ` +
              `Decide: reassign it, adjust the issue, or escalate to the human.`,
      )
      return
    }
    if (m.kind === 'idea-ready') {
      // The strategist's job is done — retire it (frees the next cycle's spawn guard),
      // then, in autonomous mode, hand the winning idea to a planner. Direct spawn (not
      // a model fleet event) so the idea passes verbatim, not paraphrased.
      this.retireStrategist(m.projectId)
      if (this.mode !== 'autonomous') return // a mode switch mid-tournament — don't drive
      const conception = this.deps.issueSnapshot().conceptions.find((c) => c.id === m.conceptionId)
      const winner = conception?.candidates.find((c) => c.id === conception.winnerIdeaRef)
      if (!winner) return
      void this.bus.spawnAgent({
        canvasId: m.projectId,
        role: 'planner',
        name: 'Planner',
        prompt:
          `The strategist's idea tournament chose this canvas's next sprint. Create the sprint from this ` +
          `winning idea, then write, self-audit, and approve its plan — work unattended.\n\n` +
          `IDEA: ${winner.idea}\nWHY (the gap it closes): ${winner.why}\n` +
          `OUTCOME (definition of done, intent level): ${winner.outcome}\nVISION LINK: ${winner.visionLink}\n\n` +
          `Call create_sprint (title = the idea, outcome = the outcome, gapRationale = the why), then ` +
          `create_plan, self-audit with adversarial subagents, and approve_plan.`,
      })
      this.emit({ kind: 'auto', text: `idea ready — spawning a planner: "${winner.idea}"` })
      return
    }
    if (m.kind === 'idea-abstained') {
      // The strategist's job is done — retire it (frees the next cycle's spawn guard).
      // Then, in autonomous mode, escalate to the human (never manufacture a sprint),
      // routed through the orchestrator's voice so they hear the canvas needs steering.
      this.retireStrategist(m.projectId)
      if (this.mode !== 'autonomous') return
      const canvasName = this.deps.getState()?.canvases.find((c) => c.id === m.projectId)?.name
      const where = canvasName ? ` on canvas "${canvasName}"` : ''
      this.enqueue({
        type: 'user',
        message: {
          role: 'user',
          content:
            `[fleet event] The strategist ABSTAINED${where}: no idea clearly served the vision` +
            `${m.detail ? ` (${m.detail})` : ''}. Tell the user their canvas needs steering — a vision edit ` +
            `or a direct instruction — then stop. Do not spawn anything.`,
        },
        parent_tool_use_id: null,
        priority: 'next',
      })
      return
    }
    if (m.kind === 'outcome-verified') {
      // A sprint's outcome was verified — find the next one (the autonomous loop).
      this.spawnStrategist(m.projectId)
      return
    }
    if (m.kind !== 'plan-ready') return
    const canvasName = this.deps.getState()?.canvases.find((c) => c.id === m.projectId)?.name
    const where = canvasName ? ` on canvas "${canvasName}"` : ''
    this.enqueue({
      type: 'user',
      message: {
        role: 'user',
        content:
          `[fleet event] PLAN READY${where}: the plan for sprint "${m.detail ?? 'a sprint'}" was approved. ` +
          `Spawn a lead now — call spawn_agent with role "lead", canvasId "${m.projectId}", and a one-line ` +
          `brief telling it the plan is approved and to decompose it into issues, self-audit the distribution, ` +
          `request workers, and assign the work. This is the cascade; do it without waiting.`,
      },
      parent_tool_use_id: null,
      priority: 'next',
    })
  }

  /** Birth a strategist on an idle autonomous canvas — the head that runs the idea
   *  tournament to find the next sprint. Guarded against double-spawn (an existing
   *  strategist) and against starting a contest while a sprint is in flight. Direct
   *  spawn: its mastermind-strategist skill runs the tournament on turn 0. */
  private spawnStrategist(projectId: string): void {
    if (this.mode !== 'autonomous') return
    if (this.strategistSpawning.has(projectId)) return // synchronous latch (getState lags the spawn)
    const state = this.deps.getState()
    if (!state) return
    if (state.cards.some((c) => c.role === 'strategist' && c.projectId === projectId)) return
    const active = this.deps
      .issueSnapshot()
      .sprints.some(
        (s) => s.projectId === projectId && s.state !== 'DONE' && s.state !== 'REALIGNMENT_PENDING',
      )
    if (active) return // a sprint is in flight — don't run a parallel contest
    const canvasName = state.canvases.find((c) => c.id === projectId)?.name
    this.strategistSpawning.add(projectId)
    void this.bus
      .spawnAgent({
        canvasId: projectId,
        role: 'strategist',
        name: 'Strategist',
        prompt:
          `Find this canvas's next sprint. Perceive the gap between the vision (get_vision + ` +
          `get_vision_history) and the current reality of the repo, run your idea tournament, and record the ` +
          `conception. If a clear winner emerges that genuinely serves the vision, set it as the winner (a ` +
          `planner picks it up); if nothing clearly wins, abstain so the human can steer.`,
      })
      .finally(() => this.strategistSpawning.delete(projectId))
    this.emit({
      kind: 'auto',
      text: `autonomous${canvasName ? ` · ${canvasName}` : ''} — a strategist is finding the next sprint`,
    })
  }

  /** The strategist's job ends when its conception resolves — retire the card so the
   *  next cycle's spawn guard is clear and the finished session doesn't linger. */
  private retireStrategist(projectId: string): void {
    const strat = this.deps
      .getState()
      ?.cards.find((c) => c.role === 'strategist' && c.projectId === projectId)
    if (strat) void this.bus.killCard(strat.id)
  }

  /** A lead asked the mastermind to hire workers (via the issue MCP). Spawn `count`
   *  worker cards on the lead's canvas with the brief and return their ids so the
   *  lead can assign issues to them. Honored only when driving (not manual). */
  async requestWorkers(
    leadCardId: string,
    count: number,
    brief: string,
  ): Promise<{ ok: boolean; workerIds: string[]; message?: string }> {
    if (this.mode === 'manual')
      return { ok: false, workerIds: [], message: 'manual mode — the mastermind is not hiring.' }
    const canvasId = this.findCard(leadCardId)?.projectId
    if (!canvasId) return { ok: false, workerIds: [], message: "could not resolve the lead's canvas" }
    const n = Math.max(1, Math.min(8, Math.floor(count) || 1)) // clamp — no runaway fleets
    const workerBrief =
      `${brief}\n\nYou are a WORKER on this sprint. Stand by — the lead will assign you an issue shortly; ` +
      `when you receive the assignment, work it to a self-audited finish (see your mastermind-worker skill).`
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        this.bus.spawnAgent({ canvasId, role: 'worker', name: `Worker ${i + 1}`, prompt: workerBrief }),
      ),
    )
    const workerIds = results.filter((r) => r.ok && r.cardId).map((r) => r.cardId as string)
    this.emit({
      kind: 'auto',
      text: `hired ${workerIds.length} worker${workerIds.length === 1 ? '' : 's'} for the lead`,
    })
    return { ok: workerIds.length > 0, workerIds, message: `spawned ${workerIds.length} workers` }
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
    getMode: () => this.mode,
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
    notifyBrowserScan: (id) => this.deps.notifyBrowserScan(id),
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
    // so the gate only decides permission. The orchestrator's OWN tools run freely
    // in partner and autonomous (it's driving the cascade); only manual gates them.
    if (this.mode !== 'manual') return { allow: true }
    // manual → a human decides; give it minutes, not the 30s machine round-trip.
    // Build the human copy here (main owns the tool vocabulary) and ship it ready
    // to display — the renderer no longer reverse-engineers what a verb means.
    const r = await this.dispatch({ cmd: 'confirm', payload: this.describeGate(toolName, input) }, 5 * 60_000)
    return r.allow ? { allow: true } : { allow: false, reason: 'You denied this action.' }
  }

  /** Turn a gated tool call into a plain-language gate ("Spawn an agent" / "on
   *  web · fix the failing test"), resolving canvas/card/ask ids to their names
   *  from the latest published state. Lives beside the gate — not in the renderer
   *  — so main is the single source for what each tool means. Keep the verb cases
   *  in sync with the tools registered in canvasServer.ts (same soft contract as
   *  READ_ONLY_TOOLS). */
  private describeGate(
    toolName: string,
    input: Record<string, unknown>,
  ): { title: string; detail: string } {
    const verb = toolName.replace(/^mcp__canvas__/, '')
    const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s)
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
    const state = this.deps.getState()
    const cardName = (id: unknown): string =>
      state?.cards.find((c) => c.id === String(id))?.name ?? String(id ?? '?')
    const canvasName = (id: unknown): string =>
      state?.canvases.find((c) => c.id === String(id))?.name ?? String(id ?? '?')
    const activeName = (): string =>
      state?.canvases.find((c) => c.active)?.name ?? 'the active canvas'
    switch (verb) {
      case 'spawn_agent': {
        const where = input.canvasId ? canvasName(input.canvasId) : activeName()
        const who = str(input.name)
        const task = str(input.prompt)
        return {
          title: who ? `Spawn “${who}”` : 'Spawn an agent',
          detail: `on ${where}${task ? ` · ${clip(task)}` : ''}`,
        }
      }
      case 'open_browser': {
        const where = input.canvasId ? canvasName(input.canvasId) : activeName()
        const url = str(input.url)
        return { title: 'Open a browser', detail: `on ${where}${url ? ` · ${clip(url)}` : ''}` }
      }
      case 'navigate_browser':
        return { title: `Navigate ${cardName(input.cardId)}`, detail: clip(str(input.url)) }
      case 'browser_click':
        return { title: `Click on ${cardName(input.cardId)}`, detail: clip(str(input.ref)) }
      case 'browser_type':
        return { title: `Type on ${cardName(input.cardId)}`, detail: clip(str(input.text)) }
      case 'browser_scroll':
        return { title: `Scroll ${cardName(input.cardId)}`, detail: str(input.direction) }
      case 'browser_select':
        return { title: `Select on ${cardName(input.cardId)}`, detail: clip(str(input.value)) }
      case 'browser_history':
        return { title: `History · ${cardName(input.cardId)}`, detail: str(input.action) }
      case 'send_to_agent':
        return { title: `Message ${cardName(input.cardId)}`, detail: clip(str(input.message)) }
      case 'rename_agent':
        return { title: `Rename ${cardName(input.cardId)}`, detail: `→ ${str(input.name)}` }
      case 'kill_card':
        return { title: `Close ${cardName(input.cardId)}`, detail: 'ends its session — cannot be undone' }
      case 'approve_ask': {
        const ask = state?.approvals.find((a) => a.id === String(input.askId))
        const who = ask?.name ?? 'agent'
        const action = str(input.decision) === 'deny' ? 'Deny' : 'Approve'
        return { title: `${action} ${who}’s request`, detail: ask?.detail ?? String(input.askId) }
      }
      case 'focus_canvas':
        return { title: 'Switch canvas', detail: `to ${canvasName(input.canvasId)}` }
      default:
        return { title: verb, detail: clip(JSON.stringify(input)) }
    }
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
