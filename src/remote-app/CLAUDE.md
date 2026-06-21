# remote-app

A standalone phone web client for triaging a coding-agent fleet from a handset on the tailnet. It is **not** part of the Electron app — it has its own Vite build (`vite.remote.config.ts` at the repo root) and is served as static assets by the main process's remote server (`src/main/remote`) over Tailscale. Designed to install as a home-screen PWA on iOS so push alerts work.

Two views: the orchestrator **chat** (the home view — talk/type to the same shared session the desktop drives, with push-to-talk voice and the manual-mode confirm gate) and the **Fleet** supervision panel (the original triage view, now secondary), switched by a bottom nav. The terminal overlay floats above either.

## Files

- `index.html` — PWA shell: viewport-fit/apple-mobile meta tags, manifest + apple-touch-icon links, the header (title, offline pill, "Enable alerts"), `#chat-view` (log + confirm mount + input bar), `#supervise-view` (`#canvases` / `#feed`), and `#bottom-nav` (Chat | Fleet + needs-you badge). `<body data-view>` selects the visible view. Loads `main.ts`.
- `main.ts` — the shell: the view router (`data-view` + bottom-nav clicks), the push subscribe flow, SW registration, and bootstrap (`initSupervise()` + `initChat()`).
- `supervise.ts` — the Fleet view (extracted from the old `main.ts`): polls `/state` every 2s (unconditionally, so the Fleet badge stays live on the chat tab), groups cards/approvals/questions under their canvas (loudest first), renders tiles, wires its tap actions (answer, allow/deny, pick option, open terminal) on a delegated handler scoped to `#supervise-view`. Tile rendering branches on `kind` (agents carry the status HUD + task; shells/browsers are neutral; a session-less browser tile is **not tappable**). The needs-you count rides the bottom-nav Fleet badge.
- `chat.ts` — the chat view: a streamed message log (append model — `start`/`delta`/`final` update one row, not a full rebuild), an input bar with the working pulse, a mode badge (manual/partner/autonomous), the manual-mode confirm gate sheet, and push-to-talk (press-and-hold the mic). Drives the session over `orch.ts` and plays spoken replies via the vendored `TtsPlayer`.
- `orch.ts` — the `/orch` WebSocket transport (the phone as a second orchestrator client): connect with `?token=`, capped-backoff reconnect, JSON control frames vs binary TTS audio, `sendJSON`/`sendBinary`, and a single `onFrame` dispatch (the only place wire field names are read). Types are the shared `OrchClientFrame`/`OrchServerFrame`.
- `voice.ts` — **vendored mirror** of `src/renderer/src/orchestrator/voice.ts` (`MicCapture` + `TtsPlayer`): pure Web Audio, copied because the remote build can't import desktop-renderer code. Keep rates (16k/24k) + the capture worklet in sync with the source and main's Soniox config.
- `net.ts` — CSRF token cache (`ensureToken`/`dropToken`) + the mutating-`post` helper, shared by `supervise.ts`, `orch.ts`, and the push flow.
- `util.ts` — `$` and `esc` (shared DOM helpers).
- `term.ts` — `openTerminal(cardId, name)`: a full-screen xterm overlay bridged to a card's tmux session over the `/term` WebSocket (now also passes `?token=`), plus a soft-keyboard accessory bar.
- `style.css` — all styling (dark palette, mobile-first). No Tailwind, no CSS vars shared with desktop.
- `vite-env.d.ts` — Vite client type reference only.

## Architecture / data flow

- **State loop:** `refresh()` GETs `/state` every 2s, validates the JSON shape with `isRemoteState()` (a transient `{}` renders an empty panel, not an error), then `render()`. The desktop status palette and the Bot identity icon are hand-copied here as raw hex / inline SVG because this build ships standalone.
- **Mutations:** every tap POSTs to `/decide`, `/answer`, `/decline`, `/subscribe`. Each mutating request echoes a CSRF token (`x-canvas-token`) fetched once from `/token` and cached in `TOKEN`; the token forces a CORS preflight. On 404/401 (desktop restarted and rotated its per-process token) the cache is dropped and the request retried once. In-flight question selections live in `sel` and survive the 2s re-render.
- **Terminal bridge:** `term.ts` opens a WebSocket to `/term?card=&cols=&rows=`, making the xterm a *second* tmux client so it mirrors the desktop live. Messages are JSON: `{i}` input, `{r:[cols,rows]}` resize, `{s:lines}` scroll. There is no local scrollback — the alternate screen is mirrored, so scroll gestures are translated into server-side tmux copy-mode drives (throttled). Auto-reconnects up to 6 times with backoff. Keyboard layout adjusts via `visualViewport`.
- **Push:** "Enable alerts" registers `sw.js`, requests Notification permission, fetches the VAPID key from `/vapid`, subscribes via `pushManager`, and POSTs the subscription to `/subscribe`. Gated behind a user tap (iOS requires install-to-home-screen first).

## Conventions & gotchas

- Separate Vite build (`vite.remote.config.ts`) — do not import desktop renderer code here. The only shared imports are pure `@shared/*` types/helpers.
- **No Electron APIs.** This runs in a plain mobile browser; assume nothing beyond fetch / WebSocket / service-worker / Push.
- Auth posture is **tailnet-only**. The CSRF token covers the mutation routes (`x-canvas-token` header) AND both WebSockets — `/orch` and `/term` now pass it as a `?token=` query param (a WS upgrade can't carry a custom header), closing the old `/term` gap. `/orch` can drive the fleet (prompts that spawn/kill agents, gate decisions), so it must stay token-gated. Don't expose this server off the tailnet.
- All request paths are relative (`fetch('state')`, `new URL('term', location.href)`), so the client works under whatever host/base the remote server mounts it at.
- Vanilla DOM, no framework: rendering is string-concatenated `innerHTML` and all interaction is one delegated `click` listener, so it survives the full re-render each poll. Always `esc()` untrusted values before interpolating.
