// The live CommandBus — the production implementation of the orchestrator↔app
// seam (contract.ts). It projects the latest RemoteState for list_world,
// dispatches the renderer-owned mutations over a correlation-id round-trip
// (focus/spawn/rename/kill), applies the main-owned ones directly (agent I/O and
// ask decisions, which never touch the renderer), and fires the delivering comet
// so each action lands with its narration. The offline counterpart is stubBus.ts.
import { TRACER_TRAVEL_MS } from '../../shared/types'
import type { CommandBus, World } from './contract'
import type {
  OrchestratorActionResult,
  OrchestratorCommand,
  OrchestratorConfirmResult,
  OrchestratorTarget,
  RemoteState,
} from '../../shared/types'

/** A renderer-dispatched command minus the correlation id (the manager adds it).
 *  Distributive so the discriminated cmd↔payload pairing survives (a plain Omit
 *  over a union collapses cmd and payload into independent unions). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type DispatchCommand = DistributiveOmit<OrchestratorCommand, 'id'>

/** The reply the renderer sends back for a dispatched command: `confirm` is a gate
 *  decision, every mutation an action result. */
export type ResultFor<C extends OrchestratorCommand['cmd']> = C extends 'confirm'
  ? OrchestratorConfirmResult
  : OrchestratorActionResult

/** Dispatch a renderer-owned mutation and await its result. A discriminated command
 *  object (not separate cmd/payload args) so it passes as a value cleanly — the bus
 *  never dispatches `confirm` (that's the gate's), so this always yields an action
 *  result. Implemented by the session manager, which owns the pending map. */
export type Dispatch = (
  command: Exclude<DispatchCommand, { cmd: 'confirm' }>,
) => Promise<OrchestratorActionResult>

/** What the live bus needs from the session manager to satisfy the seam. */
export interface MainBusDeps {
  /** The latest published app state, or null before the first publish. */
  getState: () => RemoteState | null
  /** Dispatch a renderer-owned mutation and await it. */
  dispatch: Dispatch
  /** Write input to a card's terminal (keystroke injection). */
  writeToCard: (cardId: string, data: string) => void
  /** A card's last full assistant reply, or null if none captured yet. */
  getReply: (cardId: string) => string | null
  /** Decide a held permission ask (main-owned — no renderer round-trip). */
  decideAsk: (askId: string, decision: 'allow' | 'deny') => void
  /** Fire the action's comet at the target card. */
  signalTarget: (target: OrchestratorTarget) => void
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolve when the comet would reach the card — the action's effect commits here,
 *  so it lands with the dot instead of ahead of it. */
function landed(): Promise<void> {
  return delay(TRACER_TRAVEL_MS)
}

/** Pause between an agent prompt's body and its submitting Enter. The claude TUI
 *  reads a body+`\r` glued into one write as a single paste/continuation burst and
 *  treats the trailing `\r` as a literal newline — the text lands in the composer
 *  but never sends (the "pasted but not submitted" bug). Writing the body, settling
 *  past the burst window, then writing a lone `\r` makes the Enter a discrete
 *  keystroke the TUI reads as submit. */
const SUBMIT_SETTLE_MS = 120

/** Build the live CommandBus backed by the running app (see MainBusDeps). */
export function makeMainBus(deps: MainBusDeps): CommandBus {
  const findCard = (id: string): RemoteState['cards'][number] | undefined =>
    deps.getState()?.cards.find((c) => c.id === id)

  return {
    listWorld: async (): Promise<World> => {
      const s = deps.getState()
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
          url: c.url,
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

    openCanvas: async (): Promise<string> => {
      const s = deps.getState()
      const active = s?.canvases.find((c) => c.active)
      if (!active) return '[Open canvas] none.'
      const cards = s!.cards.filter((c) => c.projectId === active.id)
      const asks = s!.approvals.filter((a) => a.projectId === active.id)
      const cardLines = cards.map((c) => {
        const bits = [`${c.name} (${c.id}) — ${c.kind}/${c.status}`]
        if (c.task) bits.push(`task: ${c.task}`)
        if (c.kind === 'browser' && c.url) bits.push(`at ${c.url}`)
        if (c.kind === 'shell' && c.running) bits.push(`running ${c.running}`)
        return '  - ' + bits.join(' · ')
      })
      const others = s!.canvases
        .filter((c) => !c.active)
        .map((c) => `${c.name} (${c.id})${c.attention !== 'none' ? ` [${c.attention}]` : ''}`)
      return [
        `[Open canvas] ${active.name} (${active.id})` +
          (active.branch ? ` · ${active.branch}${active.dirty ? ` +${active.dirty}` : ''}` : ''),
        cards.length ? `cards:\n${cardLines.join('\n')}` : 'cards: none',
        asks.length
          ? `blocked: ${asks.map((a) => `${a.name} — ${a.detail} (${a.id})`).join('; ')}`
          : '',
        others.length ? `other canvases (list_world for their cards): ${others.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    },

    focusCanvas: async (canvasId) => {
      const r = await deps.dispatch({ cmd: 'focusCanvas', payload: { canvasId } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? 'switched' : 'failed') }
    },

    spawnAgent: async (input) => {
      const r = await deps.dispatch({ cmd: 'spawnAgent', payload: { ...input } })
      if (r.ok && r.cardId) deps.signalTarget({ kind: 'spawn', cardId: r.cardId })
      return { ok: !!r.ok, cardId: r.cardId, message: r.message ?? (r.ok ? 'spawned' : 'failed') }
    },

    openBrowser: async (input) => {
      const r = await deps.dispatch({ cmd: 'spawnBrowser', payload: { ...input } })
      if (r.ok && r.cardId) deps.signalTarget({ kind: 'spawn', cardId: r.cardId })
      return { ok: !!r.ok, cardId: r.cardId, message: r.message ?? (r.ok ? 'opened' : 'failed') }
    },

    setBrowserReason: async (cardId, reason) => {
      const card = findCard(cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      if (card.kind !== 'browser') return { ok: false, message: `${card.name} is not a browser` }
      const r = await deps.dispatch({ cmd: 'setBrowserReason', payload: { cardId, reason } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? 'updated' : 'failed') }
    },

    navigateBrowser: async (cardId, url) => {
      const card = findCard(cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      if (card.kind !== 'browser') return { ok: false, message: `${card.name} is not a browser` }
      // Fly the comet to the card, then load on landing (with the narration).
      deps.signalTarget({ kind: 'send', cardId })
      await landed()
      const r = await deps.dispatch({ cmd: 'navigateBrowser', payload: { cardId, url } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? `pointed ${card.name} at ${url}` : 'failed') }
    },

    readBrowser: async (cardId) => {
      const card = findCard(cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      if (card.kind !== 'browser') return { ok: false, message: `${card.name} is not a browser` }
      // Observation — no comet/landed latency; the agent loop reads frequently.
      const r = await deps.dispatch({ cmd: 'readBrowser', payload: { cardId } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? `read ${card.name}` : 'failed'), snapshot: r.snapshot }
    },

    screenshotBrowser: async (cardId) => {
      const card = findCard(cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      if (card.kind !== 'browser') return { ok: false, message: `${card.name} is not a browser` }
      const r = await deps.dispatch({ cmd: 'screenshotBrowser', payload: { cardId } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? `captured ${card.name}` : 'failed'), image: r.image }
    },

    actBrowser: async (cardId, action) => {
      const card = findCard(cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      if (card.kind !== 'browser') return { ok: false, message: `${card.name} is not a browser` }
      // A mutation — fly the comet and land it with the narration, like navigate.
      deps.signalTarget({ kind: 'send', cardId })
      await landed()
      const r = await deps.dispatch({ cmd: 'actBrowser', payload: { cardId, action } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? `acted on ${card.name}` : 'failed') }
    },

    sendToAgent: async (cardId, message) => {
      const card = findCard(cardId)
      if (!card) return { ok: false, message: `no agent with id ${cardId}` }
      if (card.kind !== 'agent') return { ok: false, message: `${card.name} is a shell, not an agent` }
      // The comet delivers the message: fly first, inject when it lands. Claude
      // queues input when busy, so this is safe at any status.
      deps.signalTarget({ kind: 'send', cardId })
      await landed()
      // Strip trailing whitespace and any dangling backslash before submitting:
      // a body ending in `\` makes the TUI read the following Enter as an escaped
      // newline (the manual `\`+Enter line-continuation), not a submit. Then write
      // the body and the Enter as two separated writes — see SUBMIT_SETTLE_MS for
      // why a glued-on `\r` gets swallowed as a paste newline instead of sending.
      const body = message.replace(/[\s\\]+$/, '')
      deps.writeToCard(cardId, body)
      await delay(SUBMIT_SETTLE_MS)
      deps.writeToCard(cardId, '\r')
      return {
        ok: true,
        message: card.status === 'running' ? `queued for ${card.name} (busy)` : `sent to ${card.name}`,
      }
    },

    getAgentReply: async (cardId) => {
      const card = findCard(cardId)
      if (!card) return { ok: false, message: `no agent with id ${cardId}` }
      const reply = deps.getReply(cardId)
      if (!reply) return { ok: true, message: `${card.name} hasn't finished a turn yet — no reply captured` }
      return { ok: true, reply, message: `last reply from ${card.name}` }
    },

    renameAgent: async (cardId, name) => {
      deps.signalTarget({ kind: 'rename', cardId })
      await landed()
      const r = await deps.dispatch({ cmd: 'renameAgent', payload: { cardId, name } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? 'renamed' : 'failed') }
    },

    killCard: async (cardId) => {
      const card = findCard(cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      // The comet flies to the still-present card, then it closes on landing.
      deps.signalTarget({ kind: 'kill', cardId })
      await landed()
      const r = await deps.dispatch({ cmd: 'killCard', payload: { cardId } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? `closed ${card.name}` : 'failed') }
    },

    approveAsk: async (askId, decision) => {
      const ask = deps.getState()?.approvals.find((a) => a.id === askId)
      if (!ask) return { ok: false, message: `no pending ask with id ${askId}` }
      // Signal before deciding — the renderer resolves the asking card from its
      // still-present ask list, the comet flies, and the decision commits on landing.
      deps.signalTarget({ kind: 'approve', askId })
      await landed()
      // Main-owned decision — straight to spine.decide, no renderer round-trip.
      deps.decideAsk(askId, decision)
      return { ok: true, message: `${decision === 'allow' ? 'approved' : 'denied'} ${ask.name}'s request` }
    },
  }
}
