# Agent-Canvas Refactor — Phased Implementation Plan

> Generated from a multi-agent design+critique pass. Locked decisions: fixed viewport
> (no pan/zoom), master+stack tiling, top-toolbar project selector, context-menu card
> moves, staged ReactFlow removal. See "Resolved-by-default UX" for the smaller calls.

## Goal & end-state

Agent-canvas becomes a **fixed-viewport, master-stack tiling supervisor for multiple projects**. The infinite pan/zoom ReactFlow canvas is gone: one focused card renders large (the "master", a live terminal) while the rest sit as compact PosterFace summaries in a scrollable stack column beside it. A top toolbar switches between projects (each its own canvas of cards) and creates new ones; the left toolbar (spawn card/diff/shell) stays. Cards remain **global live tmux sessions** — projects only own *which cards they lay out*, so moving a card between projects or deleting a project never touches a pty.

## What gets deleted

| Thing | Files / symbols | Rough LOC |
|---|---|---|
| **Frames feature** (concept removed entirely) | `frames/FrameNode.tsx`, `frames/FrameChips.tsx`, `frames/FrameDrawOverlay.tsx`, `frames/geometry.ts` (move `nodeRect` out first), `FrameData` from `nodes.ts`, `makeFrame`/`finishFrameDraw`/`highlightFrames`/`renameFrame`/`deleteFrame`/`drawingFrame` in Canvas.tsx, "New frame" toolbar button, `kind:'frame'`/`title` in types | ~330 deleted |
| **Zoom/camera stack** | `useZoomLimits.ts` (whole file), `MAX_ZOOM`/`MAX_ZOOM_IN` (layout.ts), `minZoom`/`maxZoom`/`panOnScroll`/`zoomOnPinch` props, `flyTo`/`fitBounds`/`fitView` calls, `WorkspaceViewport` type, viewport persist/restore | ~150 deleted |
| **@xyflow/react** (Phase B) | dependency, `ReactFlow`/`ReactFlowProvider`/`useReactFlow`/`useStore`/`useNodesState`/`NodeProps`/`NodeResizeControl`/`useViewport`, `@xyflow/react/dist/style.css` | dep + ~80 deleted |
| **Zoom-LOD poster path** (the *mechanism*, not the component) | `posterCompensation`/`POSTER_ZOOM`/`SCALE_STEP` math in PosterFace.tsx, `useStore` compensation in CardNode.tsx | ~40 deleted |

**PosterFace.tsx is KEPT** — it becomes the compact stacked-card face. We strip only its zoom-compensation math and render it at scale 1.

Net: roughly **−700 LOC / +250 LOC** (layout engine, project model, toolbar, card registry), one major dependency removed.

## Data model & migration

The single hardest lesson from the critique: **a project that stores only `cardIds` loses each card's `folder`/`kind`/`session`, and `restoreItem` drops any card without a folder → cards vanish on restart.** So we split persistence into two independent concerns:

```ts
// src/shared/types.ts

/** Global, layout-independent record of every card that exists. Survives
 *  project moves untouched (tmux is global). THIS is what restoreItem needs. */
export interface CardRecord {
  id: string
  folder: string
  kind: 'agent' | 'shell'     // diffs are NOT cards — they're a transient side sheet
  session?: string            // for todo rehydration (was WorkspaceItem.session)
}

/** One project's canvas. References cards by id only; never owns their data. */
export interface Project {
  id: string
  name: string
  cardIds: string[]           // order = stack order (top of column first)
  focusedCardId?: string      // the master; must be in cardIds (persisted)
}

/** The whole persisted file. Replaces WorkspaceSnapshot. */
export interface MultiProjectSnapshot {
  cards: CardRecord[]         // global registry — the card data lives HERE
  projects: Project[]
  activeProjectId: string
}
```

`WorkspaceItem`/`WorkspaceViewport`/`WorkspaceSnapshot` are deleted. No `x/y/w/h` anywhere — layout is deterministic from `[cardIds order, focusedCardId, window size]`.

**Migration** (in `WorkspaceStore`, called at load):
- `WorkspaceStore.load()` (workspace.ts:17) **must be widened** — today it returns `null` unless `Array.isArray(ws.items)`. New guard: accept either old (`items`) or new (`cards`) shape; otherwise `null`. *(Without this fix the new format loads blank on second launch.)*
- Old → new: drop `kind:'frame'` rows; for every item with a `folder`, emit a `CardRecord {id, folder, kind, session}`; build one `Project { id:'proj-default', name:'Default', cardIds:[…in file order], focusedCardId: cardIds[0] }`; `activeProjectId:'proj-default'`. Frame *grouping* is unrecoverable (membership was only geometric) — every migrated card lands in Default.
- **Guards on load:** if `activeProjectId ∉ projects`, fall back to `projects[0].id`; ensure a durable, **undeletable `proj-default`** always exists.

## Phased implementation

Ordered to **never leave a broken intermediate** — persistence and terminal-lifecycle are hardened *before* multi-project or the ReactFlow rip-out. The staged ReactFlow removal is real but **late** (Phases 5–6): master-stack rides ReactFlow first only to de-risk the terminal lifecycle; that layout code is a throwaway harness.

### Phase 0 — Persistence split + global card registry ✅ DONE *(foundation, behavior-preserving)*
**Delivered:** New `MultiProjectSnapshot`/`CardRecord`/`Project` types; widened `WorkspaceStore.load()` with legacy→new migration (+ one-time `.legacy.bak`) and a `normalize()` guard; renderer persists/restores via the registry + a single active project. Still on ReactFlow, single project visually.
> **Refinement vs. original plan:** project state lives in the **renderer** (like `nodes` today); the main process stays a dumb opaque store. So the 7 project-CRUD IPC handlers are **deferred to Phase 4** (when the toolbar actually uses them) rather than landing as dead, untested code now. Frames and diffs are dropped from persistence here (both are being removed/relocated); positions + viewport are carried as clearly-marked **transitional** fields so the canvas looks/behaves identically until Phases 2–3 replace them.
- `src/shared/types.ts` — added `CardRecord`/`Project`/`MultiProjectSnapshot` + `DEFAULT_PROJECT_ID/NAME`; `WorkspaceItem`/`WorkspaceSnapshot` kept (migrator-only); `CanvasApi.load/saveWorkspace` retyped.
- `src/main/workspace.ts` — `load()` accepts `cards` OR legacy `items`→`migrate()`→`normalize()`; legacy backup; complete-snapshot writes.
- `src/main/index.ts` — `save-workspace` retyped to `MultiProjectSnapshot` (load handler unchanged — migration is inside `load()`).
- `src/renderer/src/canvas/useWorkspace.ts` — restore reads `ws.cards`; persist writes `{cards, [singleProject], activeProjectId, viewport}`.
- `src/renderer/src/canvas/Canvas.tsx` — `restoreItem(card: CardRecord)` (cards only).
- **Verified:** `tsc --noEmit` clean; full `electron-vite build` green; 15/15 pure migration tests (upgrade/passthrough/corrupt/empty). **Live gate still owed:** launch the app on a real old `workspace.json`, confirm cards reappear and survive two relaunches; inspect the file shows `{cards, projects, activeProjectId}` + a `.legacy.bak` beside it.

### Phase 1 — Terminal-lifecycle hardening ✅ DONE (resize-storm fix)
**Delivered:** `TerminalView` `ResizeObserver` now trailing-debounces the FitAddon fit (100ms), so a continuous resize / future tiling animation collapses to ONE fit-on-settle instead of ~60 SIGWINCH/s. Mount-time fit stays immediate. Verified `tsc` + build green.
> **Finding:** the rest of Phase 1 was already done by the existing code — `TerminalView` creates xterm once (stable deps) and `hidden` already uses `visibility:hidden` (not `display:none`), so the always-mounted invariant holds. `onPromote` is deferred to the layout gate (don't land unexercised plumbing). The runtime proof of the storm fix folds into the layout gate, where an actual animation exercises it.

#### (original Phase 1 detail, now subsumed)
**Delivers:** The invariant the whole refactor rests on — **no CardNode ever unmounts during a layout change**, so xterm/scrollback survives. Add `onPromote` to `CardData`.
- `src/renderer/src/cards/meta.ts` (CardData) — add `onPromote(id): void`.
- `CardNode.tsx:10,19,54-59` — drop `useStore` compensation; render `<TerminalView hidden={isInStack}/>` **always mounted**, overlay `<PosterFace/>` only when `isInStack`; click poster → `data.onPromote(id)`.
- `PosterFace.tsx` — strip `posterCompensation`/zoom math, render at scale 1.
- `TerminalView.tsx:90` — **fix the resize storm:** replace `new ResizeObserver(() => fit.fit())` with a transition-aware fit (suppress while `data-tiling-animating` is set; single `fit.fit()` on settle).
- **Verify:** in a hand-wired 2-card master/stack, promote back and forth — scrollback intact both ways, **zero** mid-animation resize calls (one on settle).

### Phases 2 + 3 + 5 + 6 — ✅ DONE (collapsed into one gate)
Built the fixed-viewport master-stack directly in CSS and removed ReactFlow in a single step (the throwaway-harness approach was dropped — the terminal lifecycle was already safe and ReactFlow can't do a scrollable stack column). Delivered:
- **Master-stack layout** (`Canvas.tsx` full rewrite, `layout.ts` rewrite): one focused card large (live terminal), the rest as compact `PosterFace` cards in a ~30% scrollable stack column. All card hosts live in **one stable flat layer positioned by `transform`** — never re-parented — so a card keeps its xterm alive across the master↔stack animation. Promote on stack-poster click; new card / opened item becomes master; close-master falls back to the next card. Window-resize re-flows.
- **Fixed viewport / zoom deleted**: no pan/zoom/camera; `useZoomLimits.ts` deleted; `MAX_ZOOM*` removed; `PosterFace` zoom-compensation stripped (renders at scale 1, compact). "Fly to card" (activity/ask/question clicks) now = **promote to master**.
- **ReactFlow removed**: `@xyflow/react` gone from source + `package.json`; `App.tsx` drops `ReactFlowProvider`; `nodes.ts` is a plain union; `useReactFlow`/`useStore`/`NodeResizeControl`/`NodeProps` all gone. Renderer bundle **−370 kB**.
- **Frames deleted**: `frames/` dir removed; `index.css` `.react-flow__*`/`.resize-grip` rules removed. (`use-merge-split`/`use-proximity-hover` kept — used by the AskUserQuestion UI, not frames.)
- **Diffs**: open as a **master-slot overlay** (`openDiff` state, the seed of the 4.5 side sheet); promoting a card closes the diff. Not tiled, not persisted.
- **Verified live:** migrated the real workspace → 2 NarraOS shells laid out as master (live terminal) + stack (poster); `tsc` + build green; clean log; persistence round-trips to `{cards, projects, activeProjectId}`.

#### (original Phase 2 detail, now subsumed) — Master-stack layout engine (computed positions fed to ReactFlow) *(throwaway harness)*
**Delivers:** `useProjectLayout` (focusedCardId + cardOrder, persisted per project) driving a master/stack split. ReactFlow stays but `nodesDraggable={false}`.
- New `src/renderer/src/canvas/useProjectLayout.ts` — `promoteCard`, spawn→master, close-master→promote next.
- `Canvas.tsx:257-270,407-427` — delete `spawnPosition`; feed computed master+stack positions; `nodesDraggable={false}`; drop drag/click/move handlers. **Force `setViewport({x:0,y:0,zoom:1})` on mount** (so `screenToFlowPosition` is identity).
- **Verify:** 1 card fills window; 2nd shrinks master + stacks old; stack overflow scrolls; clicking a stack card promotes it.

### Phase 3 — Fixed-viewport lock + zoom deletion
**Delivers:** Camera is provably gone.
- Delete `useZoomLimits.ts`; remove zoom/pan props; remove `MAX_ZOOM`/`MAX_ZOOM_IN`; delete `flyTo`/`fitBounds`/`fitView` and the camera half of double-click.
- **Verify:** no scroll/pinch moves anything; double-click does not animate; no console errors.

### Phase 4 — Multi-project layer + top toolbar ✅ DONE
**Delivered:** `useProjects.ts` (projects state machine — attach/detach/promote/create/switch/rename/delete-orphan/move/restore, with a one-frame animation gate on switch); `ProjectToolbar.tsx` (top-center dropdown selector + "+" create, per-row rename/delete, Default undeletable); `CardContextMenu.tsx` (right-click → "Move to canvas"/close); `Canvas.tsx` integration — **every card across every project stays mounted in one flat layer**, only the active project's cards are laid out, the rest parked off-screen `visibility:hidden` (xterm never unmounts → scrollback survives switches). `useWorkspace` persists the real `{cards, projects, activeProjectId}`; `useRemotePublish` stays global, tagging each card with `projectName` (panel reads all cards, not the active subset).
> **Verified live:** seeded `Default`[2 shells] + empty `Backend`, launched → toolbar dropdown lists both, active project's master-stack renders with a live terminal, `tsc`+build green, clean log, and the **two-project snapshot round-trips** through load→save. Interactive switch/move/create/delete are typechecked + reasoned (no GUI clicker on the box to drive them); user can confirm live.

#### (original Phase 4 detail) — Multi-project layer + top toolbar
**Delivers:** Project switching, creation, rename, delete-orphan, right-click "Move to canvas", remote panel stays GLOBAL.
- **Critical:** `nodes` holds **all cards across all projects, always mounted**. Project switch flips a visibility flag, it does **not** rebuild `nodes` (rebuilding unmounts terminals → scrollback loss; `display:none` → 0-height FitAddon garbage). Hide inactive via `visibility`, never `display:none`.
- New `ProjectToolbar.tsx` — dropdown + "+" + rename/delete dialogs (top, h-12, z-40); nudge left toolbar to `top-16`.
- New `CardContextMenu.tsx` — right-click → "Move to canvas ▸"; calls `moveCardToProject`.
- `Canvas.tsx` — projects/activeProjectId state; filter *visible* nodes by active project for layout, keep all mounted.
- `useRemotePublish.ts:25` + `titleFor` (Canvas.tsx:183) — **source from the global card registry, not the active subset**; add `projectName` to each remote card.
- **Verify:** create project → blank canvas; switch back and forth → terminals never reload; phone panel shows ALL projects' cards tagged with project name; delete a project → cards appear in Default, tmux alive; relaunch → restored.

### Phase 4.5 — Diff side sheet ✅ DONE
**Delivered:** Diffs open as a right-edge **sliding drawer** (`openDiff` + `diffCollapsed` in `Canvas.tsx`), ~50% width, over the canvas without displacing the master-stack. `DiffNode` gained a collapse button (`onCollapse`); collapsing parks the sheet off-screen but keeps it mounted (watcher + selected file survive) with a vertical `diff` edge-tab to reopen; closing tears it down. The toolbar diff button opens a diff (folder pick) or toggles the sheet if one's open. Diffs no longer touch the master-stack or get auto-closed by promote/switch. Also fixed: stacked **shell** posters now read `SHELL` (neutral), not `IDLE`. `tsc` + build green.
> Verification: localized re-positioning of the already-proven `DiffNode`; opening a diff needs a native folder-picker (not headless-drivable), so confirmed via tsc+build + code. Open a diff in the live app to see the drawer.

#### (original Phase 4.5 detail)
**Delivers:** Diffs become a collapsible drawer instead of a canvas node.
- New `src/renderer/src/diff/DiffSheet.tsx` — a right-side drawer (slide-in/collapse) reusing `diffText.ts` + the git IPC currently in `DiffNode.tsx`. Open via the left-toolbar diff button (and/or per-card action); state is local/session-only.
- Remove `diff` from `nodeTypes`/the node union; delete the diff-as-node spawn path. `DiffNode.tsx` is retired once its render logic moves into the sheet.
- **Verify:** open a diff → drawer slides over the master-stack without displacing tiles; collapse/close; switching projects or promoting cards doesn't disturb it; diff is gone after relaunch (session-only).

### Phase 5 — Phase B: rip out @xyflow/react
**Delivers:** ReactFlow gone; layout is pure CSS flex.
- Replace `<ReactFlow>` with `<div className="flex h-screen w-screen">` → master slot (`flex-1 min-w-0`) + stack column (`overflow-y-auto`, ~30% width via `basis-[30%]`/`shrink-0`); throw away Phase 2's px harness.
- `useNodesState`→`useState`; `NodeProps`→`CanvasNodeProps`; `NodeResizeControl`→custom or dropped; remove `useStore`/`useViewport`; drop `ReactFlowProvider`; remove dep.
- **Verify:** full exercise (spawn/promote/close/move/switch/diff/copy-paste/scrollback) with **zero** ReactFlow errors; `grep @xyflow` empty.

### Phase 6 — Delete frames *(any time after Phase 0)*
Delete `frames/` dir; remove `FrameData` from `CanvasNode`; remove frame branches.
- **Verify:** build clean, no dangling imports.

## Resolved-by-default UX

- **Master selection:** clicked stack card → master; demoted master → **top** of stack; new card → master; closing master → promote next. `focusedCardId` is per-project and persisted.
- **Loud card buried in stack:** **sort the stack by attention** (blocked/error/needsYou float up) + count badge; **do NOT auto-promote** (would yank a terminal you're typing in).
- **Diffs are a collapsible side sheet, not a tile.** A diff opens as a drawer that slides in over the main master-stack view and can be collapsed/closed. Diffs are **session-only** (never persisted), **not** in `CardRecord`/`cardIds`, and never participate in tiling. `DiffNode`'s git/diff logic (`diffText.ts`, git IPC) is reused inside the sheet; it stops being a ReactFlow node. Built in Phase 4.5.
- **Empty project:** per-project empty state ("spawn a card to begin").
- **Last/active project delete:** permanent undeletable `proj-default`; Delete hidden when only Default remains.
- **Spawn-while-typing:** new card steals master (intended); demoted terminal keeps full tmux state.

## Risk register

| # | Hazard | Mitigation | Phase |
|---|---|---|---|
| 1 | **Data loss on 2nd launch** — `load()` null unless `items`; project-only model drops `folder`/`kind`/`session`. | Global CardRecord registry + widen `load()` guard + always write complete snapshot. | 0 |
| 2 | **FitAddon resize storm** — `ResizeObserver(()=>fit())` fires ~18×/animation. | Transition-aware fit, single fit on settle. | 1 |
| 3 | **Terminal unmount on project switch** → scrollback loss; `display:none` → 0-height fit. | Keep all CardNodes mounted; hide via `visibility`; never rebuild `nodes`. | 4 |
| 4 | **Remote panel/feed go partial** if they read active-project nodes. | Source from global registry; tag with `projectName`. | 4 |
| 5 | **Phase-A `screenToFlowPosition` not identity** — saved viewport offset. | Force `{0,0,1}` on mount, remove viewport restore. | 2 |
| 6 | **Loud card invisible in stack** — supervision regression. | Attention-sort stack + badge. | 4 |
| 7 | **Promote handler unplumbed.** | Add `onPromote` to CardData. | 1 |

**Effort, honest:** Phase 0 is the riskiest and most valuable (~1.5 days, all backend/persistence). Phases 1-3 ~2 days. Phase 4 ~2 days. Phases 5-6 ~2-3 days. Total ~8-10 focused days; Phases 0-1 are merge-and-test gates not to skip.

## Post-refactor cleanup audit ✅ DONE
A 5-dimension multi-agent audit (dead-code, stale-refs, gaps, bugs, backend/types), each finding independently re-verified, produced 33 confirmed (11 of which were "verified-correct, no action") + 2 false-positives rejected. Applied:
- **Dead code**: removed the unreachable `'diff'` variant from the `CanvasNode` union (diffs render from `openDiff`, never the node array) + its now-unused import.
- **Stale references**: fixed README (title/stack/skeleton/LOD), `package.json` description ("infinite-canvas" → "master-stack"), and comments in TerminalView/DiffNode/VideoBackdrop/PosterFace (far-zoom/god-view/frames wording).
- **Vestigial ReactFlow classes**: stripped `nodrag`/`nowheel`/`card-drag` (no-ops since ReactFlow left) — and first fixed the real wheel-bleed at its source (`onStackWheel` now ignores wheels over `[data-diff-sheet]`).
- **Gap**: the phone panel now renders each card's `projectName` (was published but unshown).
- **Bugs**: restore-order race fixed (`setNodes` before `onRestore`); rAF cleanup added in `useProjects`.
- **Skipped (justified)**: `prompt()` cancel (already no-ops correctly), `alert()`→banner (pre-existing, optional), redundant `stackScroll` clamp (render already clamps). README "Not yet ported" section is pre-existing doc-rot — flagged, not rewritten.
- Verified: `tsc` + build green; grep sweep confirms zero `reactflow`/`xyflow`/`nodrag`/`infinite-canvas` remain.
