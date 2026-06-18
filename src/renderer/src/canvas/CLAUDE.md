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

- **Canvas.tsx** — the root. Owns `nodes` (all cards, one flat mounted layer),
  wires every hook, computes the master/stack partition + rects, renders cards +
  diff sheet + toolbars + toasts, and handles orchestrator commands/tracers.
  During a canvas switch it also derives a transient `leavingLayout` (the
  receding board's slots) so the deck cross-fade can fade the old board out from
  where it sat.
- **CardContextMenu.tsx** — right-click-a-card menu: Rename / Close card.
  Dismisses on click-away or Esc.
- **ProjectToolbar.tsx** — top canvas switcher: a dropdown naming the active
  canvas with per-row attention dot, git identity, inline rename, delete, and a
  "+" to create. Right-clicking a canvas opens a folder menu (reveal/editor/copy).
- **VideoBackdrop.tsx** — full-bleed looping video wall behind the canvas;
  swaps dark/light clip on the `<html>` theme class and pauses when hidden.

## Layout / state

- **layout.ts** — pure master-stack geometry (no pan/zoom). Constants
  (`TOP_STRIP`, `PAD`, `LEFT_GUTTER`, stack fraction/min/max, card height, gap)
  plus `masterRect`, `stackSlot`, `stackWidth`, `stackContentHeight`. Every rect
  derives from these + window size + which card is master.
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
A browser row reads as its live page (title, else `hostOf(url)`) and ships its
current `url` so the orchestrator can answer "what page are we on".

**Auto-update** — `useAutoUpdate` mirrors electron-updater status from main
(events merge so the captured version survives version-less progress ticks);
only fires in packaged builds.

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
  (spawn/rename/kill/focus/confirm + spawnBrowser/navigateBrowser) over
  `onOrchestratorCommand`; Canvas runs them against live project state and
  replies by id via `orchestratorResult`. A ref holds the latest closure so the
  listener subscribes once. `onOrchestratorTarget` fires a tracer comet from the
  chat bar to the acted-on card. `spawnBrowser` rides the same reveal dance as
  `spawnAgent`; `navigateBrowser` bumps the node's `goto` nonce (the nav request
  the webview watches) and promotes the card so the navigation is visible.
- **Browser cards.** A third kind: an in-DOM webview, no tmux/pty/spine session.
  The master runs a live web view (address bar + back/fwd/reload), stacked cards
  show a blur snapshot. The webview reports navigation/title/favicon/snapshot
  back through `onNavigate`, which folds the patch into the node so chrome, face,
  and persistence track it. Close is **session-less**: `onCloseCard` and
  `deleteProject` skip `killCard` for `browser-`-prefixed ids (no session to
  kill, and killing logs a missing-session error). Only the last `url` persists
  (reload-on-restore); live title/favicon/snapshot are deliberately transient.
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
