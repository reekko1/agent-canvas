// The orchestrator's view of the app, and the actions it can take.
//
// This is the seam between the Agent SDK tools and the app. Two implementations
// satisfy it: mainBus.ts (the live bus — projects the latest RemoteState and
// dispatches mutations to the renderer) and stubBus.ts (an in-memory double for
// the offline harness).
//
// Imports use a relative path (not the `@shared` alias) so the standalone tsx
// harness resolves it without tsconfig-path support.
import type {
  CardKind,
  CardStatus,
  AttentionLevel,
  BrowserAction,
  BrowserSnapshot,
} from '../../shared/types'

export interface WorldCanvas {
  id: string
  name: string
  attention: AttentionLevel
  dirty: number
  branch?: string
}

export interface WorldCard {
  id: string
  name: string
  kind: CardKind
  status: CardStatus
  task?: string
  /** A browser card's current page url — where it's pointed right now. */
  url?: string
  canvasId?: string
  canvasName?: string
}

/** A compact, LLM-facing projection of the app state (derived from RemoteState). */
export interface World {
  canvases: WorldCanvas[]
  cards: WorldCard[]
  approvals: { id: string; name: string; detail: string; canvasId?: string }[]
  /** How many things are blocked waiting on the user right now. */
  needsYou: number
}

export interface ActionResult {
  ok: boolean
  message: string
}

export interface SpawnResult extends ActionResult {
  cardId?: string
}

/** A get_agent_reply result — an ActionResult that also carries the reply text
 *  when the agent has finished a turn (absent if it hasn't). */
export interface AgentReplyResult extends ActionResult {
  reply?: string
}

/** A browser_read result — the page observation (absent on failure). */
export interface BrowserReadResult extends ActionResult {
  snapshot?: BrowserSnapshot
}

/** A browser_screenshot result — a PNG data URL of the page (absent on failure). */
export interface BrowserShotResult extends ActionResult {
  image?: string
}

export interface SpawnAgentInput {
  canvasId?: string
  folder?: string
  prompt?: string
  name?: string
}

export interface SpawnBrowserInput {
  canvasId?: string
  url?: string
  name?: string
  /** Set when an agent opens a browser for itself — links it to that agent card
   *  so its browser tools resolve "my browser". */
  ownerCardId?: string
  /** The stated purpose, shown on the browser card's window bar. */
  reason?: string
}

/** Everything the orchestrator can do to the app. Kept small and explicit. */
export interface CommandBus {
  listWorld(): Promise<World>
  /** A text snapshot of the OPEN canvas (the one in the viewport) in full — its
   *  cards, their status/task, and anything blocked — plus a thin index of the
   *  other canvases by name. Injected into every turn so the orchestrator can act
   *  on what's on screen without a list_world round-trip. */
  openCanvas(): Promise<string>
  focusCanvas(canvasId: string): Promise<ActionResult>
  spawnAgent(input: SpawnAgentInput): Promise<SpawnResult>
  /** Open a browser card (an in-app web view), optionally at a starting url. */
  openBrowser(input: SpawnBrowserInput): Promise<SpawnResult>
  /** Point an existing browser card's web view at a url. */
  navigateBrowser(cardId: string, url: string): Promise<ActionResult>
  /** Update a browser card's stated reason (its window-bar provenance) — used
   *  when an agent re-requests its existing browser with fresh intent. */
  setBrowserReason(cardId: string, reason: string): Promise<ActionResult>
  /** Read a browser card's page as a set-of-marks snapshot (interactive elements
   *  + text) — the basis for clicking/typing by element ref. */
  readBrowser(cardId: string): Promise<BrowserReadResult>
  /** Capture a PNG screenshot of a browser card's page (data URL). */
  screenshotBrowser(cardId: string): Promise<BrowserShotResult>
  /** Perform an action (click/type/scroll) on a browser card's page, keyed on an
   *  element `ref` from the latest readBrowser. */
  actBrowser(cardId: string, action: BrowserAction): Promise<ActionResult>
  /** Deliver a message (instruction / follow-up) to a running agent. */
  sendToAgent(cardId: string, message: string): Promise<ActionResult>
  /** The agent's most recent full reply (from the last turn it finished). */
  getAgentReply(cardId: string): Promise<AgentReplyResult>
  /** Rename an agent card. */
  renameAgent(cardId: string, name: string): Promise<ActionResult>
  /** Close a card — ends its session and removes it from the canvas. */
  killCard(cardId: string): Promise<ActionResult>
  /** Allow or deny a permission request an agent is blocked on (askId from
   *  the world's approvals). */
  approveAsk(askId: string, decision: 'allow' | 'deny'): Promise<ActionResult>
}
