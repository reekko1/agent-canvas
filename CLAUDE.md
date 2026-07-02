# Agent Canvas

Fixed-viewport, master-stack supervision for coding-agent fleets — an Electron +
React desktop app. A folder of work becomes an agent **card** backed by a
headless coding-agent session: one long-lived Claude Agent SDK `query()` for a
claude card, a turn-batched `codex exec --json` subprocess for a codex card.
No tmux, no pty, no hooks — each CLI's own structured event stream drives the
card's status, live transcript, and self-published checklist directly. This is
the rebuild of the native Swift app at `~/Agents-Canvas`; that repo's
`CLAUDE.md` is the product spec of record for the ORIGINAL tmux-backed design
(reattach-not-resume, ✕ kills the session, status never persisted, fly-in
releases held permission asks) — this repo has since diverged from that
substrate (see `src/main/spine/CLAUDE.md`), though the supervision *product*
principles (the ✕ ends a session for good; nothing should execute
unsupervised) still hold, now expressed as "sessions don't survive a quit."
See `README.md` for run/release and `REFACTOR_PLAN.md` for the phased history
of the master-stack rebuild.

## The model

A **fixed-viewport master-stack**: the focused card runs large as a live
transcript (or a terminal, for a shell card); the rest sit as compact poster
cards in a scrollable column — click one to promote it. Cards are grouped into
**projects** (named canvases) switched from the top toolbar. Diffs open as a
collapsible side sheet. An agent card's session lives entirely in the main
process (an SDK query or a subprocess) — switching, moving, or restacking a
card never interrupts it, since there's no terminal surface tied to a
particular mount. A headless session does NOT survive an app quit (the
product's own principle: nothing should execute unsupervised while its
supervisor is dead) — on relaunch a card repaints its persisted transcript and
sits idle until the first message resumes the same CLI session. A
natural-language **orchestrator** and **voice** (push-to-talk, spoken replies)
sit on top.

## Layout

Three processes, bridged by Electron IPC. Each directory below has its own
`CLAUDE.md` — read it before working in that area.

### Main process — `src/main/` (Node/Electron backend)
- `src/main/` (root) — Electron entry, BrowserWindow, IPC wiring, a shell card's pty, workspace persistence.
- `src/main/spine/` — drives every agent card's headless session (a claude driver over the Agent SDK, a codex driver over turn-batched `codex exec` subprocesses); no tmux, no hooks — each CLI's own event stream feeds card status + the transcript.
- `src/main/orchestrator/` — NL orchestrator: Agent SDK loop + in-process MCP over a command bus.
- `src/main/remote/` — phone backend: HTTP+WS server (over Tailscale), web-push, readiness.
- `src/main/voice/` — Soniox STT (push-to-talk) + streaming TTS; owns the sockets and API key.
- `src/main/git/` — git status/diff and filesystem watchers per card folder.

### Renderer — `src/renderer/src/` (React UI)
- `src/renderer/src/canvas/` — the master-stack board, project toolbar, and its state hooks (largest dir).
- `src/renderer/src/cards/` — card faces: a live transcript + composer for an agent, a terminal for a shell, poster/face overlays when stacked; ask/question toasts.
- `src/renderer/src/orchestrator/` — chat bar, action tracer, confirm toasts, renderer voice glue.
- `src/renderer/src/lib/` — shared renderer utilities and React contexts (icons, theme, springs, `cn()`).
- `src/renderer/src/diff/`, `src/renderer/src/hooks/`, `src/renderer/src/components/ui/` — diff sheet, small hooks, shadcn primitives.
- `src/renderer/src/components/assistant-ui/` — vendored `@assistant-ui/react` primitives (`Thread`, markdown, tool cards) that render an agent card's `TranscriptView`.

### Cross-process
- `src/preload/` — the contextBridge IPC surface; the only sanctioned renderer↔main channel.
- `src/shared/` — types and helpers imported by both main and renderer (source of truth for IPC payload shapes).
- `src/remote-app/` — standalone phone web client; its own Vite build (`vite.remote.config.ts`), served by `src/main/remote` over Tailscale.

## Build & tooling

- `npm run dev` — `electron-vite dev` + a watched `vite.remote.config.ts` build for the phone app.
- `npm run build` — main/preload/renderer build, then the remote app.
- `npm run typecheck` — `tsc --noEmit`. **This plus the build is the only gate** — there is no ESLint or Prettier; don't add linters or reformat files.
- `npm run dist` / `Packaging/package.sh` — signed + notarized dmg/zip; `Packaging/release.sh` publishes the GitHub release that `electron-updater` reads. Never reuse a version; bump `package.json` first.
- `postinstall` rebuilds `node-pty` against Electron's ABI (`patch-package` + `electron-rebuild`).
- Agent SDK auth runs on the Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN`; an API key, if present, outranks it.

## Isolation from the Swift app

Deliberately separated so both can run at once: config dir `~/.agentcanvas-web/`
(the Swift app owns `~/.agentcanvas`). At cutover, repoint this to inherit the
production fleet. There is no tmux socket to isolate anymore — headless
sessions have no shared substrate to collide on.

## Known gaps

Stall heartbeat (the `stalled` status exists but nothing auto-detects silence)
and keyboard navigation. The WebGL/context budget that used to bound every live
terminal now bounds only shell cards + browser `<webview>` guests (Chromium
caps WebGL contexts at ~16; past that xterm falls back to the slow DOM
renderer) — an agent card's transcript is plain React DOM, not a GL surface, so
it no longer competes for that budget. The phone's `/orch` WebSocket requires
the session token as a `?token=` query param on top of tailnet isolation; the
old `/term` tmux-bridge socket is gone (agent cards have no terminal to mirror;
the phone's Fleet tab opens a read-only transcript view instead).
