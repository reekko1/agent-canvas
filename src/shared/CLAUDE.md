# src/shared

Cross-process code imported by BOTH the main process and the renderer (and the
bundled mobile/remote panel, which aliases `@shared`). Because it is loaded on
every side of the build split, keep it strictly **dependency-free and
side-effect-free**: no Electron, no Node, no DOM, no module-level work — just
types and pure functions. Types are erased at build; helpers must run anywhere.

## Files

- **types.ts** — the canonical cross-process type definitions. The most
  important shapes:
  - `CardKind` — discriminant for what a card holds: `agent` (watched CLI),
    `shell` (bare `$SHELL`), or `browser` (an in-app `<webview>` with no
    tmux/pty/spine session — neutral chrome, never speaks to the spine).
  - `CLI_KINDS`/`CliKind` — THE single source of which coding-agent CLIs can
    back an `agent` card (`claude`/`codex`); every exhaustive map (the spine's
    adapter registry, renderer labels) and the orchestrator's spawn tool derive
    from it, so adding a CLI compile-breaks every site that must handle it.
    Threaded through `CardRecord.cli`, `RemoteState.canvases[].cli`, the
    `spawnAgent` command payload, and `CanvasApi.spawnCard`/`availableClis()`.
    Absent = `claude`.
  - `CardStatus` — the agent/shell lifecycle states (`idle` → `running` →
    `waiting`/`done`/`stalled`/`blocked`/`error`).
  - `CardEvent` + `TodoChange`/`AgentTodo` — one semantic update extracted from a
    CLI lifecycle event (status flip, metadata, feed line, plan delta).
  - `PermissionAskInfo` / `AskDecision` — a held permission gate (allow/deny/
    release); `QuestionAskInfo` / `Question` / `QuestionOption` /
    `QuestionAnswers` — a held `ask_user` question from the canvas MCP (choose
    options, not allow/deny).
  - `CardRecord` / `Project` / `MultiProjectSnapshot` — multi-project
    persistence (global card registry + per-project layout). A browser card's
    `url` is the only kind-specific field persisted (reload-on-restore; the live
    snapshot is transient and never stored).
  - Git: `GitChange` / `GitSnapshot` / `RepoIdentity` / `GitActionRequest` /
    `GitActionResult`.
  - Remote panel: `RemoteState` / `AttentionLevel` + readiness shapes
    (`AppReadiness`, `RemoteReadiness`), `UpdateStatus`. Each
    `RemoteState.canvases` entry carries `active: boolean` — the one canvas
    open in the desktop viewport (exactly one true when any canvas exists), so
    the phone can mark the current repo and the orchestrator knows which canvas
    it operates on by default.
  - Orchestrator: `OrchestratorMode` / `OrchestratorEvent` /
    `OrchestratorCommand` / `OrchestratorTarget` and their result types. Browser
    cards ride the same command seam as agents — `spawnBrowser`/`navigateBrowser`
    plus the agency verbs `readBrowser`/`screenshotBrowser`/`actBrowser`/
    `setBrowserReason` — alongside spawn/focus/rename/kill;
    `OrchestratorActionResult` carries the `snapshot`/`image` they return.
  - Browser agency: `BrowserElement` / `BrowserSnapshot` (the pinned
    observation contract — `ref` is opaque so the backend can swap how it
    resolves) and `BrowserAction` (`click`/`type`/`scroll`/`select`/`history`).
    `CardRecord` and `RemoteState.cards` carry `ownerCardId`/`ownerId` +
    `reason` (persisted browser ownership: which agent requested it and why).
  - Issue store (Mastermind substrate, see `MASTERMIND.md`): `Vision` /
    `VisionVersion` (immutable, append-only) / `Sprint` (with `SprintState`) /
    `Plan` / `Issue` records, the `IssueActionRequest` mutation union +
    `IssueActionResult`, and the `IssueSnapshot` read-projection. Everything is
    per-project (per canvas): each canvas has its own vision, versions, sprints,
    plans, and issues — one north star per product/repo. The **idea-tournament**
    layer adds `Idea` + `Conception` (the recorded tournament; `conception.*` actions)
    on the same store and the `idea-ready` / `idea-abstained` milestones. The tournament
    runs off-card on the mastermind (`orchestrator/tournament.ts`), not as a card role.
  - `CanvasApi` — the full interface the preload bridge implements and the
    renderer consumes (the IPC contract in one place). Browser readiness rides
    here too: `browserReady` (renderer→main: a `<webview>` is dom-ready, with
    its `webContentsId`, or torn down) and `onBrowserWake` (main→renderer:
    revive a dormant/evicted browser so it can be driven).
- **browserDriver.ts** — the single in-page driver for browser-card agency:
  self-contained JS that runs in the guest's own DOM to produce a
  `BrowserSnapshot` (`READ_SCRIPT`) and to act on it. Shared because BOTH
  transports use it — the renderer Tier-A path via `webview.executeJavaScript`
  (`buildActionScript`) and main's Tier-B CDP path via `Runtime.evaluate`
  (`resolveRefScript`/`focusRefScript`/`scrollScript`/`selectScript`/
  `historyScript`). `ref` is an opaque, snapshot-scoped set-of-marks index
  stamped as a `data-canvas-ref` attribute on read and resolved back by a plain
  attribute selector; a read clears prior refs first, so a post-mutation action
  returns `stale-ref` (the message is the shared `staleRefMessage(ref)` builder,
  used by both tiers — browserController's CDP branches and the Tier-A action
  script — so the re-read hint reads identically whichever path drove the action). Note the dependency-free rule still holds: the **strings
  run in a DOM**, but the module is just strings + pure builders (no DOM/Electron
  import) — the canonical "dependency-free, runs anywhere" file.
- **time.ts** — relative-time formatting helpers (`relativeFromSeconds`, the
  `MINUTE`/`HOUR`/`DAY` thresholds). Epoch-seconds in, `"now"`/`"5m"`/`"2h"`/`"Nd"`
  out, with an `overflow` hook for past-a-day formatting.

## Conventions & gotchas

- This is the **source of truth for IPC payload shapes**. `CanvasApi` here is the
  contract that `src/preload` implements and the renderer calls.
- Changing a type here **ripples to main + preload + renderer** at once — update
  all three ends of the seam (and the remote panel if a `@shared` type changes).
- Add nothing with a runtime dependency. If it can't be imported safely from both
  main and renderer, it doesn't belong here.
