# canvas (renderer)

The canvas is the renderer's master-stack workspace: a fixed-viewport layer of
agent/shell/browser cards organized into **projects** (named canvases, each
pinned to a folder). One project shows at a time; its focused card runs large as the master
while the rest sit as compact poster cards in a scrollable right column. Diffs
open as a right-edge side sheet. Layout is fully derived (never persisted) — only
the card registry, the projects that order them, and which is active are saved.
`Canvas.tsx` is the orchestrating component; almost all state lives in the `use*`
hooks it composes, and IPC goes through `window.canvas.*`.

## Components

- **Canvas.tsx** — the composition root. Owns `nodes` (all cards, one flat
  mounted layer) and the small glue — card lifecycle (`makeCard`/`onCloseCard`/
  `promoteCard`/`navigateCard`/`renameCard`), project plumbing (`addCard`/
  `createProject`/`deleteProject`/`switchProject`), and naming/title helpers —
  then wires every hook and renders the layer + sheet + toolbars + toasts. The
  heavy concerns are extracted into focused hooks (layout, browser budget,
  comets, orchestrator bus, below) and UI chunks into their own components; the
  root just holds the seams together and passes state down. `useMemo`s for
  `dormantBrowsers` (from the budget hook's `selectDormant`) and
  `ownedBrowserByAgent` live here since they straddle the partition + node set.
- **CardLayer.tsx** — the one stable layer: maps every card to an absolutely-
  positioned `CardNode`, applying the master/stack rect, the `pendingReveal`
  fade, the deck-enter/leave class during a switch, and the parked-offscreen
  state for inactive canvases (incl. the receding board's `leavingLayout` slots).
  Pure presentation — all geometry/state arrives as props.
- **ActionRail.tsx** — the floating left rail: new agent / terminal / browser
  (disabled with no active canvas) + remote-access entry. New-agent opens a menu
  of installed CLIs via `useAvailableClis(menuOpen)`
  (`src/renderer/src/hooks/use-available-clis.ts` — the reusable renderer
  policy over the `available-clis` probe: mount fetch, re-probe when its
  `refresh` arg changes, never-blank claude fallback; the probe itself is
  main's `spine.availableClis()`), so a CLI installed mid-session appears
  without a relaunch — picking one threads a `CliKind` into
  `onAddCard`/`makeCard`. No per-CLI caveats: every card runs
  unattended by default (the spine's launch flags), whichever CLI backs it.
- **SheetRail.tsx** — the floating **right** rail, mirror of `ActionRail`: the
  toggles for the diff drawer, the vision sheet, the skills gallery, and the issues
  constellation (diff + vision + skills are right-edge sheets; issues is a
  full-viewport takeover). Each button is `active` while its view is open and closes
  it on a second click; they
  live in the `RIGHT_GUTTER` channel so an open sheet stops short of them. Carries
  the distance-to-vision note on the vision tooltip (the old ProjectToolbar crown).
- **RenameDialog.tsx** — the rename-a-card modal (Electron has no
  `window.prompt`); click-away / Esc cancel, Enter / Rename commit.
- **DiffSheet.tsx** — the right-edge diff drawer; keyed by active project id,
  watches `active.dir`. Toggled from `SheetRail` (no edge tab of its own);
  collapse parks it, the caller dropping `activeDir` tears it down.
- **SkillsSheet / SkillsPanel** (`useSkillsPanel` backs them) — the right-edge
  **skills gallery**: a read-only list of the mastermind's learned skills. Global
  like the diff (NOT per-canvas) — the same library on every canvas. Toggled from
  `SheetRail`, wraps `SheetShell` like the diff/vision bodies.
- **VisionSheet / IssueConstellation** (in `src/renderer/src/issues/`, both
  mounted by Canvas) — the two faces of the Mastermind store. `VisionSheet` is the
  calm north-star **right-edge sheet** (shares the diff's width channel);
  `IssueConstellation` is the immersive **full-viewport takeover** (a vision-sun
  with the sprint's issue-DAG orbiting it). Canvas's `rightSheet`
  (`'diff' | 'vision' | 'issues' | 'skills' | null`) makes all mutually exclusive
  (toggled from `SheetRail`). The master reserves sheet width for diff/vision/skills;
  **issues
  reserves none** (`diffCollapsed: rightSheet === null || === 'issues'`) — the
  takeover overlays the whole canvas. See `src/renderer/src/issues/CLAUDE.md`.
- **CardContextMenu.tsx** — right-click-a-card menu: Rename / Close card.
  Dismisses on click-away or Esc.
- **ProjectToolbar.tsx** — top canvas switcher: a dropdown naming the active
  canvas with per-row attention dot, git identity, inline rename, delete, and a
  "+" to create. Right-clicking a canvas opens a folder menu (reveal/editor/copy).
- **VideoBackdrop.tsx** — full-bleed looping video wall behind the canvas;
  swaps dark/light clip on the `<html>` theme class and pauses when hidden.

## Layout / state

- **layout.ts** — pure master-stack geometry (no pan/zoom). Constants
  (`TOP_STRIP`, `PAD`, `LEFT_GUTTER`, `RIGHT_GUTTER`, stack fraction/min/max,
  card height, gap) plus `masterRect`, `stackSlot`, `stackWidth`,
  `stackContentHeight`. Every rect derives from these + window size + which card
  is master. `LEFT_GUTTER`/`RIGHT_GUTTER` are the symmetric channels the two
  floating rails sit in; the master and stack column stop at those insets.
- **nodes.ts** — the `CanvasNode` type: a single `{ id, type: 'card', data }`
  shape (shells are cards with `data.kind === 'shell'`, browsers with
  `'browser'`). The diff is NOT a node.

## Hooks

**Asks / questions** — `useHeldAsks` is the shared lifecycle (append on arrival,
release a card's holds on forward progress / session end, drop a toast
when decided remotely); `usePendingAsks` wraps it for permission gates
(allow/deny/release — dormant now that agent cards run headless and
unattended, kept wired rather than ripped out), `usePendingQuestions` for
AskUserQuestion choosers (answer-with-options / decline — the live flow, via
the canvas MCP `ask_user`). The two stay deliberately separate flows.
"Session end" release covers both kinds: `onSessionEnded` for agent cards,
`onPtyExit` for shells.

**Projects / workspace** — `useProjects` owns the project list + active id +
master focus and all mutations (attach/detach/promote/switch/create/delete/
rename/restore); cards are global and never move between canvases. Every
active-canvas change funnels through one private `setActive`, which snaps the
layout (`animate` gate) and arms `switching` — the `{ leaving, entering }`
deck-restack window (auto-cleared after `DECK_MS`, null from/to the empty state).
`useWorkspace` is restore-once + 300ms-debounced persist; drops ghost cards no
project references and stamps the session id back onto reattached agent cards.

**Card meta** — `useCardMeta` is the renderer end of the spine: folds card
events into each card's `meta` on the nodes, and stamps the session id into
meta on first sighting (persisted by `useWorkspace` — now a CLI session/thread
id rather than a tmux name, since a relaunched agent's first send resumes it).
Also folds `onPtyExit` (shell cards) and `onSessionEnded` (agent cards — the
headless-session analogue: the turn loop exited, the process died, or was
killed) into an idle status. The checklist rides in live via `update_plan`'s
`todoChange` events — it is not re-read from disk. Owns no state itself. An
agent's live transcript (`TranscriptItem`s) is a SEPARATE feed `TranscriptView`
owns directly — it does not flow through this hook or `CardMeta`.

**Git** — `useCanvasGit` polls each canvas's repo (~3s, deduped by dir) for
branch + dirty count, keyed by project id, for the toolbar — decoupled from the
diff drawer so every canvas shows identity, not just the active one.

**Activity** — `useActivityFeed` keeps an in-memory, capped, newest-first log of
feed-worthy status transitions (its own last-status shadow avoids racing meta),
feeding the bell popover; loud rows arrive unread.

**Attention** — `useProjectAttention` derives a per-project level
(`blocking` > `done` > `none`) from card meta + held asks/questions;
`attentionElsewhere` rolls up the loudest non-active canvas for the toolbar pill.

**Shell titles** — `useShellTitles` polls each shell card (~1.5s) via the single
`window.canvas.shellTitle(id)` call (a ps-walk of the direct pty's own pid in
main — there's no tmux pane to query anymore) for its foreground command + cwd
so the remote rows track the directory like the desktop; only shells are
polled (agents speak via status/task). `ShellTitle` now lives in
`@shared/types`, re-exported here for the existing importers.

**Remote** — `useRemotePublish` projects the whole renderer state (canvases,
cards, approvals, questions, feed, needs-you) to the phone panel, grouped by
project id, behind a JSON content-compare so position-only churn doesn't hit IPC.
Each published card row carries its `cli` (`CliKind`) alongside `kind`/`role` so
the phone can label which CLI backs an agent card.
Each published canvas carries an `active` flag (`p.id === activeProjectId`) so
the phone knows which project is foregrounded on the desktop; `activeProjectId`
is in the content-compare deps, so a switch alone republishes. A browser row
reads as its live page (title, else `hostOf(url)`) and ships its current `url`
(so the orchestrator can answer "what page are we on") plus its `ownerId` +
`reason` — main's agent MCP resolves "my browser" from the owner link.

**Auto-update** — `useAutoUpdate` mirrors electron-updater status from main
(events merge so the captured version survives version-less progress ticks);
only fires in packaged builds.

**Layout** — `useMasterStackLayout` derives all master-stack geometry: a
memoized partition (`stackCards`/`stackIndex`/`hasStack`/`mRect`/`scroll` stay
internal — inputs to rectFor/onStackWheel, not returned), exposing
`cardNodes`/`masterCard`/`orderedActive`, every card's `rectFor` (O(1) via the
stack index), the receding board's frozen `leavingLayout` during a switch, the
stack-column `onStackWheel`, and `sheetW`.
Owns the `scrollRef`/`leaveScrollRef` pair and exposes `beginLeave()` (snapshot
the leaving scroll, called by `switchProject` before `setStackScroll(0)`) and
`rectForRef` (live rects for the comet launcher). Exports `PARKED`.

**Browser budget** — `useBrowserBudget` owns the app-wide webview eviction: the
recency map + monotonic `bumpBrowser` (promote/spawn/wake), the kind-aware
`isBrowserCard` (session-less close path), the per-browser `scanPulse` (+ the
`onBrowserWake`/`onBrowserScan` IPC subscriptions), and `selectDormant(cardNodes,
masterId)` — ranks every browser (master always wins) and returns the set past
`BROWSER_BUDGET` (6). Reads live nodes via the passed `nodesRef`.

**Comets** — `useComets` owns the action comets fired chat-bar→card: holds the
`CometSpec` list, subscribes once to `onOrchestratorTarget` (via a live ref),
resolves a target (`cardId`, or an `askId` → the asking card) to a visible rect
through `rectForRef`, retries briefly while a fresh card lays out, and reveals a
spawned card when its comet lands. Owns `CHAT_BAR_INSET`.

**Orchestrator** — `useOrchestratorCommands` is the renderer end of the command
bus: subscribes once to `onOrchestratorCommand` (live ref), runs each mutation
(focus/spawn-agent/spawn-browser/navigate/read/screenshot/act/set-reason/rename/
kill) against live project state and replies by id via `orchestratorResult`
(spawn-agent's payload carries an optional `cli`, threaded into `makeCard`
alongside `role`), and
owns the pending gate (`orchConfirm` + `resolveConfirm`) surfaced in the chat
bar. The gate copy arrives **pre-described from main** (`manager.describeGate`,
which owns the tool vocabulary) — the renderer just displays `{ title, detail }`.
The browser-drive handlers don't re-check `kind` (mainBus.requireBrowser guards
that before dispatch); they only confirm the card still exists in the live node
set. All canvas-mutating verbs are passed in as callbacks; the hook orchestrates.

## Architecture / data flow

- **One flat layer.** Every card across every project stays mounted (the
  `CardNode` frame, that is — an agent's live transcript itself only mounts
  while it's the unstacked master; see `cards/CLAUDE.md`). Switching projects
  or promoting only flips visibility (`visibility:hidden`) and the
  `transform`/size — so a shell's xterm/scrollback and a browser's webview
  survive switches. Inactive cards park off-screen at `PARKED` but stay sized
  so FitAddon stays valid.
- **Deck-restack switch.** A canvas switch cross-fades like swapping cards in a
  deck: the rising board fades up/forward (`deck-enter`), the receding one sinks
  back/fades (`deck-leave`) — driven by classes in `index.css`, gated by
  `proj.switching`. Cards never leave the flat layer (xterm survives); the
  receding board's cards just keep rendering at `leavingLayout`'s slots until the
  window clears. The deck scale uses the standalone CSS `scale` property (not
  `transform`) so it composes with each card's snapped `translate()` position.
- **Master-stack focus.** The active project's `focusedCardId` is the master;
  the rest are the stack, ordered by `cardIds`. Promotion demotes the old master
  to the top of the stack. The partition is memoized; `rectFor` does O(1)
  lookups via a `stackIndex` map.
- **Hooks feed cards via the spine.** `window.canvas.onCardEvent` is broadcast —
  `useCardMeta`, `useActivityFeed`, and `useHeldAsks` each subscribe
  independently. Meta lives on the nodes; the other hooks keep their own shadows.
- **Orchestrator IPC.** Main dispatches `OrchestratorCommand`s
  (spawn/rename/kill/focus/confirm + the browser set) over
  `onOrchestratorCommand`; Canvas runs them against live project state and
  replies by id via `orchestratorResult`. A ref holds the latest closure so the
  listener subscribes once. `onOrchestratorTarget` fires a comet from the
  chat bar to the acted-on card. `spawnBrowser` rides the same reveal dance as
  `spawnAgent` (and stamps the node's `ownerCardId`/`reason`); `navigateBrowser`
  bumps the node's `goto` nonce (the nav request the webview watches) and
  promotes the card so the navigation is visible.
- **Browser see-and-control.** `readBrowser`/`screenshotBrowser`/`actBrowser`
  reach the card's live page via the per-card `BrowserHandle` from
  `cards/browserBridge` (`getBrowser(cardId)`, registered by the webview) rather
  than threading refs through nodes — reply with the page `snapshot` / PNG
  `image`, or act's ok/message. Reads and screenshots are **silent** (no
  promote); an act mutates the page so it promotes the card. `setBrowserReason`
  edits the stated provenance shown on the poster. All four no-op with an error
  reply if the card isn't a browser or its guest isn't mounted yet.
- **Browser cards.** A third kind: an in-DOM webview, no pty/spine session at all.
  The master runs a live web view (address bar + back/fwd/reload), stacked cards
  show a blur snapshot. The webview reports navigation/title/favicon/snapshot
  back through `onNavigate`, which folds the patch into the node so chrome, face,
  and persistence track it. Close is **session-less**: `onCloseCard` and
  `deleteProject` skip `killCard` for `browser-`-prefixed ids (no session to
  kill, and killing logs a missing-session error). Only `url`, `ownerCardId`,
  and `reason` persist (reload-on-restore); live title/favicon/snapshot are
  deliberately transient.
- **Browser lifecycle coupling.** A browser an agent requested carries its
  owner's id (`ownerCardId`, set on `spawnBrowser`, rehydrated by `restoreItem`
  and persisted by `useWorkspace` so `request_browser` stays idempotent across
  restart). `onCloseCard` takes those owned browsers along when the owner closes
  — no orphan windows. Provenance also surfaces in the UI: a browser passes its
  owner's `ownerName` (window-bar chip) + `onFlyToOwner` (promote the owner),
  and an agent poster shows `browserThumb` (its owned browser's snapshot), both
  from an `ownedBrowserByAgent` map (first owner wins).
- **Webview budget / eviction.** Webview guests are costly (GL/process, shared
  with terminals under Chromium's ~16-context ceiling), so only `BROWSER_BUDGET`
  (6) stay live; the rest go **dormant** (guest dropped, snapshot face shown),
  passed as `dormant` to each CardNode. The set is app-wide (every browser holds
  resources regardless of which canvas parks it) and recency-ranked: a monotonic
  `bumpBrowser` counter ranks each browser on promote/spawn/wake, the active
  master always wins, and the lowest-ranked past the budget evict. `onBrowserWake`
  (main asks to revive a dormant browser to drive it) just bumps it back live.
- **Diff sheet** is not a node — a built-in overlay keyed by active project id,
  watching `active.dir`, re-pointing on canvas switch; collapse parks it, close
  tears it down.

## Conventions & gotchas

- **Ref-for-stable-subscription** is pervasive: hooks/effects that subscribe once
  read live state through a `*Ref` (`nodesRef`, `orchCommandRef`, `titleForRef`,
  `rectForRef`, `itemsRef`) rather than re-subscribing per render. Keep bridge
  fns passed to `useHeldAsks` stable.
- **Dismiss-on-outside-click/Esc** is factored into the shared
  `useDismiss` hook (`src/renderer/src/hooks/use-dismiss.ts`) — `ActionRail`'s
  CLI menu, `CardContextMenu`, and `ProjectToolbar`'s `FolderMenu` all bound a
  ref to it instead of each hand-rolling the listener pair; it takes an
  `active` gate for menus that stay mounted while closed.
- **Layout is never persisted** — only `{ cards, projects, activeProjectId }`.
  Status is never persisted either, so a glyph can't lie after relaunch
  (reattach-not-resume). A browser card persists its last `url` (re-loaded on
  restore); its title/favicon/snapshot are not.
- **`useWorkspace` ordering:** `setNodes` must run BEFORE `onRestore` — React 18
  doesn't batch async-callback updates, so a project must not reference a
  not-yet-mounted card.
- **Electron has no `window.prompt`** — renames render a custom input
  (Canvas's rename dialog, the toolbar's inline edit).
- **Spawn reveal:** orchestrator-spawned cards are held invisible
  (`pendingReveal`) until the delivering comet lands; a safety timer
  (`COMET_TRAVEL_MS + 1500`) reveals them if the comet never fires.
- **Initial prompt before mount:** spawn queues `setInitialPrompt` BEFORE the
  card mounts so the agent starts working with no keystroke race.
- **CHAT_BAR_INSET (44)** must track the chat-bar pill's overlay inset/half-height
  — it's the comet launch origin. **PARKED.x ≈ -100000**; `rectFor` treats
  `x <= -10000` as "not laid out".
- There's no terminal-engage release path anymore (agent cards have no terminal
  to fall through to) — a held ask/question clears only on forward progress,
  the card's session ending, or an explicit orbit decision.
- **Deck transition timing:** `DECK_MS` (in `useProjects`) must outlast the
  300ms CSS animation so the `deck-enter`/`deck-leave` classes don't drop before
  the keyframes finish. The receding stack is frozen at the pre-switch scroll via
  `leaveScrollRef` (snapshotted the instant before `setStackScroll(0)`).
