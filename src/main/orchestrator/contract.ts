// The orchestrator's view of the app, and the actions it can take.
//
// This is the seam between the Agent SDK tools and the app. Two implementations
// satisfy it: mainBus.ts (the live bus — projects the latest RemoteState and
// dispatches mutations to the renderer) and stubBus.ts (an in-memory double for
// the offline harness).
//
// Imports use a relative path (not the `@shared` alias) so the standalone tsx
// harness resolves it without tsconfig-path support.
import type { CardKind, CardStatus, AttentionLevel } from '../../shared/types'

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
}

/** Everything the orchestrator can do to the app. Kept small and explicit. */
export interface CommandBus {
  listWorld(): Promise<World>
  focusCanvas(canvasId: string): Promise<ActionResult>
  spawnAgent(input: SpawnAgentInput): Promise<SpawnResult>
  /** Open a browser card (an in-app web view), optionally at a starting url. */
  openBrowser(input: SpawnBrowserInput): Promise<SpawnResult>
  /** Point an existing browser card's web view at a url. */
  navigateBrowser(cardId: string, url: string): Promise<ActionResult>
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
