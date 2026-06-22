// The live CommandBus — the production implementation of the orchestrator↔app
// seam (contract.ts). It projects the latest RemoteState for list_world,
// dispatches the renderer-owned mutations over a correlation-id round-trip
// (focus/spawn/rename/kill), applies the main-owned ones directly (agent I/O and
// ask decisions, which never touch the renderer), and fires the delivering comet
// so each action lands with its narration. The offline counterpart is stubBus.ts.
import { COMET_TRAVEL_MS } from '../../shared/types'
import { renderOpenCanvas, type CommandBus, type World } from './contract'
import { applySkill, skillsSnapshot } from '../mastermind/skills'
import { fireSkillsChanged } from '../mastermind/learning'
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserSnapshot,
  IssueSnapshot,
  OrchestratorActionResult,
  OrchestratorCommand,
  OrchestratorConfirmResult,
  OrchestratorMode,
  OrchestratorTarget,
  RemoteState,
} from '../../shared/types'

/** The Tier-B (CDP, main-side) browser path. Implemented by BrowserController;
 *  injected so this module stays Electron-free (and harness-safe). Methods THROW
 *  when CDP is unavailable (no live guest, can't attach, DevTools holding the
 *  session) — the bus catches and falls back to the Tier-A renderer path. A
 *  logical outcome like a stale ref is a normal `{ ok:false }`, not a throw. */
export interface BrowserDriver {
  read(cardId: string): Promise<BrowserSnapshot>
  act(cardId: string, action: BrowserAction): Promise<BrowserActionResult>
  screenshot(cardId: string): Promise<string>
}

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
  /** The orchestrator's current mode — a role card's spawn prompt invokes its role
   *  skill in this mode (partner → interview; autonomous → unattended). */
  getMode: () => OrchestratorMode
  /** The issue-store read projection — the cross-canvas "your whole world" view reads
   *  each canvas's vision + sprint state from it (worldContext, injected each turn). */
  issueSnapshot: () => IssueSnapshot
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
  /** The Tier-B CDP browser path (primary); the bus falls back to dispatching to
   *  the renderer (Tier A) when these throw. */
  browser: BrowserDriver
  /** Tell the renderer to play the scan-line flourish on a browser card — fired
   *  when its page is screenshotted, as see-it-happening feedback. */
  notifyBrowserScan: (cardId: string) => void
  /** Push a one-line notification to Rakan's phone (the `notify_user` tool's arm).
   *  No-op when absent. */
  pushToPhone?: (title: string, body: string) => void
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolve when the comet would reach the card — the action's effect commits here,
 *  so it lands with the dot instead of ahead of it. */
function landed(): Promise<void> {
  return delay(COMET_TRAVEL_MS)
}

/** Pause between an agent prompt's body and its submitting Enter. The claude TUI
 *  reads a body+`\r` glued into one write as a single paste/continuation burst and
 *  treats the trailing `\r` as a literal newline — the text lands in the composer
 *  but never sends (the "pasted but not submitted" bug). Writing the body, settling
 *  past the burst window, then writing a lone `\r` makes the Enter a discrete
 *  keystroke the TUI reads as submit. */
const SUBMIT_SETTLE_MS = 120

/** Set CANVAS_BROWSER_STRICT_CDP=1 to make the Tier-B path fail LOUD instead of
 *  silently falling back to Tier A — the verification mode for confirming CDP
 *  actually works. Off by default (the fallback is real production resilience). */
const STRICT_CDP = !!process.env.CANVAS_BROWSER_STRICT_CDP

/** Build the live CommandBus backed by the running app (see MainBusDeps). */
export function makeMainBus(deps: MainBusDeps): CommandBus {
  const findCard = (id: string): RemoteState['cards'][number] | undefined =>
    deps.getState()?.cards.find((c) => c.id === id)

  // Per-card serialization for keystroke delivery: a send is body + (settle) + Enter,
  // two separate pty writes. Concurrent callers to the SAME card (orchestrator + the
  // mastermind reactor, or two reactors on one lead) would otherwise interleave into
  // garbled input. Chain per card so each send's two writes stay contiguous.
  const sendChains = new Map<string, Promise<void>>()

  /** Resolve a card that must be a browser, or the failure result to return. The
   *  single owner of the "no card / not a browser" guard the browser methods share
   *  (mirrors agentBrowserMcp's `needBrowser`); messages preserved verbatim. */
  const requireBrowser = (
    cardId: string,
  ): RemoteState['cards'][number] | { ok: false; message: string } => {
    const card = findCard(cardId)
    if (!card) return { ok: false, message: `no card with id ${cardId}` }
    if (card.kind !== 'browser') return { ok: false, message: `${card.name} is not a browser` }
    return card
  }

  // Which transport a browser card is being driven by, logged only on change so
  // steady state is quiet but you can SEE whether CDP is live (and why it fell
  // back). The whole point: a silent fallback must never masquerade as CDP.
  const transport = new Map<string, 'cdp' | 'tier-a'>()
  const noteTransport = (cardId: string, mode: 'cdp' | 'tier-a', reason?: string): void => {
    if (transport.get(cardId) === mode) return
    transport.set(cardId, mode)
    if (mode === 'cdp') console.log(`[browser] ${cardId}: driving via CDP (Tier B)`)
    else console.warn(`[browser] ${cardId}: CDP unavailable → Tier-A fallback — ${reason}`)
  }
  /** Drive a browser op: try Tier-B (CDP), log which path won. On CDP failure,
   *  rethrow LOUD in strict mode (the verification pass), else log + run the
   *  Tier-A fallback. The single place the transport decision lives. */
  const drive = async <T>(
    cardId: string,
    cdpOp: () => Promise<T>,
    fallbackOp: () => Promise<T>,
  ): Promise<T> => {
    try {
      const out = await cdpOp()
      noteTransport(cardId, 'cdp')
      return out
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      if (STRICT_CDP) {
        console.error(`[browser] ${cardId}: CDP failed (strict mode, no fallback) — ${reason}`)
        throw e
      }
      noteTransport(cardId, 'tier-a', reason)
      return await fallbackOp()
    }
  }

  /** The open-canvas snapshot text — shared by openCanvas() and worldContext(). */
  const renderOpen = async (): Promise<string> => {
    const s = deps.getState()
    const active = s?.canvases.find((c) => c.active)
    if (!active) return '[Open canvas] none.'
    return renderOpenCanvas({
      name: active.name,
      id: active.id,
      branch: active.branch,
      dirty: active.dirty,
      cards: s!.cards
        .filter((c) => c.projectId === active.id)
        .map((c) => ({
          name: c.name,
          id: c.id,
          kind: c.kind,
          status: c.status,
          task: c.task,
          url: c.url,
          running: c.running,
        })),
      asks: s!.approvals
        .filter((a) => a.projectId === active.id)
        .map((a) => ({ name: a.name, detail: a.detail, id: a.id })),
      others: s!.canvases
        .filter((c) => !c.active)
        .map((c) => ({ name: c.name, id: c.id, attention: c.attention })),
    })
  }

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

    openCanvas: renderOpen,

    worldContext: async (): Promise<string> => {
      const open = await renderOpen()
      // Operator memory (who Rakan is) + the cross-canvas world view, both computed on
      // demand from existing stores — NO third "world" store (the scope fence). Degrade
      // to just the open canvas if the mastermind module can't load.
      try {
        const { snapshot } = await import('../mastermind/memory')
        const { computeWorldView } = await import('../mastermind/world')
        const operator = snapshot('operator')
        const canvases = (deps.getState()?.canvases ?? []).map((c) => ({ id: c.id, name: c.name }))
        const world = computeWorldView(canvases, deps.issueSnapshot(), (id) => snapshot('product', id))
        return (
          open +
          (operator ? `\n\nABOUT RAKAN (treat as true):\n${operator}` : '') +
          (world ? `\n\n${world}` : '')
        )
      } catch {
        return open
      }
    },

    focusCanvas: async (canvasId) => {
      const r = await deps.dispatch({ cmd: 'focusCanvas', payload: { canvasId } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? 'switched' : 'failed') }
    },

    spawnAgent: async (input) => {
      // A ROLE card boots straight into its role: lead the initial prompt with the
      // role skill, invoked in the current mode. A slash command at the START of the
      // initial prompt runs on turn 0, so the card knows its purpose before anything
      // else — no reliance on the model auto-discovering the skill. (Namespace must
      // match spine/skills.ts PLUGIN_NAME = 'canvas-skills'.)
      const payload = input.role
        ? {
            ...input,
            prompt: `/canvas-skills:mastermind-${input.role} ${
              deps.getMode() === 'autonomous' ? 'autonomous' : 'partner'
            }\n\n${input.prompt ?? ''}`.trim(),
          }
        : { ...input }
      const r = await deps.dispatch({ cmd: 'spawnAgent', payload })
      if (r.ok && r.cardId) deps.signalTarget({ kind: 'spawn', cardId: r.cardId })
      return { ok: !!r.ok, cardId: r.cardId, message: r.message ?? (r.ok ? 'spawned' : 'failed') }
    },

    openBrowser: async (input) => {
      const r = await deps.dispatch({ cmd: 'spawnBrowser', payload: { ...input } })
      if (r.ok && r.cardId) deps.signalTarget({ kind: 'spawn', cardId: r.cardId })
      return { ok: !!r.ok, cardId: r.cardId, message: r.message ?? (r.ok ? 'opened' : 'failed') }
    },

    setBrowserReason: async (cardId, reason) => {
      const card = requireBrowser(cardId)
      if ('ok' in card) return card
      const r = await deps.dispatch({ cmd: 'setBrowserReason', payload: { cardId, reason } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? 'updated' : 'failed') }
    },

    navigateBrowser: async (cardId, url) => {
      const card = requireBrowser(cardId)
      if ('ok' in card) return card
      // Fly the comet to the card, then load on landing (with the narration).
      deps.signalTarget({ kind: 'send', cardId })
      await landed()
      const r = await deps.dispatch({ cmd: 'navigateBrowser', payload: { cardId, url } })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? `pointed ${card.name} at ${url}` : 'failed') }
    },

    readBrowser: async (cardId) => {
      const card = requireBrowser(cardId)
      if ('ok' in card) return card
      // Tier B (CDP, main-side) first; Tier-A renderer path on failure. No
      // comet/landed — the agent loop reads frequently.
      return drive(
        cardId,
        async () => ({ ok: true, message: `read ${card.name}`, snapshot: await deps.browser.read(cardId) }),
        async () => {
          const r = await deps.dispatch({ cmd: 'readBrowser', payload: { cardId } })
          return { ok: !!r.ok, message: r.message ?? (r.ok ? `read ${card.name}` : 'failed'), snapshot: r.snapshot }
        },
      )
    },

    screenshotBrowser: async (cardId) => {
      const card = requireBrowser(cardId)
      if ('ok' in card) return card
      // See-it-happening feedback: play the scan sweep on the card as the capture
      // runs (covers both the CDP and Tier-A paths — emitted before drive).
      deps.notifyBrowserScan(cardId)
      return drive(
        cardId,
        async () => ({ ok: true, message: `captured ${card.name}`, image: await deps.browser.screenshot(cardId) }),
        async () => {
          const r = await deps.dispatch({ cmd: 'screenshotBrowser', payload: { cardId } })
          return { ok: !!r.ok, message: r.message ?? (r.ok ? `captured ${card.name}` : 'failed'), image: r.image }
        },
      )
    },

    actBrowser: async (cardId, action) => {
      const card = requireBrowser(cardId)
      if ('ok' in card) return card
      // A mutation — fly the comet and land it with the narration, like navigate.
      deps.signalTarget({ kind: 'send', cardId })
      await landed()
      // Tier B (real, background-capable input via CDP) first; Tier-A on failure.
      return drive(
        cardId,
        () => deps.browser.act(cardId, action),
        async () => {
          const r = await deps.dispatch({ cmd: 'actBrowser', payload: { cardId, action } })
          return { ok: !!r.ok, message: r.message ?? (r.ok ? `acted on ${card.name}` : 'failed') }
        },
      )
    },

    sendToAgent: async (cardId, message) => {
      const card = findCard(cardId)
      if (!card) return { ok: false, message: `no agent with id ${cardId}` }
      if (card.kind !== 'agent') return { ok: false, message: `${card.name} is a shell, not an agent` }
      // Serialize against any in-flight send to THIS card so the two writes below stay
      // contiguous (a prior failure mustn't break the chain, hence the catch).
      const prior = sendChains.get(cardId) ?? Promise.resolve()
      const run = prior.catch(() => {}).then(async () => {
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
      })
      sendChains.set(cardId, run)
      await run
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

    notifyUser: async (message) => {
      // The mastermind reaching out: push to Rakan's phone. The spoken line (this turn's
      // narration) already covers the desktop + any connected phone; this is the push so
      // it lands even with the app backgrounded.
      deps.pushToPhone?.('Mastermind', message)
      return { ok: true, message: `pushed to Rakan's phone: ${message}` }
    },

    saveSkill: async ({ op = 'create', name, description, body }) => {
      // The orchestrator wrote the body itself (Opus, guided by the system prompt) — no
      // drafting sub-agent. applySkill is the single arbiter (validate → upsert → log);
      // 'conversation' is the source (parsed by the SkillsPanel). Strip the mastermind:
      // prefix the model knows skills by, so a "mastermind:foo" name still resolves.
      const bare = name.replace(/^mastermind:/, '')
      const r = applySkill({ op, name: bare, description, body }, 'conversation')
      if (!r.ok) return { ok: false, message: r.error ?? 'save failed' }
      fireSkillsChanged() // recycle the session at the next idle boundary so it loads
      return { ok: true, message: `saved skill "${bare}" — loads on my next turn` }
    },

    readSkill: async (name) => {
      const bare = name.replace(/^mastermind:/, '')
      const s = skillsSnapshot().active.find((x) => x.name === bare)
      return s ? { name: s.name, description: s.description, body: s.body } : null
    },
  }
}
