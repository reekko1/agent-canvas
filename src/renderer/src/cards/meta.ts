import type { AgentRole, AgentTodo, CardEvent, CardKind, CardStatus, CliKind } from '@shared/types'

// Status palette lives in index.css (:root tokens); loud = blocked/error.
export const STATUS_COLORS: Record<CardStatus, string> = {
  idle: 'var(--status-idle)',
  running: 'var(--status-running)',
  waiting: 'var(--status-waiting)',
  done: 'var(--status-done)',
  stalled: 'var(--status-stalled)',
  blocked: 'var(--status-blocked)',
  error: 'var(--status-error)',
}

const LOUD_STATUSES: ReadonlySet<CardStatus> = new Set(['blocked', 'error'])
/** Loud = the agent is stalled ON YOU — a blocked or error status. The single
 *  source for that predicate (call sites that also track held asks OR this in). */
export const isLoud = (s: CardStatus): boolean => LOUD_STATUSES.has(s)

/// A card's accumulated spine state — everything the chrome and the poster
/// render. Owned by the canvas (per node), fed exclusively by applyCardEvent.
export interface CardMeta {
  status: CardStatus
  /** When the status last changed — feeds the "· 14m" attention-debt suffix. */
  statusSince?: number
  /** The CLI's own session/thread id — persisted (unlike status) so a
   *  relaunched card's first send resumes the same conversation. */
  sessionId?: string
  detail?: string
  task?: string
  summary?: string
  model?: string
  permissionMode?: string
  subagents?: number
  todos?: AgentTodo[]
}

/** The state a browser card's webview reports up on navigation / retitle /
 *  favicon change / demote snapshot. One shape shared by `CardData.onNavigate`,
 *  `BrowserView`'s prop, and the canvas's `navigateCard` so a new field can't be
 *  added at one site and silently dropped at the others. */
export interface BrowserNavPatch {
  url?: string
  title?: string
  favicon?: string
  snapshot?: string
}

export interface CardData extends Record<string, unknown> {
  folder: string
  /** 'agent' = a headless CLI session (claude or codex); 'shell' = bare
   *  $SHELL, no session for the spine to speak about, so its meta stays idle
   *  forever; 'browser' = an in-app <webview>, no session at all, neutral chrome. */
  kind: CardKind
  /** Display name — defaults to "Agent N" for agents; user/orchestrator renameable. */
  name?: string
  /** The agent's Mastermind role (planner/lead/worker) — drives its issue-MCP tool
   *  grant. Absent = a plain agent (worker). Persisted via CardRecord. */
  role?: AgentRole
  /** Which CLI backs this agent card (claude/codex) — chosen at spawn, passed to
   *  startAgent so the spine picks the right driver. Absent = claude. Persisted. */
  cli?: CliKind
  /** Current page — only for `kind === 'browser'`. Tracked live from the
   *  webview's navigation and persisted (the card reloads it on restore). */
  url?: string
  /** A browser card's owning agent card id — set when an agent requested it via
   *  request_browser. Lets the agent MCP server resolve "my browser". Persisted
   *  (CardRecord) so the link survives a restart: a re-request must find the
   *  same browser, not spawn a new one. */
  ownerCardId?: string
  /** A browser card's stated purpose (why its owner opened it) — rendered on the
   *  window bar for provenance. Persisted alongside the owner link. */
  reason?: string
  /** Live page title / favicon-url for a browser card's chrome and face.
   *  Transient — re-derived from the webview on load, never persisted. */
  title?: string
  favicon?: string
  /** A small data-URL thumbnail captured when a browser card is demoted from
   *  master — what the stacked BrowserFace shows. Transient (never persisted). */
  snapshot?: string
  /** An imperative navigation request for a browser card (from the orchestrator).
   *  BrowserView loads `url` whenever `nonce` changes; the address bar / user
   *  navigation drives the webview directly and doesn't go through this. */
  goto?: { url: string; nonce: number }
  meta: CardMeta
  onClose: (cardId: string) => void
  /** Promote this card to the master slot — fired when its stacked poster is
   *  clicked. No-op when it's already the master. */
  onPromote: (cardId: string) => void
  /** A browser card navigated, retitled, or produced a fresh blur snapshot —
   *  folds the patch back into the node so persistence (url) and the chrome /
   *  face (title, favicon, snapshot) track the live webview. */
  onNavigate: (cardId: string, patch: BrowserNavPatch) => void
}

/** Fold one spine event into a card's meta (pure — the canvas owns the state,
 *  the driver stays stateless, and this stays testable). */
export function applyCardEvent(m: CardMeta, ev: CardEvent): CardMeta {
  const meta = { ...m }
  if (ev.status) {
    if (ev.status !== meta.status) meta.statusSince = Date.now()
    meta.status = ev.status
  }
  if (ev.detail) meta.detail = ev.detail
  if (ev.taskLabel) meta.task = ev.taskLabel
  if (ev.clearTask) meta.task = undefined
  if (ev.summary) meta.summary = ev.summary
  if (ev.model) meta.model = ev.model
  if (ev.permissionMode) meta.permissionMode = ev.permissionMode
  if (ev.resetSubagents) meta.subagents = 0
  if (ev.subagentDelta) {
    meta.subagents = Math.max(0, (meta.subagents ?? 0) + ev.subagentDelta)
  }
  // The plan: `replace` swaps the whole checklist (update_plan), `clear` drops
  // it at a session boundary.
  if (ev.todoChange) meta.todos = ev.todoChange.kind === 'replace' ? ev.todoChange.todos : undefined
  return meta
}
