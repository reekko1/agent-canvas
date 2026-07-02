# src/main (root) — Electron main entrypoint

This directory is the root of the Electron **main process**: the app lifecycle owner that
constructs every long-lived subsystem (spine, ptys, workspace store, diff watchers,
orchestrator, voice) as module-level singletons and wires them to the renderer over a single
`ipcMain` surface in `index.ts`. Everything stateful and privileged — headless agent sessions,
shell ptys, git, the auto-updater, the NL orchestrator, voice sockets, the remote panel — is
owned here or in a sibling subdirectory; the renderer only sends/receives IPC.

## Subdirectories
Each has its own CLAUDE.md — read it before working in that area.
- **spine/** — the substrate that runs each agent card as a headless session (one Agent SDK
  `query()` per claude card, a turn-batched `codex exec --json` subprocess per codex card),
  tracks card events, transcripts, replies, and todos, and hosts the remote panel server.
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
  stages the per-card config across every CLI driver; `id` doubles as the card's tool
  namespace (`mcp__<id>__*`). Adding a fourth server is one more entry in that list. Local
  module state: `nextItem` (card-id counter), `pendingPrompts` (initial prompts queued for an
  agent card before its session starts, delivered one-shot by `start-agent`), `agentCanvasMcp`
  (kept module-scoped so the ask IPC handlers can route an answer/decline to it — the ONLY
  question/decision holder now; see below), and `latestWorkspace` (the latest renderer-pushed
  `MultiProjectSnapshot`, kept so main can resolve a canvas's repo dir for the off-card idea
  tournament, resolve a restored agent card's persisted CLI session id as the `resume` a
  `start-agent` call passes to `spine.ensureAgent`, and re-seed each restored agent card's CLI
  into the spine on `load-workspace`).
- **ptys.ts** — `PtyRegistry`, one `node-pty` per SHELL card keyed by `cardId` (agent cards have
  no pty at all — they're headless sessions owned entirely by `spine.ts`). Spawns from a
  `PtySpawnSpec` (file/args/cwd/env, built inline by `index.ts`'s `ensure-shell` handler — a
  plain login shell, no tmux), forwards data/exit to the renderer, resizes, and exposes `pid`
  (feeds the shell-title ps-walk in `spine/ptyTitles.ts`). Killing a pty here ends the shell
  outright — there's no session multiplexer underneath to detach from instead.
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
  workspace, disposes watchers/orchestrator/voice, and calls `spine.shutdown()` — which
  interrupts every live agent session. Quitting no longer just "detaches" anything: an agent
  session's process/query IS the app's responsibility, so tearing down the app tears down the
  fleet's live work too (both drivers persist their transcript incrementally, so at most one
  in-flight tool call is lost, never the conversation — see spine/CLAUDE.md).
- **IPC seam:** `src/preload/index.ts` exposes a typed `CanvasApi` over `contextBridge`; the
  renderer never touches `ipcRenderer` directly. `index.ts` answers `invoke` calls and pushes
  events to the renderer through the local `send(channel, ...)` helper
  (`win.webContents.send`). Channel/payload contracts live in `src/shared/types.ts`.
- **pty vs headless session:** a shell card's pty (`ptys.ts`) is a real local process — a login
  shell, spawned lazily on `ensure-shell` when the renderer mounts the card, after it has
  subscribed to `pty-data` (no byte can outrun the listener). An agent card has NO pty at all:
  its session lives entirely inside `spine.ts` (an SDK `query()` or a `codex exec` subprocess),
  registered lazily on `start-agent` (also fired from the CardNode mount effect) and driven
  through `send-to-card`/`interrupt-card`, never through pty writes. `available-clis`
  (`spine.availableClis()`) tells the renderer which CLIs are actually installed so it can offer
  them at card-creation time; `cli` (a `CliKind`) is only meaningful for `agent` cards.
- **Card kinds:** `agent` (a headless spine session — SDK query or codex subprocess, no
  pty/tmux at all), `shell` (a direct pty, no agent), and `browser` — an in-DOM `<webview>`
  guest with no pty/session at all. `new-browser` only mints the id (`browser-` prefix, like
  `card-`/`shell-`); the renderer owns the url, and browsers are see-and-controllable — both
  the orchestrator (Tier-B CDP via `BrowserController`) and agent cards (the `AgentBrowserMcp`
  server) drive them over the command seam, gated on a readiness map fed by the `browser-ready`
  IPC. Browser-card guests run in their own process/session, carry no preload, and so can't
  reach the `CanvasApi` bridge.
- **Ask/question ownership:** a `q-<n>` id (`ask_user`, the canvas MCP) is held by
  `agentCanvasMcp` — the ONLY holder now. There is no more spine-side permission-ask hold
  (`ask-<n>`): headless cards run unattended (`bypassPermissions` / `--ask-for-approval never`),
  so a permission hold never arises to begin with. `answer-question` (and the remote
  `onAnswer`) go straight to `agentCanvasMcp.answer`; `decide-ask` (and the remote `onDecline`)
  go straight to `agentCanvasMcp.decline` (no fallback — there's nothing left to fall through
  to); `release-asks` releases the one holder. The `PermissionAskInfo` type, `permission-ask`/
  `ask-decided` channels, and `AskToasts` component are kept dormant (compile-safe, never fired)
  rather than torn out in this pass — a later cleanup sweep's job.
- **Stall detection:** the 60s sweep in `index.ts` does two independent things — the pre-existing
  per-`Issue` silence check (`issue.setStall`, edge-triggered off `spine.lastEventAt` vs each
  issue's own threshold) is unchanged, and a second, card-level pass flips any `agent` card stuck
  in `status: 'running'` past `STALL_THRESHOLD_MS` (8 min) with no fresh session event to a
  `stalled` card-event. This second pass is CLI-agnostic by necessity: a claude session's mapper
  reports a non-success `result` on a dead turn, but codex has nothing equivalent, so silence is
  the only signal for either. `stalledCards` edge-triggers the emit (fires once per silent
  stretch, clears on the next real status change or on fresh activity) so the log/UI doesn't get
  an event every tick.
- **Persistence:** main-process state lives under `SPINE_DIR` (`~/.agentcanvas-web`); the
  workspace snapshot is the only file owned by this directory's code. `load-workspace` also
  seeds `latestWorkspace` and re-registers each restored `agent` card's CLI into the spine
  (`spine.setCardCli`) — so its first `start-agent` (fired when its CardNode mounts) resolves
  the right driver and, via `latestWorkspace`, the right `resume` session id; `save-workspace`
  keeps `latestWorkspace` current on every renderer push.

## Conventions & gotchas
- `node-pty` is a native module — `postinstall` runs `patch-package && electron-rebuild -f -w
  node-pty`. After changing Electron versions or reinstalling, expect a rebuild; a stale
  `node-pty` is the usual cause of shell-card pty spawn failures. (Agent cards don't touch
  node-pty at all — only shells do.)
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
- `checkAppReadiness` no longer arms anything — there's no tmux substrate left to detect and
  prepare. It's a pure probe now (claude on PATH, orchestrator auth, voice key).
