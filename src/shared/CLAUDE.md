# src/shared

Cross-process code imported by BOTH the main process and the renderer (and the
bundled mobile/remote panel, which aliases `@shared`). Because it is loaded on
every side of the build split, keep it strictly **dependency-free and
side-effect-free**: no Electron, no Node, no DOM, no module-level work — just
types and pure functions. Types are erased at build; helpers must run anywhere.

## Files

- **types.ts** — the canonical cross-process type definitions. The most
  important shapes:
  - `CardKind` — discriminant for what a card holds: `agent` (a headless CLI
    session — the Agent SDK for claude, a turn-batched `codex exec --json`
    subprocess for codex; no tmux, no pty), `shell` (a direct pty, bare
    `$SHELL`), or `browser` (an in-app `<webview>` with no session at all —
    neutral chrome, never speaks to the spine).
  - `CLI_KINDS`/`CliKind` — THE single source of which coding-agent CLIs can
    back an `agent` card (`claude`/`codex`); every exhaustive map (the spine's
    driver registry, renderer labels) and the orchestrator's spawn tool derive
    from it, so adding a CLI compile-breaks every site that must handle it.
    Each kind maps to a `CliDriver` in the spine (headless session lifecycle,
    MCP/skill staging, event mapping — see `spine/CLAUDE.md`). Threaded
    through `CardRecord.cli`, `RemoteState.canvases[].cli`, the `spawnAgent`
    command payload, and `CanvasApi.startAgent`/`availableClis()`. Absent =
    `claude`.
  - `CardStatus` — the agent/shell lifecycle states (`idle` → `running` →
    `waiting`/`done`/`stalled`/`blocked`/`error`).
  - `CardEvent` + `TodoChange`/`AgentTodo` — one semantic update extracted from a
    CLI lifecycle event (status flip, metadata, feed line, plan delta) — a state
    PATCH folded into a card's `CardMeta`. Distinct from `TranscriptItem` below,
    which is a feed entry, not a patch.
  - `TranscriptItem`/`TranscriptItemKind` — one entry in an agent card's
    conversation feed (`user`/`assistant`/`tool`/`turn`/`system`/`error`),
    pushed on `onTranscriptItem` and persisted to
    `SPINE_DIR/transcripts/<cardId>.jsonl`. `id` is the upsert key: a streaming
    assistant message re-pushes under the SAME id with growing text
    (`streaming: true`), then once more finalized — the renderer/phone replace
    by id rather than append, so a push arriving mid-`loadTranscript` can't
    duplicate a row.
  - `SendOutcome` (`'sent' | 'queued'`) — whether `sendToCard` delivered a
    message into an agent's live turn (claude: always; codex: only when idle)
    or queued it behind an in-flight one (codex, delivered as the next resume
    turn). `ShellTitle` — a shell card's foreground command + cwd (ps-walk of
    its direct pty, no tmux pane to query), polled by `useShellTitles` on both
    desktop and phone.
  - `PermissionAskInfo` / `AskDecision` — a held permission gate (allow/deny/
    release); dormant now that agent cards run headless and unattended (there's
    no held permission ask to decide — the wiring is kept, not ripped out, in
    case a future gated mode reintroduces one). `QuestionAskInfo` / `Question` /
    `QuestionOption` / `QuestionAnswers` — a held `ask_user` question from the
    canvas MCP (choose options, not allow/deny) — this is the LIVE one.
  - `CardRecord` / `Project` / `MultiProjectSnapshot` — multi-project
    persistence (global card registry + per-project layout). `CardRecord.session`
    is an agent card's CLI session/thread id — a headless session does NOT
    survive an app restart, so this is what the card's first `sendToCard` after
    a relaunch resumes (a stale id just falls back to a fresh session). A
    browser card's `url` is the only other kind-specific field persisted
    (reload-on-restore; the live snapshot is transient and never stored).
  - Git: `GitChange` / `GitSnapshot` / `RepoIdentity` / `GitActionRequest` /
    `GitActionResult`.
  - Remote panel: `RemoteState` / `AttentionLevel` + readiness shapes
    (`AppReadiness` — now just `claudeFound` + `orchestratorAuthed` +
    `voiceKeySet`, `RemoteReadiness`), `UpdateStatus`. Each
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
  - `UNKNOWN_CARD` — the card-id sentinel the agent-facing MCP guards treat as
    "no card". A defensive fallback for a codex card's `X-Canvas-Card` header
    (read from `CANVAS_CARD_ID` in its child env, which the driver always
    sets, so this should never actually be hit). Claude cards bake their real
    cardId into the header directly, never this sentinel.
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
