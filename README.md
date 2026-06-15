# Agent Canvas (Electron rebuild)

Fixed-viewport, master-stack supervision for coding-agent fleets — the Electron
+ React + xterm.js rebuild of the native Swift app at `~/Agents-Canvas`.
That repo's `CLAUDE.md` is the product spec of record; its behavior decisions
(reattach-not-resume, ✕ kills the session, status never persisted, fly-in
releases held permission asks) all apply here.

## Run

```sh
npm install   # also rebuilds node-pty against Electron's ABI (postinstall)
npm run dev   # launch
```

## Package & release

Same conventions as the Swift repo's `Packaging/` (see its `package.sh`):

```sh
npm run dist                                  # ad-hoc dmg+zip in dist/ (local use)
CODESIGN_IDENTITY="Developer ID Application: …" \
NOTARY_PROFILE=canvas-notary Packaging/package.sh   # signed + notarized + stapled
Packaging/release.sh                          # GitHub release on reekko1/agent-canvas
```

The dmg is the first-install artifact; the zip is what `electron-updater`
downloads (it reads `latest-mac.yml` from the latest GitHub release — the
appcast equivalent). Updates only arm in packaged builds (`app.isPackaged`),
and Squirrel.Mac refuses unsigned updates, so never release an ad-hoc build —
`release.sh` enforces this. Never reuse a version; bump `package.json` first.

## Walking-skeleton status

Works end to end: **New Agent → folder picker → real `claude` in a tmux
session → live terminal in the master card → hook events drive card status →
PermissionRequest held with on-card Allow/Deny → clicking the terminal
releases the ask to the native dialog.**

Deliberately isolated from the shipping Swift app so both can run at once:

- config dir `~/.agentcanvas-web/` (spine.json, hooks.json, tmux.conf)
- tmux socket `agentcanvas-web` (the Swift app owns `agentcanvas`)

At cutover, point these back at `~/.agentcanvas` + `agentcanvas` and this app
inherits the production fleet.

## Not yet ported (Phase 2+)

- Reattach at launch (`liveSessions` exists in `tmux.ts`; card ids are
  timestamped so restarts never collide with — or silently attach to — old
  sessions, but nothing re-adopts them yet) and workspace persistence
- Todo checklist (TaskCreate/TaskUpdate/TodoWrite mapping and the
  `~/.claude/tasks/<session-id>/` re-hydration) — budget live terminals to
  ~14: Chromium caps WebGL contexts at ~16 (measured), beyond that xterm falls
  back to the slow DOM renderer
- Fly-to / Tab-to-loud / fit-all, stall heartbeat (running-but-silent ≥5 min)
- Activity feed, remote panel, onboarding
- shadcn/tailwind chrome (skeleton is inline styles)
