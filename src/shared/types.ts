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

/// An agent card's role in the Mastermind org (MASTERMIND.md). `worker` is the
/// default; `planner` writes the plan, `lead` decomposes the plan into issues and
/// coordinates, `strategist` is the autonomous head — it runs the idea tournament
/// and hands the winning idea to a planner (it writes only its own Conception).
/// Drives both the card's issue-MCP tool grant (capability) and its skill (behavior).
export type AgentRole = 'planner' | 'lead' | 'worker' | 'strategist'

/** The card-id sentinel a card sends when it has none — the `${CANVAS_CARD_ID:-…}`
 *  default the spine bakes into each card's browser MCP headers (claudeAdapter
 *  `stageBrowserMcp`) and the value the agent browser MCP guard treats as "no
 *  card". Shared so the two ends can't drift apart. */
export const UNKNOWN_CARD = 'unknown'

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
  /** The agent's Mastermind role (planner/lead/worker/strategist). Absent = a plain
   *  agent, treated as a worker by the issue MCP. Persisted so the org survives restart. */
  role?: AgentRole
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
    /** The agent's Mastermind role — the issue MCP resolves a card's tool grant
     *  from this (absent = worker). */
    role?: AgentRole
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

/** How a sprint gets BORN — and how much the orchestrator drives on its own. Its
 *  OWN tools (spawn/kill/rename/focus/send) run freely whenever it is awake; only
 *  `manual` gates them. `partner` and `autonomous` share one execution cascade
 *  (planner → lead → workers, each self-auditing); they differ only at the head.
 *  - `manual`     — nothing wakes it (fleet events are not echoed) and every
 *                   orchestrator action needs your click at the gate.
 *  - `partner`    — YOU originate work by talking to a planner (it interviews you;
 *                   you confirm the plan). The orchestrator then drives the cascade
 *                   — spawns the lead, hires workers on request — without a click.
 *  - `autonomous` — the mastermind originates work itself (the strategist finds a
 *                   vision gap, later) and drives the whole cascade unattended.
 *                   Same cascade as partner; different head. */
export type OrchestratorMode = 'manual' | 'partner' | 'autonomous'

/** One streamed line from an orchestrator turn. The renderer shows the
 *  orchestrator's voice (`assistant`/`result`) as a transient whisper and uses
 *  `tool` only to drive a "working" pulse. `auto` marks an action the mastermind
 *  took on its own (e.g. hiring workers for a lead); `mode` marks a user-driven
 *  mode switch (a status line, not a turn); `error` surfaces as a red
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
 *  card is revealed then — so main and the comet agree on the timing. */
export const COMET_TRAVEL_MS = 600

/** Fired when the orchestrator acts on a specific agent (spawn/message/kill/
 *  rename/approve) so the renderer can draw a comet from the chat bar to that
 *  card. Targets by `cardId` when known; the `approve` path may instead carry the
 *  `askId` (approvals don't carry a card id) and the renderer resolves it to the
 *  asking card. So `approve` may arrive with either; the renderer takes whichever
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
  | { kind: 'select'; ref: string; value: string }
  | { kind: 'history'; action: 'back' | 'forward' | 'reload' }

/** The result of a browser act — the shared ok/message contract relayed along the
 *  whole act seam (renderer handle → bus → CDP driver). Named so all three ends
 *  add a field in one place instead of three hand-kept inline literals. */
export interface BrowserActionResult {
  ok: boolean
  message: string
}

/** A command the orchestrator (main) asks the renderer to execute, correlated by
 *  `id`. Discriminated on `cmd` so each payload is typed at both ends of the IPC
 *  seam — the producer (`manager.dispatch`) and the renderer's handler. */
export type OrchestratorCommand =
  | { id: number; cmd: 'focusCanvas'; payload: { canvasId: string } }
  | {
      id: number
      cmd: 'spawnAgent'
      payload: { canvasId?: string; folder?: string; prompt?: string; name?: string; role?: AgentRole }
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
  // The gate copy is built in main (manager.describeGate) where the canvas tool
  // vocabulary lives, with ids already resolved to names — the renderer only
  // displays it. (Was { toolName, input }, which made the renderer reverse-
  // engineer each verb's label.)
  | { id: number; cmd: 'confirm'; payload: { title: string; detail: string } }
  // Fire-and-forget (no result expected): dismiss a confirm gate by id when it was
  // resolved on another device (the phone) or timed out. Lets the desktop toast
  // clear instead of lingering when the user answers from their phone.
  | { id: number; cmd: 'confirm-clear' }

/** The renderer's reply to any non-`confirm` OrchestratorCommand — the mutations
 *  (focus/spawn/rename/kill, browser open/navigate/act) plus the browser reads,
 *  which populate `snapshot`/`image`. */
export interface OrchestratorActionResult {
  ok: boolean
  message: string
  /** Set by `spawnAgent` / `spawnBrowser` — the id of the newly created card. */
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

/// ──────────────────────────────────────────────────────────────────────────
/// Orchestrator over the wire — the phone (`src/remote-app`, which aliases
/// `@shared`) is a second, co-equal client into the same orchestrator session
/// over the `/orch` WebSocket. Text frames are JSON (control + events); audio is
/// sent as raw binary PCM frames (mic up @16kHz, TTS down @24kHz) to keep base64
/// off the hot path. The desktop still speaks IPC; these types are the phone seam.
/// ──────────────────────────────────────────────────────────────────────────

/** A text frame the phone sends to main over `/orch`. (Mic audio is a separate
 *  binary frame, bracketed by `stt-start`/`stt-finish`.) */
export type OrchClientFrame =
  | { t: 'prompt'; text: string }
  | { t: 'mode'; mode: OrchestratorMode }
  | { t: 'confirm'; id: number; allow: boolean }
  | { t: 'stt-start' }
  | { t: 'stt-finish' }
  | { t: 'stt-cancel' }

/** A text frame main sends to the phone over `/orch`. (TTS audio is a separate
 *  binary frame.) `hello` is sent once on connect so the phone reflects the live
 *  mode and whether voice is configured; `confirm-clear` dismisses a gate the user
 *  answered on another device. */
export type OrchServerFrame =
  | { t: 'hello'; mode: OrchestratorMode; voiceAvailable: boolean }
  | { t: 'event'; event: OrchestratorEvent }
  | { t: 'confirm'; id: number; title: string; detail: string }
  | { t: 'confirm-clear'; id: number }
  | { t: 'stt-partial'; text: string }
  | { t: 'stt-final'; text: string }
  | { t: 'stt-error'; message: string }
  | { t: 'tts-reset' }
  | { t: 'mode'; mode: OrchestratorMode }

// MARK: Issue store (Mastermind substrate)
//
// Main-owned reactive store for the Vision → Sprint → Plan → Issue chain (see
// MASTERMIND.md). Main is the single arbiter: every mutation funnels through
// IssueStore.apply, which runs synchronously to completion, so writes never
// interleave and atomic claims are free. Projected two ways — to the visible
// renderer board (IPC) and, in a later milestone, to agents (MCP). The whole
// chain is per-project (per canvas): each canvas has its OWN vision, versions,
// sprints, plans, issues, and distance — one north star per product/repo. In v1
// there are NO agents: every place an agent will eventually act (gate verdicts,
// propagation adjudication, gap / distance assessment) is a manual human action
// behind a seam an agent later assumes — the store never knows whether a human
// or an agent called it.

/// How a vision edit bears on downstream work — the diff's classification IS a
/// planning directive. `clarification` invalidates nothing; `redirection` may
/// strand in-flight sprints; `expansion` may spawn new ones. In v1 the human
/// sets this on commit; later an auditor verifies it.
export type VisionEditClass = 'clarification' | 'redirection' | 'expansion'

/// One immutable, committed state of a canvas's vision — append-only, never
/// mutated in place ("git for intent"). `body` is a self-contained snapshot, not
/// a delta, so any version is judgeable standalone. `n` is the monotonic version
/// number; `rationale` is WHY it changed (the steering context the propagation
/// pass reasons over). Author is always the human (agents may propose, never commit).
export interface VisionVersion {
  id: string
  /** The project (canvas) this version belongs to. */
  projectId: string
  /** Monotonic version number (1-based), per project; the diff between n-1 and n drives propagation. */
  n: number
  /** The full vision body at this point (markdown) — a snapshot, not a delta. */
  body: string
  principles: string[]
  antiVision: string[]
  /** Why it changed — the steering rationale the propagation pass reasons over. */
  rationale: string
  class: VisionEditClass
  author: 'human'
  committedAt: number // epoch ms
}

/// A canvas's vision pointer — its north star. One per project; `currentVersion`
/// names the latest VisionVersion id for that project (null before its first
/// commit). The versions themselves live in IssueSnapshot.
export interface Vision {
  projectId: string
  currentVersion: string | null
}

/// Where a sprint sits in its lifecycle — the mastermind's "what to do next"
/// input. Gate transitions are MANUAL (human) in v1; an agent assumes them
/// later. `REALIGNMENT_PENDING` is the propagation-pass landing state: a vision
/// bump marked this sprint stale and a human (later: an auditor) must re-verdict.
export type SprintState =
  | 'DRAFT'
  | 'PLAN_REVIEW'
  | 'APPROVED'
  | 'DECOMPOSED'
  | 'EXECUTING'
  | 'OUTCOME_REVIEW'
  | 'DONE'
  | 'REALIGNMENT_PENDING'

/// One outcome-bounded plan — the unit the mastermind reasons over. Outcome-based,
/// NOT time-based: no end-date, no velocity, no time-box. `visionVersionRef` PINS
/// the version it was conceived under (mid-plan version races are reconciled by
/// the propagation pass, not by locking).
export interface Sprint {
  id: string
  /** The project (canvas) this sprint advances — scopes the board per-repo. */
  projectId: string
  /** The pinned VisionVersion id this sprint was conceived under (provenance chain). */
  visionVersionRef: string
  /** A short, general title — a few words naming what the sprint delivers, no
   *  technical detail. The headline on the board; the specifics live in the plan. */
  title: string
  /** The outcome / definition-of-done — done when verified, never when time elapses. */
  outcome: string
  /** Which part of the vision gap this sprint closes (gate #0 conception). */
  gapRationale: string
  state: SprintState
  /** Set when a vision bump moved this sprint to REALIGNMENT_PENDING — the diff
   *  the human (later: auditor) judges, plus the state to restore on "still aligned". */
  realignment?: {
    fromVisionVersion: string
    toVisionVersion: string
    priorState: SprintState
    /** Human-authored verdict in v1 (the manual seam for the agent propagation pass). */
    note?: string
  }
  createdAt: number
}

/// The sprint's approved blueprint: stack, structure, deps DAG. Approved (gate #1)
/// before any decomposition into issues. `approved` flips on the manual gate.
export interface Plan {
  id: string
  sprintRef: string
  overview: string
  stack: string[]
  /** Prose description of the structure/architecture the lead proposes. */
  structure: string
  /** The plan-level dependency graph as adjacency: node id → ids it depends on. */
  deps: Record<string, string[]>
  nonGoals: string[]
  /** Gate #1 verdict — MANUAL human approval in v1; an auditor verdict later. */
  approved: boolean
  createdAt: number
}

/// What an issue IS — a task (executable unit), an audit-gate node (a gate #0–#4
/// checkpoint rendered as a distinct board node), or a decision (a needs-decision
/// escalation to the human).
export type IssueKind = 'task' | 'audit-gate' | 'decision'

/// An issue's work lifecycle. `ready` = all deps satisfied, claimable. A worker
/// owns one at a time; closed when done AND audited. In v1 a human flips these.
/// `superseded` is the one TERMINAL-VOID state: the lead retired a flawed issue
/// (`issue.retire`) instead of mutating it in place — it stays on the board for
/// provenance but is out of the live DAG (auto-pruned from dependents' `deps`).
export type IssueStatus =
  | 'backlog'
  | 'ready'
  | 'claimed'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'superseded'

/// An audit verdict on an issue (gate output). APPROVED clears it; ISSUES carries
/// findings, each adjudicated `clear-fix` (dispatch a fixer) or `needs-decision`
/// (escalate to human). In v1 the human posts these; an auditor agent does later.
export interface IssueVerdict {
  id: string
  verdict: 'APPROVED' | 'ISSUES'
  findings: string
  disposition?: 'clear-fix' | 'needs-decision'
  /** Who posted it — 'human' in v1; an auditor card id later. */
  author: string
  postedAt: number
}

/// A free-text note on an issue (worker progress, blocker report).
export interface IssueComment {
  id: string
  author: string
  body: string
  postedAt: number
}

/// The lead's decomposition of an approved plan into executable DAG nodes. Traces
/// up to a plan → sprint → vision. Closed when done AND audited. `deps` are other
/// issue ids (the DAG edges); `owner` is the worker card id (links a card — WHO —
/// to an issue — WHAT). `intentRef` pins the vision version (inherited from the
/// sprint) for the per-issue delta on a bump.
export interface Issue {
  id: string
  planRef: string
  title: string
  description: string
  /** Acceptance criteria — what "done" is checked against (gate #3). */
  verify: string
  status: IssueStatus
  /** Owning worker card id, or null when unclaimed. Atomic claim sets this. */
  owner: string | null
  /** Phase/group label for ordering the DAG into waves. */
  phase?: string
  /** Issue ids this one depends on (the DAG edges). */
  deps: string[]
  labels: string[]
  kind: IssueKind
  verdicts: IssueVerdict[]
  comments: IssueComment[]
  /** The vision version this issue was built for (inherited from its sprint). */
  intentRef: string
  /** Set when this issue was retired (`status: 'superseded'`) in favour of another —
   *  the replacement issue id, so the lineage of a restructure stays legible. */
  supersededBy?: string
  createdAt: number
  /** Epoch ms a stall was detected on the current claim (set by the stall sweep via
   *  `issue.setStall`, cleared when the owner shows life or the claim changes). A
   *  de-dup latch: the `stalled` milestone fires only on the not-stalled → stalled
   *  edge. */
  stalledAt?: number
}

/// A qualitative gap judgment — distance to the vision is ASSESSED, never
/// computed (a recurring independent judgment, not a number). Human-authored in
/// v1 (`assessedBy: 'human'`); a recurring auditor agent fills the same slot later.
export interface DistanceAssessment {
  /** The project (canvas) this judgment is about. */
  projectId: string
  note: string
  assessedBy: string
  at: number
}

/// One candidate "next sprint idea" from a generator in the strategist's tournament —
/// INTENT, never a technical spec (the schema IS the boundary: no field can hold
/// implementation). The four core fields map onto the Sprint the planner later
/// creates: `idea`→title, `outcome`→outcome, `why`→gapRationale, `visionLink`→visionVersionRef.
export interface Idea {
  id: string
  /** The move, in one line (may name an approach, never the how). */
  idea: string
  /** The gap it closes + why it is the highest-leverage move now. */
  why: string
  /** What is observably different once done — intent altitude, not acceptance criteria. */
  outcome: string
  /** The exact principle / anti-vision / capability it serves (the upward trace). */
  visionLink: string
  /** The generator lens that authored it — sticky across refinement rounds. */
  lens: string
  /** Bradley-Terry rating from the last round it competed in (absent until judged). */
  rating?: number
  /** The round it was culled in (absent while still in the field). */
  eliminatedRound?: number
}

/// One recorded round of a strategist tournament — the human-visible bracket, round
/// by round. `survivors` are the Idea ids carried into the next round.
export interface ConceptionRound {
  n: number
  survivors: string[]
  note?: string
}

/// A strategist deliberation — the recorded idea tournament (gate #0 conception), and
/// the autonomous head's ONLY write. Rides the IssueSnapshot like every other
/// per-project record. `deliberating` while the tournament runs; `decided` fires
/// `idea-ready` (the mastermind spawns a planner with the winner); `abstained` fires
/// `idea-abstained` (escalate to the human — never manufacture a sprint).
export interface Conception {
  id: string
  /** The project (canvas) this deliberation is for. */
  projectId: string
  /** The pinned VisionVersion id it deliberated under (provenance). */
  visionVersionRef: string
  /** The strategist's perception baseline (vision-vs-reality), if recorded. */
  gapRead?: string
  candidates: Idea[]
  rounds: ConceptionRound[]
  state: 'deliberating' | 'decided' | 'abstained'
  /** The winning Idea id — set when state flips to `decided`. */
  winnerIdeaRef?: string
  /** Why it abstained — set when state flips to `abstained`. */
  abstainReason?: string
  createdAt: number
}

/// Every mutation the issue store accepts — the discriminated union mirrored at
/// the IPC seam (cf. GitActionRequest / OrchestratorCommand). Main validates each
/// against current state, applies atomically, appends to the log, and emits a
/// change. In v1 these all originate from the renderer (human); later the MCP
/// server emits the same union, role-scoped per the org chart. (`issue.create`
/// names its field `issueKind` to avoid colliding with the union's `kind` tag.)
export type IssueActionRequest =
  // Vision (per-canvas, human-write-only; commit appends an immutable VisionVersion)
  | {
      kind: 'vision.commit'
      projectId: string
      body: string
      principles: string[]
      antiVision: string[]
      rationale: string
      class: VisionEditClass
    }
  // Distance (per-canvas, assessed, recurring)
  | { kind: 'vision.assessDistance'; projectId: string; note: string; assessedBy: string }
  // Sprint
  | { kind: 'sprint.create'; projectId: string; title: string; outcome: string; gapRationale: string }
  | { kind: 'sprint.setState'; id: string; state: SprintState }
  | { kind: 'sprint.resolveRealignment'; id: string; outcome: 'aligned' | 'remove'; note?: string }
  | { kind: 'sprint.remove'; id: string }
  // Plan
  | {
      kind: 'plan.create'
      sprintRef: string
      overview: string
      stack: string[]
      structure: string
      deps: Record<string, string[]>
      nonGoals: string[]
    }
  | { kind: 'plan.approve'; id: string } // gate #1 — manual in v1
  // Issue
  | {
      kind: 'issue.create'
      planRef: string
      title: string
      description: string
      verify: string
      issueKind: IssueKind
      phase?: string
      deps?: string[]
      labels?: string[]
    }
  | { kind: 'issue.setStatus'; id: string; status: IssueStatus }
  | { kind: 'issue.claim'; id: string; owner: string } // atomic test-and-set on owner
  | { kind: 'issue.release'; id: string }
  // Stall latch — set by the main-process stall sweep (NOT an agent-facing action).
  // Idempotent + edge-triggered: `stalled: true` on a not-yet-stalled owned issue
  // stamps `stalledAt` and fires the `stalled` milestone; `stalled: false` clears the
  // latch when the owner shows life again. No-op when already in the target state.
  | { kind: 'issue.setStall'; id: string; stalled: boolean }
  | { kind: 'issue.setDeps'; id: string; deps: string[] }
  | {
      kind: 'issue.postVerdict'
      id: string
      verdict: 'APPROVED' | 'ISSUES'
      findings: string
      disposition?: 'clear-fix' | 'needs-decision'
      author: string
    }
  | { kind: 'issue.comment'; id: string; author: string; body: string }
  // Refine an issue in place — correct/tighten the impl steps and/or the acceptance
  // criteria WITHOUT a new identity (the log preserves the prior value; an audit note
  // is appended as a comment). Rejected on a done/superseded issue (retire instead).
  | { kind: 'issue.amend'; id: string; author: string; description?: string; verify?: string; note?: string }
  // Retire a flawed issue: flip to `superseded` (terminal void), free its owner, append
  // a RETIRED note, and AUTO-PRUNE its id from every dependent's `deps` so nothing
  // deadlocks waiting on it (newly-unblocked dependents flip backlog → ready). The
  // replacement is created separately; `supersededBy` records the lineage.
  | { kind: 'issue.retire'; id: string; author: string; reason: string; supersededBy?: string }
  // Conception (strategist deliberation — the recorded idea tournament; gate #0).
  // `conception.create` pins `visionVersionRef` from the current vision (mirrors
  // sprint.create); the store mints the Conception id and each candidate Idea id.
  | {
      kind: 'conception.create'
      projectId: string
      gapRead?: string
      /** The full candidate field — each with its final rating and the round it was
       *  culled in (omit `eliminatedRound` for a survivor). The store mints each id. */
      candidates: {
        idea: string
        why: string
        outcome: string
        visionLink: string
        lens: string
        rating?: number
        eliminatedRound?: number
      }[]
    }
  | {
      kind: 'conception.updateRound'
      id: string
      /** The round just completed (number, surviving Idea ids, optional note). */
      round: { n: number; survivors: string[]; note?: string }
      /** Per-candidate rating / elimination updates, applied in place by Idea id. */
      ratings?: { ideaRef: string; rating?: number; eliminatedRound?: number }[]
    }
  | { kind: 'conception.setWinner'; id: string; winnerIdeaRef: string } // → decided, fires idea-ready
  | { kind: 'conception.abstain'; id: string; reason?: string } // → abstained, fires idea-abstained

/// The reply to one issue action — `ok` plus a message on rejection (e.g. an
/// illegal state transition or a claim on an already-owned issue) and the new
/// entity's id on a create.
export interface IssueActionResult {
  ok: boolean
  message?: string
  /** The created entity's id (sprint/plan/issue/version create actions). */
  id?: string
}

/// The materialized read-projection main pushes to the renderer (the visible
/// board). Like RemoteState, a whole-state snapshot — every collection is flat,
/// keyed by `projectId`, and the renderer filters to the active canvas then trees
/// it by vision → sprint → plan → issue. `distance` is the recurring judgment
/// timeline (newest last); `conceptions` are the strategist's recorded tournaments.
export interface IssueSnapshot {
  visions: Vision[]
  versions: VisionVersion[]
  sprints: Sprint[]
  plans: Plan[]
  issues: Issue[]
  distance: DistanceAssessment[]
  /** Strategist deliberations (the recorded idea tournaments), per project. */
  conceptions: Conception[]
}

/// One self-authored skill, read-only, for the UI gallery. The mastermind's learned
/// orchestration procedures live as SKILL.md files; this is a flattened view of one (no
/// model call to build it). `source` is the audit provenance, e.g.
/// `episode:<projectId>:<kind>` / `window:<projectId>` / `conversation` — the renderer can pull a
/// canvas id out of it to label where the skill was learned. The library is GLOBAL (not
/// per-canvas), so the same set shows on every canvas.
export interface SkillView {
  name: string
  description: string
  body: string
  /** ISO timestamp the skill was authored (frontmatter `created_at`); '' if absent. */
  createdAt: string
  /** Provenance of the authoring (frontmatter `source`). */
  source: string
  /** Epoch ms it was last invoked, or null if never. */
  lastUsed: number | null
  archived: boolean
}

/// The whole skill library as the UI sees it: active skills + archived (curator-aged)
/// ones, each newest-first. Pushed on every change via `onSkillsUpdate`.
export interface SkillsSnapshot {
  active: SkillView[]
  archived: SkillView[]
}

/// A board milestone the IssueStore emits on a meaningful transition — the
/// mastermind's wake signal (it sees only these, never the work). Fires `plan-ready`
/// (plan approved → spawn a lead), the issue-cascade signals, and the strategist's
/// `idea-ready` (a tournament decided → spawn a planner with the winner) /
/// `idea-abstained` (no winner → escalate to the human). The learning layer adds
/// the friction signals `retire` / `amend` (a lead repaired a flawed issue) and
/// `stalled` (an assigned worker went silent past the heartbeat threshold).
/// NB `sprint-ready` is reserved in this union but is not emitted anywhere yet.
export interface IssueMilestone {
  kind:
    | 'plan-ready'
    | 'issue-assigned'
    | 'issue-done'
    | 'issue-blocked'
    | 'sprint-ready'
    | 'outcome-verified'
    | 'idea-ready'
    | 'idea-abstained'
    | 'stalled'
    | 'retire'
    | 'amend'
  projectId: string
  sprintId?: string
  issueId?: string
  /** The strategist deliberation (on `idea-ready` / `idea-abstained`). */
  conceptionId?: string
  /** The worker an issue was assigned to (on `issue-assigned` / `stalled`). */
  ownerId?: string
  /** Human context (e.g. the sprint outcome, or an issue title) for the brief. */
  detail?: string
}

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
  /** The orchestrator acted on an agent — draw a comet to that card. */
  onOrchestratorTarget(cb: (target: OrchestratorTarget) => void): () => void
  /** Reply to an OrchestratorCommand by id. */
  orchestratorResult(id: number, result: OrchestratorCommandResult): void
  /** A browser card's <webview> reached dom-ready (carrying its WebContents id)
   *  or was torn down (`null`). Feeds main's readiness map so browser tools wait
   *  on a real signal instead of a fixed delay, and Tier-B CDP knows the id. */
  browserReady(cardId: string, webContentsId: number | null): void
  /** Main asks the renderer to wake a dormant (evicted) browser so it can be
   *  driven — the renderer makes it live again (mounting its guest). */
  onBrowserWake(cb: (cardId: string) => void): () => void
  /** Main signals that a browser card's page was screenshotted — the renderer
   *  plays a one-shot scan sweep on that card (feedback, not in the capture). */
  onBrowserScan(cb: (cardId: string) => void): () => void
  /** Set how autonomous the orchestrator is (see OrchestratorMode). */
  setOrchestratorMode(mode: OrchestratorMode): void
  // MARK: Issue store (Mastermind substrate)
  /** Load the whole issue-store projection (Vision → Sprint → Plan → Issue,
   *  plus strategist conceptions). */
  loadIssueStore(): Promise<IssueSnapshot>
  /** Apply one mutation; the result surfaces rejections (illegal transition, a
   *  claim on an owned issue). Truth then arrives over onIssueUpdate. */
  issueAction(action: IssueActionRequest): Promise<IssueActionResult>
  /** The store changed — main re-pushes the whole projection on every action. */
  onIssueUpdate(cb: (snapshot: IssueSnapshot) => void): () => void
  // MARK: Mastermind skills (read-only gallery)
  /** Load the mastermind's self-authored skill library (active + archived). */
  loadMastermindSkills(): Promise<SkillsSnapshot>
  /** The skill library changed (the reviewer authored/patched a skill) — main
   *  re-pushes the whole snapshot so the gallery refreshes live. */
  onSkillsUpdate(cb: (snapshot: SkillsSnapshot) => void): () => void
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
