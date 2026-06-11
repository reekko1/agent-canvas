// Shared between main, preload, and renderer (types only — erased at build).

export type CardStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'done'
  | 'stalled'
  | 'blocked'
  | 'error'

/// One item of the agent's self-published plan. `activeForm` is the
/// present-tense phrasing of the in-progress item ("Wiring the sink…") —
/// exactly the line a distant card should show.
export interface AgentTodo {
  id: string
  content: string
  status: string // "pending" | "in_progress" | "completed"
  activeForm?: string
}

/// How a CLI event changes the agent's plan. Claude Code ≥2.1 streams it
/// incrementally (TaskCreate/TaskUpdate); older CLIs replace the whole list
/// per call (TodoWrite). The card owns the accumulated list; adapters stay
/// stateless. (Port of the Swift TodoChange.)
export type TodoChange =
  | { kind: 'replace'; todos: AgentTodo[] }
  | { kind: 'add'; todo: AgentTodo }
  | { kind: 'update'; id: string; status?: string; content?: string; activeForm?: string }
  | { kind: 'clear' }

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
  todoChange?: TodoChange
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

// MARK: Git (diff objects)

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/// One changed file in the working tree relative to HEAD.
export interface GitChange {
  path: string // current path (what we diff against)
  oldPath?: string // previous path, for renames
  status: GitFileStatus
  added: number
  removed: number
  hasStaged: boolean // index column (X) set — there are staged changes
  hasUnstaged: boolean // worktree column (Y) set — incl. untracked
  stagedStatus?: GitFileStatus // X column → shown in the "Staged Changes" group
  unstagedStatus?: GitFileStatus // Y column → shown in the "Changes" group
}

/// A point-in-time view of a working tree. `isRepo == false` means not a git
/// work tree; empty `changes` with `isRepo == true` is a clean tree.
export interface GitSnapshot {
  isRepo: boolean
  changes: GitChange[]
  totalAdded: number
  totalRemoved: number
  /** Cheap fingerprint for change-detection (porcelain + numstat raw output). */
  signature: string
}

/// The result of a mutating git action — ok plus a human-readable message
/// (the git stderr on failure) so the UI can surface it.
export interface GitActionResult {
  ok: boolean
  message: string
}

/// Every repo mutation the diff object may request — only ever from an
/// explicit user action (destructive ones behind a confirmation).
export type GitActionRequest =
  | { kind: 'stage' | 'unstage' | 'discard'; change: GitChange }
  | { kind: 'stageAll' | 'unstageAll' | 'discardAll' }
  | { kind: 'commit'; message: string }

export interface NewDiffResult {
  diffId: string
  folder: string
}

/// Layout-only persistence (port of the Swift Workspace): on reopen, agents
/// reattach to surviving tmux sessions or respawn fresh. Status is never
/// persisted — a restored card is idle until real events say otherwise.
export interface WorkspaceItem {
  kind: 'card' | 'shell' | 'diff' | 'frame'
  id: string
  x: number
  y: number
  /** Item size — absent in pre-resize workspaces (loader falls back to the default). */
  w?: number
  h?: number
  /** Working folder — cards/shells/diffs have one; frames don't. */
  folder?: string
  /** Display name — frames only (cards/diffs derive theirs from the folder). */
  title?: string
  /** The card's last-known CLI session — NOT a status: it keys plan
   *  re-hydration from the CLI's task store when the session survives an app
   *  restart (tmux). Stale ids are harmless. */
  session?: string
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

/// What runs inside a card's terminal: a watched agent, or a bare `$SHELL`
/// (no hooks, no status — neutral chrome).
export type CardKind = 'agent' | 'shell'

export interface CanvasApi {
  newCard(): Promise<NewCardResult | null>
  newShell(): Promise<NewCardResult | null>
  /** Spawn the card's pty if it isn't running — called on CardNode mount, so
   *  the terminal is always subscribed before the first byte arrives. tmux
   *  `new-session -A` makes this the restore path too (reattach or create). */
  ensureCard(
    cardId: string,
    folder: string,
    cols: number,
    rows: number,
    kind: CardKind,
  ): Promise<void>
  killCard(cardId: string): Promise<void>
  loadWorkspace(): Promise<WorkspaceSnapshot | null>
  saveWorkspace(snapshot: WorkspaceSnapshot): void
  /** The CLI's stored plan for a session (null = no store / none yet). */
  readTodos(sessionId: string): Promise<AgentTodo[] | null>
  // Diff objects
  newDiff(): Promise<NewDiffResult | null>
  /** Start polling a folder's working tree; snapshots arrive on onDiffSnapshot. */
  watchDiff(diffId: string, folder: string): Promise<void>
  unwatchDiff(diffId: string): void
  /** The unified diff for one file (rendered lazily on selection). */
  readFileDiff(folder: string, change: GitChange): Promise<string>
  /** Run a repo mutation; on success the folder's watchers re-poll immediately. */
  gitAction(folder: string, action: GitActionRequest): Promise<GitActionResult>
  onDiffSnapshot(cb: (diffId: string, snapshot: GitSnapshot) => void): () => void
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
