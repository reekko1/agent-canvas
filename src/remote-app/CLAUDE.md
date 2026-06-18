# remote-app

A standalone phone web client for triaging a coding-agent fleet from a handset on the tailnet. It is **not** part of the Electron app — it has its own Vite build (`vite.remote.config.ts` at the repo root) and is served as static assets by the main process's remote server (`src/main/remote`) over Tailscale. Designed to install as a home-screen PWA on iOS so push alerts work.

## Files

- `index.html` — PWA shell: viewport-fit/apple-mobile meta tags, manifest + apple-touch-icon links, the header (title, needs-you badge, offline pill, "Enable alerts" button), and the `#canvases` / `#feed` mount points. Loads `main.ts` as a module.
- `main.ts` — the panel itself: polls `/state`, groups cards/approvals/questions under their canvas (loudest first), renders tiles, and wires tap actions (answer, allow/deny, pick option, open terminal). Owns CSRF-token fetch/retry and the push subscribe flow.
- `term.ts` — `openTerminal(cardId, name)`: a full-screen xterm overlay bridged to a card's tmux session over the `/term` WebSocket, plus a soft-keyboard accessory bar (sticky Ctrl, Esc/Tab/^C/arrows, scroll).
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
- Auth posture is **tailnet-only**. CSRF token covers the mutation routes, but the `/term` WebSocket has no query-param token yet — it relies on Tailscale network isolation alone. Don't expose this server off the tailnet.
- All request paths are relative (`fetch('state')`, `new URL('term', location.href)`), so the client works under whatever host/base the remote server mounts it at.
- Vanilla DOM, no framework: rendering is string-concatenated `innerHTML` and all interaction is one delegated `click` listener, so it survives the full re-render each poll. Always `esc()` untrusted values before interpolating.
