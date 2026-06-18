# remote (main)

The phone-facing backend run inside the MAIN process: a loopback HTTP+WebSocket server that serves the bundled mobile panel, exposes the supervision state snapshot, accepts approve/answer/decline decisions, bridges mobile terminals to tmux, and delivers web-push pings when an agent newly needs the user. Fronted by `tailscale serve` for TLS + tailnet identity; the spine wires up the callbacks and feeds it state.

## Files

- `remoteServer.ts` — `RemoteServer`: the HTTP+WS server. Routes, CSRF token, port pinning, `/term` WebSocket bridge, push-trigger logic, static file serving.
- `notify.ts` — Pure `composeAskNotification(state, fresh)`: builds the push title/body from the items that newly need you. Title = which canvas + what it wants; body = the actual ask. No transport here.
- `push.ts` — `PushService`: VAPID keypair + the set of installed-PWA subscriptions, persisted to disk; fans notifications out and prunes dead endpoints.
- `readiness.ts` — Environment probes (not part of the server). `checkAppReadiness` (claude/tmux/brew on PATH, orchestrator auth, voice key) and `checkRemoteReadiness` (tailscale CLI present, `tailscale serve` proxying our port, the resolved tailnet URL).

## Architecture / data flow

The server binds **loopback only** (`127.0.0.1`); reachability is deliberately a proxy's job (`tailscale serve --bg localhost:<port>`). The renderer pushes `RemoteState` snapshots in via `publish()`; the server keeps the JSON for `GET /state` and the live object for in-main readers (the orchestrator) via `getLatestState()`.

Phone client flow: `GET /` serves the bundled mobile app from `out/remote` (sibling of `out/main`), installable as a PWA. It polls `GET /state` for the snapshot, and POSTs decisions to `/decide {id, allow}`, `/answer {id, answers}`, `/decline {id}`. Each decision is routed through the spine's `onDecide` / `onAnswer` / `onDecline` callbacks — same authority as the in-app toasts. `/subscribe` registers a web-push device.

Web-push flow: `GET /vapid` hands the page the public key for `pushManager.subscribe`; the resulting subscription is POSTed to `/subscribe` and persisted by `PushService` (mode 0600 — it carries the VAPID private key). On each published state, `maybeNotify` diffs the actionable ask/question ids against those already pushed, and pings only the new ones — and only while the desktop window is NOT focused. The first snapshot just seeds the set (no startup burst). Dead endpoints (404/410) are pruned on send.

CSRF/auth posture: a per-session token (`randomBytes(16)`) gates the four mutating routes (`/subscribe`, `/decide`, `/answer`, `/decline`). The panel fetches it once from the unauthenticated `GET /token` and echoes it as the `x-canvas-token` header; the custom header forces a CORS preflight, closing the simple-request cross-origin hole. A token mismatch returns an opaque **404**, not 401/403, so a probe can't confirm the route exists. There is no Origin check — `tailscale serve` fronts an https origin, which a loopback Origin check would break.

`/term` tailnet-only gap: the terminal WebSocket (`/term?card=&cols=&rows=`) is **not** covered by the CSRF token — it has no auth beyond being reachable only on the tailnet. The card id is validated against `/^[\w-]+$/` at the trust boundary (it reaches tmux as a `-t` target and inside an `if-shell` string, so shell/tmux metacharacters are refused). Server→client frames are raw pty output; client→server frames are JSON (`{i}` input, `{r:[cols,rows]}` resize, `{s}` scroll). A 30s ping/pong heartbeat reaps half-open sockets so the tmux client + pty don't leak.

Port pinning: `start()` prefers a stable port so a `tailscale serve` route survives restarts. On `EADDRINUSE` it retries the held port (20× at 500ms ≈ 10s) through a dying old process before conceding to an ephemeral port (`listen(0)`).

## Conventions & gotchas

- **Never expose publicly** (Funnel, port-forward): the buttons approve arbitrary tool calls on this machine. Loopback + tailnet only.
- `notify.ts` is pure and transport-free on purpose — keep message composition out of `RemoteServer` and delivery in `PushService`.
- VAPID `sub` must be a real `mailto:`/`https:` (Apple APNs rejects `@localhost` with 403 BadJwtToken).
- `serve status` parsing finds the route block matching *our* loopback port — the first https URL in the output may be someone else's route. Don't simplify to "first URL".
- `readiness.ts` probes absolute install paths for tailscale/tmux/brew because a GUI app's PATH has none of them; claude is probed via the login shell (`SHELL -lc`) to match how a card actually launches the agent. Auth probes test existence only (no Keychain read prompt); a stray `ANTHROPIC_API_KEY` does NOT count as orchestrator auth.
- `this.push` and the spine callbacks are optional — absent, the panel still works, just without notifications or that action.
- Static serving normalizes and confines paths to `staticDir`; a missing build returns a hint page (run `npm run build:remote`), not a blank 404.
