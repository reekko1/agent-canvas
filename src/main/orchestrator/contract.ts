// The orchestrator's view of the app, and the actions it can take.
//
// This is the seam between the Agent SDK tools and the app. Slice 1 implements
// it with an in-memory stub (`stubBus.ts`); Slice 2 swaps in a `mainBus` that
// reads the live `RemoteState` and dispatches mutations to the renderer.
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

export interface SpawnAgentInput {
  canvasId?: string
  folder?: string
  prompt?: string
}

/** Everything the orchestrator can do to the app. Kept small and explicit. */
export interface CommandBus {
  listWorld(): Promise<World>
  focusCanvas(canvasId: string): Promise<ActionResult>
  spawnAgent(input: SpawnAgentInput): Promise<SpawnResult>
  /** Deliver a message (instruction / follow-up) to a running agent. */
  sendToAgent(cardId: string, message: string): Promise<ActionResult>
  /** The agent's most recent full reply (from the last turn it finished). */
  getAgentReply(cardId: string): Promise<{ ok: boolean; reply?: string; message: string }>
}
