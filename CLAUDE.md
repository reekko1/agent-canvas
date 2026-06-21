# Agent Canvas

Fixed-viewport, master-stack supervision for coding-agent fleets — an Electron +
React + xterm.js desktop app. A folder of work becomes an agent **card** backed
by a real `claude` CLI running in a tmux session; Claude Code hook events drive
each card's status and self-published checklist. This is the rebuild of the
native Swift app at `~/Agents-Canvas`; that repo's `CLAUDE.md` is the product
spec of record (reattach-not-resume, ✕ kills the session, status never
persisted, fly-in releases held permission asks). See `README.md` for run/release
and `REFACTOR_PLAN.md` for the phased history of the master-stack rebuild.

## The model

A **fixed-viewport master-stack**: the focused card runs large as a live
terminal; the rest sit as compact poster cards in a scrollable column — click one
to promote it. Cards are grouped into **projects** (named canvases) switched from
the top toolbar. Diffs open as a collapsible side sheet. Every card across every
project stays attached to its tmux session, so switching, moving, and relaunching
never lose scrollback (`tmux new-session -A`). A natural-language **orchestrator**
and **voice** (push-to-talk, spoken replies) sit on top.

## Layout

Three processes, bridged by Electron IPC. Each directory below has its own
`CLAUDE.md` — read it before working in that area.

### Main process — `src/main/` (Node/Electron backend)
- `src/main/` (root) — Electron entry, BrowserWindow, IPC wiring, ptys, workspace persistence.
- `src/main/spine/` — launches/attaches real `claude` in tmux; ingests hook events into card status.
- `src/main/orchestrator/` — NL orchestrator: Agent SDK loop + in-process MCP over a command bus.
- `src/main/remote/` — phone backend: HTTP+WS server (over Tailscale), web-push, readiness.
- `src/main/voice/` — Soniox STT (push-to-talk) + streaming TTS; owns the sockets and API key.
- `src/main/git/` — git status/diff and filesystem watchers per card folder.

### Renderer — `src/renderer/src/` (React UI)
- `src/renderer/src/canvas/` — the master-stack board, project toolbar, and its state hooks (largest dir).
- `src/renderer/src/cards/` — card faces (poster vs live terminal), xterm mount, ask/question toasts.
- `src/renderer/src/orchestrator/` — chat bar, action tracer, confirm toasts, renderer voice glue.
- `src/renderer/src/lib/` — shared renderer utilities and React contexts (icons, theme, springs, `cn()`).
- `src/renderer/src/diff/`, `src/renderer/src/hooks/`, `src/renderer/src/components/ui/` — diff sheet, small hooks, shadcn primitives.

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
and tmux socket `agentcanvas-web` (the Swift app owns `~/.agentcanvas` +
`agentcanvas`). At cutover, repoint these to inherit the production fleet.

## Known gaps

Stall heartbeat (the `stalled` status exists but nothing auto-detects silence),
keyboard navigation, and a live-terminal/WebGL budget (Chromium caps WebGL
contexts at ~16; past that xterm falls back to the slow DOM renderer). Both phone
WebSockets (`/term` and `/orch`) now require the session token as a `?token=`
query param on top of tailnet isolation.
