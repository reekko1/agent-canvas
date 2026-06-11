// Shared between main, preload, and renderer (types only — erased at build).

export type CardStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'done'
  | 'stalled'
  | 'blocked'
  | 'error'

/// One semantic update extracted from a CLI lifecycle event — the spine's unit
/// of delivery. Everything is optional: an event may carry only a status flip,
/// only metadata, or only a feed line. (Port of the Swift CardEvent.)
export interface CardEvent {
  status?: CardStatus
  detail?: string
  noteworthy?: boolean
  taskLabel?: string
  clearTask?: boolean
  summary?: string
  model?: string
  permissionMode?: string
  subagentDelta?: number
  resetSubagents?: boolean
  sessionId?: string
}

/// A permission dialog held open over the spine, projected for the renderer.
/// The main process owns the actual HTTP response; the renderer answers by id.
export interface PermissionAskInfo {
  askId: string
  cardId: string
  detail: string
}

export interface NewCardResult {
  cardId: string
  folder: string
}

export type AskDecision = 'allow' | 'deny' | 'release'

/// Layout-only persistence (port of the Swift Workspace): on reopen, agents
/// reattach to surviving tmux sessions or respawn fresh. Status is never
/// persisted — a restored card is idle until real events say otherwise.
export interface WorkspaceItem {
  kind: 'card'
  id: string
  x: number
  y: number
  folder: string
}

export interface WorkspaceViewport {
  x: number
  y: number
  zoom: number
}

export interface WorkspaceSnapshot {
  items: WorkspaceItem[]
  viewport?: WorkspaceViewport
}

export interface CanvasApi {
  newCard(): Promise<NewCardResult | null>
  /** Spawn the card's pty if it isn't running — called on CardNode mount, so
   *  the terminal is always subscribed before the first byte arrives. tmux
   *  `new-session -A` makes this the restore path too (reattach or create). */
  ensureCard(cardId: string, folder: string, cols: number, rows: number): Promise<void>
  killCard(cardId: string): Promise<void>
  loadWorkspace(): Promise<WorkspaceSnapshot | null>
  saveWorkspace(snapshot: WorkspaceSnapshot): void
  write(cardId: string, data: string): void
  resize(cardId: string, cols: number, rows: number): void
  decide(askId: string, decision: AskDecision): void
  /** Release every held ask for a card — the fly-in path: while held, the
   *  terminal shows no dialog, so focusing the terminal must release. */
  releaseAsks(cardId: string): void
  onPtyData(cb: (cardId: string, data: string) => void): () => void
  onPtyExit(cb: (cardId: string) => void): () => void
  onCardEvent(cb: (cardId: string, event: CardEvent) => void): () => void
  onAsk(cb: (ask: PermissionAskInfo) => void): () => void
}
