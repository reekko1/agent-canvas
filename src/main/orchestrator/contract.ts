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
  AgentRole,
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

/** Normalized inputs for the `[Open canvas]` snapshot — each bus projects its own
 *  state (live RemoteState vs the stub World) into this shape, and the shared
 *  formatter below renders the one text format both inject each turn. */
export interface OpenCanvasView {
  name: string
  id: string
  branch?: string
  dirty?: number
  cards: {
    name: string
    id: string
    kind: CardKind
    status: CardStatus
    task?: string
    url?: string
    running?: string
  }[]
  asks: { name: string; detail: string; id: string }[]
  others: { name: string; id: string; attention: AttentionLevel }[]
}

/** Render the per-turn open-canvas snapshot. The single owner of the format so the
 *  live bus and the offline stub can't drift (a drift would weaken the harness as
 *  a wiring check). Field-source differences stay in each bus's projection. */
export function renderOpenCanvas(v: OpenCanvasView): string {
  const cardLines = v.cards.map((c) => {
    const bits = [`${c.name} (${c.id}) — ${c.kind}/${c.status}`]
    if (c.task) bits.push(`task: ${c.task}`)
    if (c.kind === 'browser' && c.url) bits.push(`at ${c.url}`)
    if (c.kind === 'shell' && c.running) bits.push(`running ${c.running}`)
    return '  - ' + bits.join(' · ')
  })
  const others = v.others.map(
    (c) => `${c.name} (${c.id})${c.attention !== 'none' ? ` [${c.attention}]` : ''}`,
  )
  return [
    `[Open canvas] ${v.name} (${v.id})` +
      (v.branch ? ` · ${v.branch}${v.dirty ? ` +${v.dirty}` : ''}` : ''),
    v.cards.length ? `cards:\n${cardLines.join('\n')}` : 'cards: none',
    v.asks.length
      ? `blocked: ${v.asks.map((a) => `${a.name} — ${a.detail} (${a.id})`).join('; ')}`
      : '',
    others.length ? `other canvases (list_world for their cards): ${others.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
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
  /** The Mastermind role to hire this card as (planner/lead/worker). */
  role?: AgentRole
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
  /** The open-canvas snapshot PLUS what the mastermind knows about Rakan (operator
   *  memory) and a terse cross-canvas "your whole world" view — the full context block
   *  the standing conversation gets injected each turn. Superset of openCanvas(); the
   *  reactor still uses the leaner openCanvas() for its board snapshot. */
  worldContext(): Promise<string>
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
  /** Perform an action (click/type/scroll/select/history) on a browser card's
   *  page, keyed on an element `ref` from the latest readBrowser. */
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
  /** Push a one-line notification to Rakan's phone — the mastermind reaching out when he
   *  may not be looking at the app. The agent's own arm for proactive reach-out. */
  notifyUser(message: string): Promise<ActionResult>
  /** Author, refine, patch, delete (→archive), or attach supporting files to one of the
   *  mastermind's own skills. Bodies are written inline by the orchestrator; create/edit/patch/
   *  delete recycle the session so the change loads. The agent's own arm for self-authored
   *  procedures. */
  manageSkill(input: ManageSkillInput): Promise<ActionResult>
  /** One of the mastermind's learned skills by name (its full current body), so the
   *  orchestrator can SEE the real text before refining it with manageSkill — a patch edits
   *  the real body rather than reconstructing it from memory. null if no such skill. The
   *  model already knows skill names + descriptions (the loader surfaces them); it only
   *  needs the body, fetched one at a time. */
  readSkill(name: string): Promise<SkillBrief | null>
}

export interface SkillBrief {
  name: string
  description: string
  body: string
}

export interface ManageSkillInput {
  /** The operation. create/edit write the whole body; patch is a surgical string edit;
   *  delete archives; write_file/remove_file manage supporting files under the skill dir. */
  action: 'create' | 'edit' | 'patch' | 'delete' | 'write_file' | 'remove_file'
  /** Short kebab-case id, e.g. "handling-stalled-sprints". */
  name: string
  /** create/edit: one line — what the skill is for and when to reach for it. */
  description?: string
  /** create/edit: the skill's instructions in Markdown — when it applies and the steps. */
  body?: string
  /** patch: the exact text to find in the current body. */
  oldString?: string
  /** patch: what to replace it with (empty string deletes the matched text). */
  newString?: string
  /** patch: replace every occurrence instead of requiring a unique match. */
  replaceAll?: boolean
  /** write_file/remove_file: path under the skill dir, e.g. "scripts/run.sh"
   *  (must start with references/, templates/, scripts/, or assets/). */
  filePath?: string
  /** write_file: the file's contents. */
  fileContent?: string
}
