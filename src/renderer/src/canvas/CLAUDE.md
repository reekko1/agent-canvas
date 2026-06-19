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
  tracers, orchestrator bus, below) and UI chunks into their own components; the
  root just holds the seams together and passes state down. `useMemo`s for
  `dormantBrowsers` (from the budget hook's `selectDormant`) and
  `ownedBrowserByAgent` live here since they straddle the partition + node set.
- **CardLayer.tsx** — the one stable layer: maps every card to an absolutely-
  positioned `CardNode`, applying the master/stack rect, the `pendingReveal`
  fade, the deck-enter/leave class during a switch, and the parked-offscreen
  state for inactive canvases (incl. the receding board's `leavingLayout` slots).
  Pure presentation — all geometry/state arrives as props.
- **ActionRail.tsx** — the floating left rail: new agent / terminal / browser
  (disabled with no active canvas) + remote-access entry.
- **SheetRail.tsx** — the floating **right** rail, mirror of `ActionRail`: the
  toggles for the three right-edge sheets (diff + vision board + issue board). Each
  button is `active` while its sheet is open and collapses it on a second click;
  they live in the `RIGHT_GUTTER` channel so an open sheet stops short of them.
  Carries the distance-to-vision note on the vision tooltip (the old ProjectToolbar
  crown).
- **RenameDialog.tsx** — the rename-a-card modal (Electron has no
  `window.prompt`); click-away / Esc cancel, Enter / Rename commit.
- **DiffSheet.tsx** — the right-edge diff drawer; keyed by active project id,
  watches `active.dir`. Toggled from `SheetRail` (no edge tab of its own);
  collapse parks it, the caller dropping `activeDir` tears it down.
- **VisionSheet / IssueSheet** (in `src/renderer/src/issues/`, both mounted by
  Canvas) — the two Mastermind right-edge sheets (the north-star vision board and
  the sprint → plan → issue board), sharing the diff's width channel. Canvas's
  `rightSheet` (`'diff' | 'vision' | 'issues' | null`) makes all three mutually
  exclusive (toggled from `SheetRail`); the master reserves the sheet width when
  any is open. See `src/renderer/src/issues/CLAUDE.md`.
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
release a card's holds on forward progress / pty exit / engagement, drop a toast
when decided remotely); `usePendingAsks` wraps it for permission gates
(allow/deny/release), `usePendingQuestions` for AskUserQuestion choosers
(answer-with-options / decline). The two stay deliberately separate flows.

**Projects / workspace** — `useProjects` owns the project list + active id +
master focus and all mutations (attach/detach/promote/switch/create/delete/
rename/restore); cards are global and never move between canvases. Every
active-canvas change funnels through one private `setActive`, which snaps the
layout (`animate` gate) and arms `switching` — the `{ leaving, entering }`
deck-restack window (auto-cleared after `DECK_MS`, null from/to the empty state).
`useWorkspace` is restore-once + 300ms-debounced persist; drops ghost cards no
project references and re-hydrates plans for reattached agent sessions.

**Card meta** — `useCardMeta` is the renderer end of the spine: folds card
events / pty exits into each card's `meta` on the nodes, and re-hydrates todos
from the CLI task store on first sighting of a session. Owns no state itself.

**Git** — `useCanvasGit` polls each canvas's repo (~3s, deduped by dir) for
branch + dirty count, keyed by project id, for the toolbar — decoupled from the
diff drawer so every canvas shows identity, not just the active one.

**Activity** — `useActivityFeed` keeps an in-memory, capped, newest-first log of
feed-worthy status transitions (its own last-status shadow avoids racing meta),
feeding the bell popover; loud rows arrive unread.

**Attention** — `useProjectAttention` derives a per-project level
(`blocking` > `done` > `none`) from card meta + held asks/questions;
`attentionElsewhere` rolls up the loudest non-active canvas for the toolbar pill.

**Shell titles** — `useShellTitles` polls each shell pane (~1.5s) for its
foreground command + cwd so the remote rows track the directory like the desktop;
only shells are polled (agents speak via status/task).

**Remote** — `useRemotePublish` projects the whole renderer state (canvases,
cards, approvals, questions, feed, needs-you) to the phone panel, grouped by
project id, behind a JSON content-compare so position-only churn doesn't hit IPC.
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
`rectForRef` (live rects for the tracer launcher). Exports `PARKED`.

**Browser budget** — `useBrowserBudget` owns the app-wide webview eviction: the
recency map + monotonic `bumpBrowser` (promote/spawn/wake), the kind-aware
`isBrowserCard` (session-less close path), the per-browser `scanPulse` (+ the
`onBrowserWake`/`onBrowserScan` IPC subscriptions), and `selectDormant(cardNodes,
masterId)` — ranks every browser (master always wins) and returns the set past
`BROWSER_BUDGET` (6). Reads live nodes via the passed `nodesRef`.

**Tracers** — `useTracers` owns the action comets fired chat-bar→card: holds the
`TracerSpec` list, subscribes once to `onOrchestratorTarget` (via a live ref),
resolves a target (`cardId`, or an `askId` → the asking card) to a visible rect
through `rectForRef`, retries briefly while a fresh card lays out, and reveals a
spawned card when its comet lands. Owns `CHAT_BAR_INSET`.

**Orchestrator** — `useOrchestratorCommands` is the renderer end of the command
bus: subscribes once to `onOrchestratorCommand` (live ref), runs each mutation
(focus/spawn-agent/spawn-browser/navigate/read/screenshot/act/set-reason/rename/
kill) against live project state and replies by id via `orchestratorResult`, and
owns the pending gate (`orchConfirm` + `resolveConfirm`) surfaced in the chat
bar. The gate copy arrives **pre-described from main** (`manager.describeGate`,
which owns the tool vocabulary) — the renderer just displays `{ title, detail }`.
The browser-drive handlers don't re-check `kind` (mainBus.requireBrowser guards
that before dispatch); they only confirm the card still exists in the live node
set. All canvas-mutating verbs are passed in as callbacks; the hook orchestrates.

## Architecture / data flow

- **One flat layer.** Every card across every project stays mounted. Switching
  projects or promoting only flips visibility (`visibility:hidden`) and the
  `transform`/size — so a card's xterm and scrollback survive switches. Inactive
  cards park off-screen at `PARKED` but stay sized so FitAddon stays valid.
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
  listener subscribes once. `onOrchestratorTarget` fires a tracer comet from the
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
- **Browser cards.** A third kind: an in-DOM webview, no tmux/pty/spine session.
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
  (`TRACER_TRAVEL_MS + 1500`) reveals them if the tracer never fires.
- **Initial prompt before mount:** spawn queues `setInitialPrompt` BEFORE the
  card mounts so the agent starts working with no keystroke race.
- **CHAT_BAR_INSET (44)** must track the chat-bar pill's overlay inset/half-height
  — it's the comet launch origin. **PARKED.x ≈ -100000**; `rectFor` treats
  `x <= -10000` as "not laid out".
- Engaging a card's terminal releases both its held asks and questions (they fall
  through to the CLI's own dialogs).
- **Deck transition timing:** `DECK_MS` (in `useProjects`) must outlast the
  300ms CSS animation so the `deck-enter`/`deck-leave` classes don't drop before
  the keyframes finish. The receding stack is frozen at the pre-switch scroll via
  `leaveScrollRef` (snapshotted the instant before `setStackScroll(0)`).
