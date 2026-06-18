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

/// One choice the agent offers for a question. `description` explains the
/// trade-off; absent on terse options.
export interface QuestionOption {
  label: string
  description?: string
}

/// One question the agent is asking (AskUserQuestion). `header` is the short
/// chip label ("Auth method"); `multiSelect` lets several options be chosen.
export interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

/// An AskUserQuestion held open over the spine — fundamentally NOT a permission
/// gate: the agent isn't asking to DO something you allow/deny, it's asking YOU
/// to decide, and ships structured options. Answered by choosing (not allowing),
/// which the CLI injects back via the tool's input. (See PermissionAskInfo for
/// the gate-an-action counterpart.)
export interface QuestionAskInfo {
  askId: string
  cardId: string
  questions: Question[]
}

/// The chosen answer per question: question text → option label, multi-select
/// labels comma-joined (the CLI's own format). Becomes `tool_input.answers`.
export type QuestionAnswers = Record<string, string>

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

/// A canvas's repo identity for the toolbar — branch + how dirty, polled for
/// every canvas (not just the active one's diff). `dirty` is the changed-file
/// count; `isRepo` false means the dir isn't a git repo.
export interface RepoIdentity {
  isRepo: boolean
  branch?: string
  dirty: number
  ahead?: number
  behind?: number
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

/// What runs inside a card: a watched agent, a bare `$SHELL` (no hooks, no
/// status — neutral chrome), or a `browser` — an in-app `<webview>` with no
/// tmux/pty session at all (neutral chrome, never speaks to the spine).
export type CardKind = 'agent' | 'shell' | 'browser'

// MARK: Multi-project persistence
//
// Card identity is GLOBAL — one tmux session, one CardRecord — while layout is
// per-project. Splitting the two is what stops a project losing track of a
// card's folder from orphaning a live session: restore rebuilds nodes from the
// `cards` registry, and projects only reference cards by id.

/// The global, layout-independent record of one agent/shell card. (Diffs are
/// NOT cards — they're a transient side sheet, never persisted.) This is what
/// restore rebuilds nodes from.
export interface CardRecord {
  id: string
  folder: string
  kind: CardKind
  /** Last-known CLI session — keys plan re-hydration across an app restart
   *  (tmux). Stale ids are harmless. */
  session?: string
  /** Display name (default "Agent N"), set by the user or the orchestrator. */
  name?: string
  /** Last-navigated page — only set for `kind === 'browser'`; reload-on-restore
   *  (the live snapshot is transient and never persisted). */
  url?: string
  /** A browser card's owning agent card id (request_browser link) — persisted so
   *  the ownership survives a restart: agents reattach to their live tmux session
   *  (reattach-not-resume), so a re-request must resolve the SAME browser instead
   *  of spawning an orphaned second one. */
  ownerCardId?: string
  /** A browser card's stated purpose (window-bar provenance) — persisted with the
   *  owner link so the restored card still reads "why". */
  reason?: string
}

/// One project's canvas: a named folder. References cards by id only — it never
/// owns their data. A project = a dir; every card on it spawns in that dir.
export interface Project {
  id: string
  name: string
  /** The project's repo root — every card on the canvas spawns here. */
  dir: string
  /** Member card ids, in stack order (top of the column first). */
  cardIds: string[]
  /** The focused (master) card. Must be one of `cardIds` when set. */
  focusedCardId?: string
}

/// The whole persisted workspace file. Layout is derived (master-stack, fixed
/// viewport), so nothing here carries geometry. `activeProjectId` is null when
/// there are no projects (the empty state).
export interface MultiProjectSnapshot {
  /** Global card registry — card data lives HERE, not on projects. */
  cards: CardRecord[]
  projects: Project[]
  activeProjectId: string | null
}

// MARK: Remote panel (Tailscale)

/// How loudly a canvas wants the user, rolled up from its cards:
/// - `blocking` — a card is stalled ON YOU (a held ask/question, or a
///   blocked/error status). The agent can't proceed without you.
/// - `done` — a card finished and is waiting for a look. Not urgent.
/// - `none` — quiet.
export type AttentionLevel = 'none' | 'done' | 'blocking'

/// The JSON projection of the canvas's attention state — what the remote
/// panel shows. The renderer publishes a fresh snapshot through the same
/// funnel that feeds the in-app activity center, so the two can never
/// disagree. (Port of the Swift RemoteState.)
export interface RemoteState {
  /** The canvases (projects), so the phone leads with "which repo needs me" —
   *  cards/approvals/questions group under these by `projectId`. */
  canvases: {
    id: string
    name: string
    /** The open (active) canvas — the one showing in the desktop viewport. The
     *  orchestrator operates on this one by default; exactly one is true when any
     *  canvas exists. */
    active: boolean
    /** Rolled-up attention: a card stalled on you (`blocking`), one done and
     *  waiting (`done`), or quiet (`none`). Mirrors the desktop toolbar. */
    attention: AttentionLevel
    /** Changed-file count; branch name. Absent/0 for a non-repo dir. */
    dirty: number
    branch?: string
  }[]
  cards: {
    id: string
    name: string
    /** agent (watched), shell (bare $SHELL), or browser (an in-app web view). */
    kind: CardKind
    status: CardStatus
    loud: boolean
    since: number // epoch seconds the status began
    task?: string
    /** A shell card's foreground command (tmux pane) — the desktop shows it on
     *  the shell face; the phone shows it on the list row. */
    running?: string
    /** A browser card's current page url — so the orchestrator (and phone) can
     *  see where it's pointed. */
    url?: string
    /** A browser card's owning agent card id — set when an agent requested the
     *  browser for itself (request_browser). The agent MCP server resolves "my
     *  browser" from this. Absent for orchestrator/hand-opened browsers. */
    ownerId?: string
    /** A browser card's stated purpose — why its owner opened it (shown on the
     *  window bar). Set/updated by request_browser. */
    reason?: string
    model?: string
    permissionMode?: string
    subagents: number
    /** Which canvas (project) this card belongs to. */
    projectId?: string
    projectName?: string
  }[]
  approvals: {
    id: string // askId
    name: string
    detail: string
    created: number
    projectId?: string
  }[]
  /** Held AskUserQuestion asks — the phone can answer these (tap options), not
   *  just allow/deny. */
  questions: {
    id: string // askId
    name: string
    projectId?: string
    questions: Question[]
  }[]
  feed: {
    name: string
    status: CardStatus
    loud: boolean
    message: string
    date: number
  }[]
  needsYou: number
}

/// Are the canvas's substrate tools on this Mac? `claude` and `tmux` gate the
/// app (nothing to supervise without the agent; sessions die with the app
/// without tmux); `brew` only decides whether `brew install tmux` is a real
/// offer. (Port of the Swift Readiness core.)
export interface AppReadiness {
  claudeFound: boolean
  tmuxFound: boolean
  brewFound: boolean
  /** The host is signed into Claude (an OAuth token is exported, or a stored
   *  `claude login` session exists) — the orchestrator reuses it. Optional: the
   *  canvas and its cards work without it. */
  orchestratorAuthed: boolean
  /** A Soniox API key is configured (env or securely stored) — enables the
   *  orchestrator's voice. Optional: everything else works without it. */
  voiceKeySet: boolean
}

/// Is the remote panel reachable over the tailnet? (Port of the Swift
/// Readiness, scoped to the tailscale chapter.)
export interface RemoteReadiness {
  /** The remote panel's bound loopback port (0 = not up yet). */
  panelPort: number
  /** The tailscale CLI exists on this Mac. */
  tailscaleFound: boolean
  /** `tailscale serve` is currently proxying the panel's port. */
  tailscaleServing: boolean
  /** The tailnet HTTPS URL serving the panel (undefined unless serving). */
  tailnetURL?: string
}

/** Auto-update lifecycle, surfaced to the in-app banner. `downloading` carries a
 *  0–100 `percent`; `ready` means the new version is staged and a restart will
 *  apply it; `error` means the check/download failed (it retries next launch). */
export type UpdateState = 'downloading' | 'ready' | 'error'

export interface UpdateStatus {
  state: UpdateState
  version?: string
  percent?: number
}

// MARK: Orchestrator (in-app agent driving the canvas)

/** How much the orchestrator may do on its own. Its OWN tools
 *  (spawn/kill/rename/focus/send/approve_ask) run freely whenever it is awake;
 *  only `manual` gates them. The supervising/autopilot difference is purely
 *  about unattended AGENT permission asks.
 *  - `manual`      — nothing wakes it (agent replies are not echoed) and every
 *                    orchestrator action needs your click at the gate.
 *  - `supervising` — it wakes on fleet events and runs its own tools without a
 *                    click; unattended agent permission asks still wait for a
 *                    human (it only approves one when you tell it to).
 *  - `autopilot`   — it wakes AND auto-approves every agent permission ask. No
 *                    clicks. Dangerous: this bypasses every confirmation. */
export type OrchestratorMode = 'manual' | 'supervising' | 'autopilot'

/** One streamed line from an orchestrator turn. The renderer shows the
 *  orchestrator's voice (`assistant`/`result`) as a transient whisper and uses
 *  `tool` only to drive a "working" pulse. `auto` marks an action autopilot took
 *  without asking (a bypassed confirmation); `mode` marks a user-driven
 *  autonomy-mode switch (a status line, not a turn); `error` surfaces as a red
 *  whisper that never auto-fades. The agents' own replies are never echoed here
 *  — the orchestrator digests them and speaks its own line. */
export interface OrchestratorEvent {
  kind: 'assistant' | 'tool' | 'result' | 'error' | 'auto' | 'mode'
  text: string
  /** Set on streamed `assistant` lines: `start` opens a live line (text empty),
   *  `delta` carries one incremental chunk, `final` carries the full text and
   *  closes it. Absent on a non-streamed assistant line and every other kind. */
  phase?: 'start' | 'delta' | 'final'
}

/** How long the action comet takes to fly from the chat bar to the target card.
 *  The action's effect is committed when the comet lands (after this), and a spawn
 *  card is revealed then — so main and the tracer agree on the timing. */
export const TRACER_TRAVEL_MS = 600

/** Fired when the orchestrator acts on a specific agent (spawn/message/kill/
 *  rename/approve) so the renderer can draw a tracer from the chat bar to that
 *  card. Targets by `cardId` when known; the orchestrator's `approve` path instead
 *  carries the `askId` (approvals don't carry a card id) and the renderer resolves
 *  it to the asking card — but the autopilot auto-approve has the card directly and
 *  sends `cardId`. So `approve` may arrive with either; the renderer takes whichever
 *  is present. */
export interface OrchestratorTarget {
  kind: 'spawn' | 'send' | 'kill' | 'rename' | 'approve'
  cardId?: string
  askId?: string
}

/// ──────────────────────────────────────────────────────────────────────────
/// Browser agency — the observation/action contract for seeing and controlling a
/// browser card's <webview>. This is the one type that must stay stable across
/// the Tier A (renderer `executeJavaScript`) and Tier B (CDP) implementations:
/// `ref` is opaque, snapshot-scoped, and resolved by the driver, never parsed by
/// the caller. See BROWSER_AGENCY_PLAN.md §2.
/// ──────────────────────────────────────────────────────────────────────────

/** One interactive element in a BrowserSnapshot (set-of-marks). */
export interface BrowserElement {
  /** Opaque handle passed back verbatim to click/type. The driver owns
   *  resolution (Tier A: a stamped `data-canvas-ref`). Valid only for the
   *  snapshot that produced it — re-read after any mutating action. */
  ref: string
  /** ARIA/a11y role: 'button' | 'link' | 'textbox' | 'checkbox' | 'combobox' | … */
  role: string
  /** Accessible name: aria-label / associated label / visible text, normalized. */
  name: string
  /** Current value for inputs/selects/textareas (omitted when empty). */
  value?: string
  /** Only the meaningful flags are present. */
  state?: {
    disabled?: boolean
    checked?: boolean | 'mixed'
    expanded?: boolean
    selected?: boolean
    focused?: boolean
    required?: boolean
  }
  /** Within the visible viewport (vs. present but scrolled off). */
  inViewport: boolean
}

/** The agent/orchestrator-facing observation of a browser card. */
export interface BrowserSnapshot {
  url: string
  title: string
  /** Scroll position + page height (CSS px) so the caller knows where it is and
   *  whether there's more above/below. */
  scroll: { x: number; y: number; maxY: number; viewportH: number }
  /** Interactive elements, viewport-first order. */
  elements: BrowserElement[]
  /** Compact readable text of the page's main content, for comprehension. */
  text: string
  /** True if `elements` or `text` were capped. */
  truncated: boolean
}

/** A mutating action against a browser card's page, keyed on an element `ref`. */
export type BrowserAction =
  | { kind: 'click'; ref: string }
  | { kind: 'type'; ref: string; text: string; clear?: boolean; submit?: boolean }
  | { kind: 'scroll'; direction: 'up' | 'down' }

/** A command the orchestrator (main) asks the renderer to execute, correlated by
 *  `id`. Discriminated on `cmd` so each payload is typed at both ends of the IPC
 *  seam — the producer (`manager.dispatch`) and the renderer's handler. */
export type OrchestratorCommand =
  | { id: number; cmd: 'focusCanvas'; payload: { canvasId: string } }
  | {
      id: number
      cmd: 'spawnAgent'
      payload: { canvasId?: string; folder?: string; prompt?: string; name?: string }
    }
  | { id: number; cmd: 'renameAgent'; payload: { cardId: string; name: string } }
  | { id: number; cmd: 'killCard'; payload: { cardId: string } }
  | {
      id: number
      cmd: 'spawnBrowser'
      payload: { canvasId?: string; url?: string; name?: string; ownerCardId?: string; reason?: string }
    }
  | { id: number; cmd: 'navigateBrowser'; payload: { cardId: string; url: string } }
  | { id: number; cmd: 'setBrowserReason'; payload: { cardId: string; reason: string } }
  | { id: number; cmd: 'readBrowser'; payload: { cardId: string } }
  | { id: number; cmd: 'screenshotBrowser'; payload: { cardId: string } }
  | { id: number; cmd: 'actBrowser'; payload: { cardId: string; action: BrowserAction } }
  | { id: number; cmd: 'confirm'; payload: { toolName: string; input: Record<string, unknown> } }

/** The renderer's reply to a mutation command (focus/spawn/rename/kill). */
export interface OrchestratorActionResult {
  ok: boolean
  message: string
  /** Set by `spawnAgent` — the id of the newly created card. */
  cardId?: string
  /** Set by `readBrowser` — the page observation. */
  snapshot?: BrowserSnapshot
  /** Set by `screenshotBrowser` — a PNG data URL of the page. */
  image?: string
}

/** The renderer's reply to a `confirm` command — the gate decision. */
export interface OrchestratorConfirmResult {
  allow: boolean
}

/** The renderer's reply to an OrchestratorCommand, by id. The shape depends on
 *  the command: `confirm` yields a gate decision, the mutations an action result. */
export type OrchestratorCommandResult = OrchestratorActionResult | OrchestratorConfirmResult

export interface CanvasApi {
  /** `folder` (the active project's dir) skips the picker; omit it to prompt. */
  newCard(folder?: string): Promise<NewCardResult | null>
  newShell(folder?: string): Promise<NewCardResult | null>
  /** Mint a browser card id — no pty, no spine session (an in-app `<webview>`).
   *  `folder` only tags the card with the active project's dir for symmetry. */
  newBrowser(folder?: string, url?: string): Promise<NewCardResult | null>
  /** Native folder picker — used when creating a project to set its dir. */
  pickFolder(message: string): Promise<string | null>
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
  /** Queue an initial prompt for a card so the agent launches already working
   *  on it (delivered as claude's initial prompt when the pty spawns). */
  setInitialPrompt(cardId: string, prompt: string): void
  loadWorkspace(): Promise<MultiProjectSnapshot | null>
  saveWorkspace(snapshot: MultiProjectSnapshot): void
  /** The CLI's stored plan for a session (null = no store / none yet). */
  readTodos(sessionId: string): Promise<AgentTodo[] | null>
  /** The foreground process in a shell card's pane (`zsh` idle, `node`/`vim`/…
   *  while running) — polled for the shell card's title. Null when the
   *  session is gone or tmux is unavailable. */
  paneCommand(cardId: string): Promise<string | null>
  /** A shell card's pane working directory, following the user's `cd`s — polled
   *  for the shell card's title. Null when the session is gone or tmux is
   *  unavailable. */
  paneCwd(cardId: string): Promise<string | null>
  // Diff: built into every canvas with a dir, watching that folder.
  /** Start polling a folder's working tree; snapshots arrive on onDiffSnapshot. */
  watchDiff(diffId: string, folder: string): Promise<void>
  unwatchDiff(diffId: string): void
  /** The unified diff for one file (rendered lazily on selection). */
  readFileDiff(folder: string, change: GitChange): Promise<string>
  /** Run a repo mutation; on success the folder's watchers re-poll immediately. */
  gitAction(folder: string, action: GitActionRequest): Promise<GitActionResult>
  onDiffSnapshot(cb: (diffId: string, snapshot: GitSnapshot) => void): () => void
  /** A canvas's branch + dirty count — polled for every canvas's dir. */
  repoIdentity(folder: string): Promise<RepoIdentity>
  /** Reveal a canvas's folder in the OS file manager. */
  revealFolder(folder: string): Promise<void>
  /** Open a canvas's folder in a GUI editor (code/cursor); false if none found. */
  openInEditor(folder: string): Promise<boolean>
  write(cardId: string, data: string): void
  /** Exit tmux scrollback (copy-mode) if the card's session is in it —
   *  awaited before the first keystroke after a wheel-scroll. */
  leaveScrollback(cardId: string): Promise<void>
  resize(cardId: string, cols: number, rows: number): void
  decide(askId: string, decision: AskDecision): void
  /** Answer a held AskUserQuestion with the chosen option(s) — the CLI injects
   *  them into the tool input, so the agent proceeds without touching the
   *  terminal. Declining is `decide(askId, 'deny')`. */
  answerQuestion(askId: string, answers: QuestionAnswers): void
  /** Release every held ask for a card — the fly-in path: while held, the
   *  terminal shows no dialog, so focusing the terminal must release. */
  releaseAsks(cardId: string): void
  onPtyData(cb: (cardId: string, data: string) => void): () => void
  onPtyExit(cb: (cardId: string) => void): () => void
  onCardEvent(cb: (cardId: string, event: CardEvent) => void): () => void
  onAsk(cb: (ask: PermissionAskInfo) => void): () => void
  /** A held AskUserQuestion arrived — render the chooser. */
  onQuestion(cb: (ask: QuestionAskInfo) => void): () => void
  // Remote panel
  /** Mirror the attention state to the remote panel (fire-and-forget). */
  publishRemoteState(state: RemoteState): void
  /** Probe tailscale + serve status for the panel's port. */
  checkRemoteReadiness(): Promise<RemoteReadiness>
  /** Probe claude/tmux/brew — drives the blocking setup gate. */
  checkAppReadiness(): Promise<AppReadiness>
  /** An ask was answered from the remote panel — clear its toast. */
  onAskDecided(cb: (askId: string) => void): () => void
  /** A held question was answered/declined from the phone — clear its chooser. */
  onQuestionDecided(cb: (askId: string) => void): () => void
  /** Open an https URL in the system browser. */
  openExternal(url: string): void
  /** App self-update progress for the in-app banner (packaged builds only). */
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
  /** Quit and install the staged update — the banner's "Restart" action. */
  quitAndInstall(): void
  // MARK: Orchestrator
  /** Send a chat prompt to the in-app orchestrator (fire-and-forget). */
  sendOrchestratorPrompt(prompt: string): void
  /** Stream of orchestrator output lines for the chat bar. */
  onOrchestratorEvent(cb: (e: OrchestratorEvent) => void): () => void
  /** A command from the orchestrator (main) to execute against the canvas. */
  onOrchestratorCommand(cb: (cmd: OrchestratorCommand) => void): () => void
  /** The orchestrator acted on an agent — draw a tracer to that card. */
  onOrchestratorTarget(cb: (target: OrchestratorTarget) => void): () => void
  /** Reply to an OrchestratorCommand by id. */
  orchestratorResult(id: number, result: OrchestratorCommandResult): void
  /** Set how autonomous the orchestrator is (see OrchestratorMode). */
  setOrchestratorMode(mode: OrchestratorMode): void
  // MARK: Voice — push-to-talk speech-to-text and spoken orchestrator replies.
  /** Whether Soniox voice is configured (a key is present in main). */
  voiceAvailable(): Promise<boolean>
  /** Validate and securely store a Soniox API key (onboarding). Rejects a bad
   *  key without persisting it; the message explains why. */
  saveVoiceKey(key: string): Promise<{ ok: boolean; message?: string }>
  /** Voice became available/unavailable (e.g. after the key is saved) — lets the
   *  chat bar reveal the mic without a restart. */
  onVoiceAvailable(cb: (available: boolean) => void): () => void
  /** Report whether the orchestrator's voice is actively playing — main paces its
   *  agent actions so they land with the narration, not ahead of it. */
  notifyVoicePlaying(playing: boolean): void
  /** Begin a push-to-talk utterance — opens the STT session in main. */
  startSpeech(): void
  /** Stream one chunk of mic audio (raw pcm_s16le, mono, 16 kHz). */
  sendSpeechAudio(pcm: ArrayBuffer): void
  /** Release — finalize the utterance; the transcript arrives on onSpeechFinal. */
  finishSpeech(): void
  /** Abort the current utterance without transcribing it. */
  cancelSpeech(): void
  /** Live transcript (finalized + interim) while holding to talk. */
  onSpeechPartial(cb: (text: string) => void): () => void
  /** The finished utterance after release — feed it to the orchestrator. */
  onSpeechFinal(cb: (text: string) => void): () => void
  /** STT failed, or no key — render as a hint. */
  onSpeechError(cb: (message: string) => void): () => void
  /** A chunk of spoken-reply audio (raw pcm_s16le, mono, 24 kHz) to play. Arrives
   *  as a Uint8Array — a Node Buffer sent over IPC structured-clones to that, never
   *  a bare ArrayBuffer. */
  onTtsAudio(cb: (pcm: Uint8Array) => void): () => void
  /** Barge-in / new reply — drop any queued or playing TTS audio. */
  onTtsReset(cb: () => void): () => void
}
