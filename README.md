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

## What it does

A folder of work becomes an agent card: **New agent → folder picker → real
`claude` in a tmux session → live terminal → hook events drive the card's
status and self-published checklist → a held PermissionRequest shows on-card
Allow/Deny (engaging the terminal releases it to the native dialog).**

The canvas is a **fixed-viewport master-stack**: the focused card runs large as
a live terminal while the rest sit as compact poster cards in a scrollable
column — click one to promote it. Cards are grouped into **projects** (named
canvases) switched from the top toolbar; right-click a card to move it between
them. Diffs open as a collapsible side sheet. Every card across every project
stays attached to its tmux session, so switching, moving, and relaunching never
lose scrollback.

Also working: layout + project persistence with reattach-not-resume on
relaunch (`tmux new-session -A`), the self-published todo checklist (re-hydrated
from `~/.claude/tasks/<session-id>/`), the activity feed, the Tailscale
remote/phone panel, the setup gate (claude + tmux readiness), and
signed/notarized auto-update.

Deliberately isolated from the shipping Swift app so both can run at once:

- config dir `~/.agentcanvas-web/` (spine.json, hooks.json, tmux.conf)
- tmux socket `agentcanvas-web` (the Swift app owns `agentcanvas`)

At cutover, point these back at `~/.agentcanvas` + `agentcanvas` and this app
inherits the production fleet.

> The canvas was rebuilt from an infinite ReactFlow board to this master-stack
> model — `REFACTOR_PLAN.md` has the full phased record.

## Not done yet

- **Stall heartbeat** — flag a card running-but-silent for ≥5 min. The
  `stalled` status exists but nothing auto-detects silence.
- **Keyboard navigation** — Tab-to-next-loud-card.
- **A live-terminal budget** — every card across every project keeps a live
  xterm, and Chromium caps WebGL contexts at ~16; past that xterm falls back to
  the slow DOM renderer, so large fleets need a cap or an LOD strategy.
