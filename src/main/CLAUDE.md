# src/main (root) — Electron main entrypoint

This directory is the root of the Electron **main process**: the app lifecycle owner that
constructs every long-lived subsystem (spine, ptys, workspace store, diff watchers,
orchestrator, voice) as module-level singletons and wires them to the renderer over a single
`ipcMain` surface in `index.ts`. Everything stateful and privileged — tmux/pty, git, the
auto-updater, the NL orchestrator, voice sockets, the remote panel — is owned here or in a
sibling subdirectory; the renderer only sends/receives IPC.

## Subdirectories
Each has its own CLAUDE.md — read it before working in that area.
- **spine/** — the substrate that launches/supervises agent sessions (tmux), tracks card
  events, permission asks, questions, replies, todos, and hosts the remote panel server.
  Defines `SPINE_DIR` (`~/.agentcanvas-web`), the on-disk home for main-process state.
- **orchestrator/** — the in-app NL orchestrator: drives the canvas via the Agent SDK,
  reads the latest published `RemoteState`, issues mutations/confirms back to the renderer.
- **remote/** — the phone/remote panel: the HTTP+WS server (`remoteServer.ts`), web-push,
  and the app/remote readiness probes. The spine owns the live instance (`spine.remote`).
- **voice/** — Soniox push-to-talk STT and streaming TTS; main owns the sockets, the
  encrypted key store, and speech-paced delivery of orchestrator events.
- **git/** — git actions, per-file diffs, repo identity, and the diff watchers that push
  `diff-snapshot` events to the renderer.

## Files
- **index.ts** — the entry module. Sets up the auto-updater (logs to `<logs>/updater.log`,
  resolves releases via the GitHub Atom feed, polls every 6h until an update is staged),
  creates the hardened `BrowserWindow` (contextIsolation + sandbox on, preload bridge,
  `webviewTag` on for browser cards), locks down host navigation/popups, intercepts
  whole-app zoom, grants mic permission for push-to-talk, instantiates the singletons, and
  registers all `ipcMain.handle`/`.on` handlers. Among the singletons is a `BrowserController`
  (Tier-B CDP driver, passed to the orchestrator as its `browser` dep; its `wake` asks the
  renderer to revive an evicted browser) whose readiness map is fed by the `browser-ready`
  handler. Every agent-facing loopback MCP server — `AgentBrowserMcp` (`browser`),
  `AgentIssueMcp` (`issues`), and `AgentCanvasMcp` (`canvas`: the CLI-agnostic
  `update_plan`/`ask_user` tools, given a long per-tool timeout since `ask_user` blocks on a
  human) — rides one uniform lifecycle in an `agentMcps` list: `server.start(spine.mcpPort(id),
  …)` binds its stable persisted port, then `spine.attachMcp(id, port, opts)` persists it and
  stages the per-card `--mcp-config` across every CLI adapter; `id` doubles as the card's tool
  namespace (`mcp__<id>__*`). Adding a fourth server is one more entry in that list. Local
  module state: `nextItem` (card-id counter), `pendingPrompts` (initial prompts queued for a
  card before its pty spawns, delivered one-shot by `ensure-card`), `agentCanvasMcp` (kept
  module-scoped so the ask IPC handlers can route an answer/decline to it), and
  `latestWorkspace` (the latest renderer-pushed `MultiProjectSnapshot`, kept so main can resolve
  a canvas's repo dir for the off-card idea tournament and so a restored session's cards can
  have their CLI re-seeded into the spine on `load-workspace`).
- **ptys.ts** — `PtyRegistry`, one `node-pty` per card keyed by `cardId`. Spawns from a
  `LaunchSpec` (file/args/cwd/env produced by `spine.launch`), forwards data/exit to the
  renderer, and resizes. Killing a pty here only **detaches the tmux client**; ending the
  agent is `Spine.killSession`'s job.
- **workspace.ts** — `WorkspaceStore`, the disk side of workspace persistence at
  `SPINE_DIR/workspace.json`. The renderer owns canvas state and pushes whole
  `MultiProjectSnapshot`s; `save` debounces (~400ms) so drags don't grind the FS, `flush`
  writes synchronously on quit, and `load` normalizes the file (drops dirless projects,
  ghost cards with no canvas, fixes `activeProjectId`).
- **issueStore.ts** — `IssueStore`, the Mastermind substrate (see `MASTERMIND.md`):
  the `Vision → Sprint → Plan → Issue` store as an append-only JSONL event log
  (`SPINE_DIR/issues.jsonl`) materialized in memory. Main is the single arbiter —
  `apply` validates → reduces → appends one durable line → emits — so writes never
  interleave and atomic claims need no transaction. `load` replays the log (ids +
  timestamps are persisted per entry for deterministic replay); a `vision.commit`
  runs the propagation pass (a redirection/expansion moves stale sprints to
  REALIGNMENT_PENDING). It records the off-card idea tournament's **conceptions**
  too (`conception.*` — there is no strategist card) and fires the milestones the mastermind wakes on —
  `plan-ready`, the `issue-*` nudges, `outcome-verified` (a sprint reached DONE),
  and `idea-ready` / `idea-abstained`. Channels: `load-issue-store`, `issue-action`
  (both invoke), `issue-update` (push). Clients: the renderer board (IPC) and the
  role cards (the agent issue MCP).

## Architecture / data flow
- **Lifecycle:** `app.whenReady` starts the spine, builds voice + orchestrator, creates the
  window, and (only when `app.isPackaged`) arms the updater. `before-quit` flushes the
  workspace and disposes watchers/orchestrator/voice. Quitting deliberately leaves the agent
  fleet running — it only detaches tmux clients.
- **IPC seam:** `src/preload/index.ts` exposes a typed `CanvasApi` over `contextBridge`; the
  renderer never touches `ipcRenderer` directly. `index.ts` answers `invoke` calls and pushes
  events to the renderer through the local `send(channel, ...)` helper
  (`win.webContents.send`). Channel/payload contracts live in `src/shared/types.ts`.
- **pty vs tmux:** a card's pty (ptys.ts) is just the local terminal client; the actual agent
  session lives in a tmux session managed by the spine. The pty spawns lazily on `ensure-card`
  when the renderer mounts the card, fed by `spine.launch(cardId, folder, { bareShell,
  initialPrompt, cli })` — `cli` (a `CliKind`, e.g. `claude`/`codex`) is optional and only
  meaningful for `agent` cards; `available-clis` (`spine.availableClis()`) tells the renderer
  which CLIs are actually installed so it can offer them at card-creation time.
- **Card kinds:** `agent` (tmux/pty/spine session) and `shell`, plus `browser` — an in-DOM
  `<webview>` guest with no pty/tmux/spine session at all. `new-browser` only mints the id
  (`browser-` prefix, like `card-`/`shell-`); the renderer owns the url, and browsers are now
  see-and-controllable — both the orchestrator (Tier-B CDP via `BrowserController`) and agent
  cards (the `AgentBrowserMcp` server) drive them over the command seam, gated on a readiness
  map fed by the `browser-ready` IPC. Browser-card guests run in their own process/session,
  carry no preload, and so can't reach the `CanvasApi` bridge.
- **Ask/question ownership:** a `q-<n>` id (`ask_user`, the canvas MCP) is held by
  `agentCanvasMcp`; an `ask-<n>` id (a permission hook ask) is held by the spine. Questions
  have exactly ONE holder — the canvas MCP (`AskUserQuestion` is disallowed on every card, so
  a question can never be a spine ask): `answer-question` (and the remote `onAnswer`) go
  straight to `agentCanvasMcp.answer`. Permission decisions (`decide-ask`, remote `onDecline`)
  try `agentCanvasMcp.decline` first — it returns `false` when it doesn't own the id — and
  fall through to `spine.decide`; `release-asks` releases both holders.
- **Stall detection:** the 60s sweep in `index.ts` does two independent things — the pre-existing
  per-`Issue` silence check (`issue.setStall`, edge-triggered off `spine.lastEventAt` vs each
  issue's own threshold) is unchanged, and a second, card-level pass flips any `agent` card stuck
  in `status: 'running'` past `STALL_THRESHOLD_MS` (8 min) with no fresh hook event to a
  `stalled` card-event. This second pass is CLI-agnostic by necessity: Claude cards get a
  `StopFailure` hook on a dead turn, but codex has none, so silence is the only signal for
  either. `stalledCards` edge-triggers the emit (fires once per silent stretch, clears on the
  next real status change or on fresh activity) so the log/UI doesn't get an event every tick.
- **Persistence:** main-process state lives under `SPINE_DIR` (`~/.agentcanvas-web`); the
  workspace snapshot is the only file owned by this directory's code. `load-workspace` also
  seeds `latestWorkspace` and re-registers each restored `agent` card's CLI into the spine
  (`spine.setCardCli`) — so a hook event from a tmux session that survived the restart still
  resolves the right adapter before its card remounts; `save-workspace` keeps `latestWorkspace`
  current on every renderer push.

## Conventions & gotchas
- `node-pty` is a native module — `postinstall` runs `patch-package && electron-rebuild -f -w
  node-pty`. After changing Electron versions or reinstalling, expect a rebuild; a stale
  `node-pty` is the usual cause of pty spawn failures.
- Subsystems are module-level singletons in `index.ts`; there is no DI container. Adding a new
  IPC route means registering it here and adding it to `CanvasApi` + preload.
- Renderer hardening is pinned explicitly (sandbox/contextIsolation/no nodeIntegration) and
  host navigation/popups are denied — don't relax these. External links go only through the
  `open-external` IPC (https-only) → `shell.openExternal`. Browser-card `<webview>` guests are
  *exempted* from the navigation lock (they're a real browser) — the check keys on
  `contents.getType() === 'webview'`, so the lock still binds the host frame.
- Whole-app zoom (Cmd/Ctrl +/-/0) is intercepted via `before-input-event` on *every* web
  contents — host and webview guests alike — and redirected to the host renderer's zoom level
  (clamped). Owning it directly keeps a focused browser card from swallowing the shortcut and
  zooming only its own page (which the default menu zoom role would do).
- The updater intentionally sets `allowPrerelease = true` to use the cookie-insensitive Atom
  feed; release.sh never publishes prereleases, so this never pulls a real pre-release.
- Voice and orchestrator no-op gracefully when their keys/env are absent (`SONIOX_API_KEY`,
  Agent SDK auth) — don't assume they're live.
