# Browser Agency v2 — design plan

v1 shipped and works: agents see and control their own browser card via a
loopback HTTP MCP server, the ownership link persists, and the Tier-A driver
(`executeJavaScript` in the renderer) drives the page. v2 makes the driving
**robust** (real input that works in the background, cross-frame, real
accessibility tree), the fleet **sustainable** (lifecycle coupling + a webview
budget), and the capability set **broader** — plus the UX that the ownership link
already earns. (Track C, permission/safety posture, is intentionally **out of
scope** for this pass.)

---

## 0. What v1 left us

The seam to extend (all working):

- **`CommandBus`** (`orchestrator/contract.ts`): `readBrowser` / `actBrowser` /
  `screenshotBrowser` / `navigateBrowser` / `setBrowserReason` / owner-carrying
  `openBrowser`.
- **Transport to the guest** = renderer round-trip: `mainBus` → `dispatch` →
  `Canvas.tsx` handler → `browserBridge` handle → `BrowserView` calls
  `view.executeJavaScript(READ_SCRIPT | buildActionScript)` / `capturePage`.
- **`BrowserSnapshot`** (`shared/types.ts`): the pinned observation. `ref` is
  opaque and snapshot-scoped — **this is what lets the backend change under v2.**
- **Ownership**: `ownerCardId` + `reason` on `CardData` (renderer), `ownerId` +
  `reason` on `RemoteState.cards` (so main resolves "my browser"), persisted via
  `CardRecord`. The agent MCP server (`agentBrowserMcp.ts`) resolves the caller's
  browser from `ownerId`.
- **Known v1 sharp edge**: `request_browser` waits a fixed **700ms** for the
  webview to mount before returning — a heuristic v2 must replace.

Two facts that shape v2 (verified against Electron):

1. **`sendInputEvent` needs the app window focused** → not viable for background
   agents. Real, background-capable input requires **CDP `Input.*`**.
2. **`webContents.debugger` detaches when DevTools opens** on that guest → CDP
   must degrade gracefully to the v1 Tier-A path.

---

## 1. Keystone: the lifecycle & readiness substrate

Everything else depends on this, and it fixes the 700ms sharp edge. Today a
browser card's guest is mounted once and lives forever (`BrowserView` effect
keyed on `cardId`); stacked only toggles CSS visibility. v2 introduces an
explicit **live-state** per browser card and a deterministic **ready** signal.

### Live states
- **`dormant`** — no `<webview>` guest process (its **GL context is freed**).
  Shows the snapshot `BrowserFace`. `CardRecord` (url/owner/reason) persists.
- **`live`** — guest mounted and loaded; holds a GL context (whether master or
  stacked-hidden).
- **`ready`** = live **and** `dom-ready` reached (**and** CDP attached, for Tier B).

### `ensureReady(cardId): Promise<{ webContentsId }>` (main)
The single gate every drive verb passes through:
1. If tracked `ready` → return its `webContentsId`.
2. If `dormant` → send `browser-wake(cardId)` to the renderer (mount the guest +
   load its url), then await the `browser-ready` signal (timeout → typed error).
3. If `live` but mid-load → await the next `browser-ready`.

This **replaces `request_browser`'s 700ms sleep** with a real signal, and is the
prerequisite for both Tier B (needs a live `webContentsId` to attach CDP) and
eviction (wake-on-demand).

### New IPC (app-level, not orchestrator-command)
- renderer → main: **`browser-ready`** `{ cardId, webContentsId | null }` — fired
  from `BrowserView` on `dom-ready` (carrying `view.getWebContentsId()`), and
  `{ ..., null }` on unmount/dormancy.
- main → renderer: **`browser-wake`** `{ cardId }` — mount a dormant guest.

### Touch points
- `BrowserView.tsx`: report `getWebContentsId()` on `dom-ready`; accept a
  `dormant` prop (when true, render only the face, no guest); on wake, mount +
  load + fire ready.
- `preload/index.ts` + `shared/types.ts` (`CanvasApi`): the two new channels.
- New **`BrowserController`** (main, see §2) owns the readiness map + `ensureReady`.

---

## 2. Track A — Tier B (CDP): robust driving

**Why:** background-capable real input (`sendInputEvent` can't), cross-origin
iframes (`executeJavaScript` can't reach them), and the real accessibility tree
instead of a hand-rolled DOM walk.

### `BrowserController` (main) — the unifying object
Replaces the v1 "dispatch to renderer for every op" with: **try CDP in main,
fall back to the Tier-A renderer path.** Constructed in `index.ts` with
`{ dispatch, wake, getWebContentsId-via-ready-map }`. The bus's
`readBrowser`/`actBrowser`/`screenshotBrowser` call into it instead of
dispatching directly.

```
BrowserController.read/act/screenshot(cardId):
  await ensureReady(cardId)
  try   → BrowserCdpDriver (CDP, main, works in background)
  catch → Tier-A fallback (dispatch → renderer → executeJavaScript)   // v1 path, kept
```

So the v1 renderer bridge (`browserBridge.ts` / `browserDriver.ts`) is **not
thrown away — it becomes the fallback** for when CDP can't attach (DevTools open
on that guest, attach race).

### `BrowserCdpDriver` (main, new)
- **Attach**: `wc = webContents.fromId(id)`; `if (!wc.debugger.isAttached())
  wc.debugger.attach('1.3')`; enable `DOM`, `Accessibility`, `Runtime`, `Page`.
  Listen for `'detach'` → mark unattached, reattach lazily next use.
- **read → `BrowserSnapshot`**: `Accessibility.getFullAXTree` → filter to
  interactive roles → `{ ref, role, name, value, state, inViewport }`. Hold a
  per-read `ref → backendDOMNodeId` map on the controller (snapshot-scoped, same
  invariant as v1's `data-canvas-ref`). `text` via `Runtime.evaluate`
  (`document.body.innerText`); scroll/viewport via `Page.getLayoutMetrics`;
  `inViewport` via `DOM.getBoxModel` ∩ layout viewport.
- **act**: resolve `ref → backendNodeId`. **click** = `DOM.getBoxModel` → quad
  center → `Input.dispatchMouseEvent(mousePressed/mouseReleased)`. **type** =
  `DOM.focus` → optional clear (selectAll + `Input.dispatchKeyEvent` Delete) →
  `Input.insertText` → optional `submit` (Enter key event). **scroll** =
  `Input.dispatchMouseEvent` wheel.
- **screenshot** = `Page.captureScreenshot` → PNG data URL. (The demote-time
  thumbnail stays on `capturePage` in the renderer — unchanged.)

**The `BrowserSnapshot` contract does not change** — only `ref` resolution moves
from `data-canvas-ref` to `backendDOMNodeId`. That was the whole point of pinning
it in v1.

### Staging
- **A2a — same-frame**: everything above against the top frame. Delivers
  background real input + the real AX tree immediately.
- **A2b — OOPIF / cross-origin iframes**: `Target.setAutoAttach({flatten:true})`,
  drive child frames by `sessionId`. The genuine reach upgrade; isolated as its
  own step because it's the fiddliest part.

### Risk
Attach/detach lifecycle (handle DevTools-opened detach → fallback), coordinate
mapping for input, AX-tree→snapshot fidelity, OOPIF session plumbing. The Tier-A
fallback de-risks all of it (the system never hard-fails to "can't act").

---

## 3. Track B — lifecycle coupling + eviction

### Lifecycle coupling (small, independent — good first quick win)
- **Close agent → close its browser**: in `Canvas.tsx` `onCloseCard`, when closing
  an `agent`, also close browser cards with `ownerCardId === it`.
- **Orphan handling**: a browser whose owner is gone (after restore, or owner
  closed) is harmless; optionally badge it "orphaned" and offer one-click close.

### Eviction (built on the §1 state machine)
**Why:** each live `<webview>` holds a GL context, and stacked-but-alive guests
**still hold theirs** (v1 keeps them alive for state). At fleet scale this marches
into Chromium's ~16-context cap — **shared with xterm's `WebglAddon`**, so
terminals and browsers compete for the same budget.

- **Policy**: keep live = `{ master }` ∪ `{ most-recently-used browsers up to
  BUDGET }`; the rest go **`dormant`** (guest destroyed, GL context freed, snapshot
  face shown). Budget accounts for live terminals too.
- **Wake-on-demand**: a dormant browser is revived by `ensureReady` (promote, or a
  drive verb targets it) — mount, reload url, await ready. The idempotent
  `request_browser` already re-resolves the same card by `ownerId`, so this is
  seamless to the agent.
- **Cost**: login survives (shared `persist:browser`); scroll/form/in-page JS
  state is lost on dormancy. Acceptable.
- **Touch points**: a small budget policy (in `useProjects` or a new
  `useWebviewBudget` hook) computes the dormant set; `BrowserView` honors the
  `dormant` prop; the GL-budget note in the root `CLAUDE.md` "known gaps" gets
  resolved.

---

## 4. Track D — capability breadth

Each is a small addition on the existing tool seam (`agentBrowserMcp.ts` +
`canvasServer.ts` + a `BrowserAction`/bus method); several get *cleaner* under CDP.

- **`browser_select(ref, value)`** — dropdowns. (Tier-A `<option>` selection is
  awkward; CDP makes it clean.)
- **`browser_upload(ref, paths)`** — file inputs via CDP `DOM.setFileInputFiles`
  (the only sane way; native file dialogs can't be driven otherwise). **Depends on
  A2.**
- **`browser_wait(condition)`** — wait for load / network-idle. The driver already
  sees `did-stop-loading` / can use `Page.loadEventFired`; removes guesswork after
  navigations/clicks.
- **`browser_back` / `browser_forward`** — history nav (the chrome buttons exist;
  expose as tools).
- **Multiple browsers per agent** — `ownerId` becomes owner + **slot**;
  `request_browser(slot, reason)`. Defer unless a real workflow needs two.

---

## 5. Track E — UX polish (renderer-only, low risk)

The ownership link is first-class data — render the relationship:

- **Owner badge → fly-to**: a browser's window bar shows its owner's name as a
  chip; click → `onPromote(ownerCardId)`. Reverse affordance on the agent.
- **Agent ↔ browser tether**: a faint SVG line between an agent's slot and its
  browser's slot, from `layout.ts` `rectFor`, drawn in `Canvas.tsx` (or a
  highlight-the-pair-on-focus, cheaper).
- **Owner poster shows the browser thumb**: `PosterFace` takes an optional
  `browserThumb` (the owned browser's `snapshot`, reverse-looked-up by
  `ownerCardId` in `Canvas`/`CardNode`) — "what my agent is looking at" without
  promoting.

Guardrail (unchanged): **colour = an agent needs you**. Owner/reason stay neutral
chips, never status colour.

---

## 6. Phasing & dependencies

```
Phase 0  Keystone: live-state + ensureReady + browser-ready/wake IPC   ← fixes 700ms; unblocks A & B
Phase 1  Track A2a: BrowserController + BrowserCdpDriver (same-frame, Tier-A fallback)
Phase 2  Track B: lifecycle coupling (can land anytime) + eviction (needs Phase 0)
Phase 3  Track A2b: OOPIF / cross-origin iframes
Phase 4  Track D: select / upload(needs A) / wait / back-forward / (multi-browser)
Phase 5  Track E: owner badge, tether, poster thumb
```

- **Phase 0 is the keystone** — do it first; it pays for itself immediately by
  killing the 700ms heuristic, and both A and B build on it.
- **Lifecycle coupling** (part of Phase 2) is independent and tiny — a fine
  warm-up quick win before Phase 0 if desired.
- A2b, D, E are independent leaves — parallelizable / pick by need.

---

## 7. Risks & decisions

- **Input transport = CDP, not `sendInputEvent`** — decided: `sendInputEvent`'s
  window-focus requirement rules it out for background agents.
- **DevTools conflict** — opening DevTools on a guest detaches CDP. Handled by the
  Tier-A fallback + lazy reattach; acceptable.
- **GL budget is shared with terminals** — eviction must count xterm `WebglAddon`
  contexts, not just browsers. Pick `BUDGET` conservatively.
- **Dormancy loses in-page state** (scroll/forms); login persists. Accept.
- **OOPIF plumbing** is the riskiest sub-task — isolated as Phase 3, and the rest
  ships without it.
- **Controlled-browser banner** — Electron's `webContents.debugger` should not
  show Chrome's "being controlled" infobar (that's chromedriver), but **verify at
  runtime** in Phase 1.

---

## 8. Out of scope (v2)

- **Track C** (permission/safety posture, per-agent login partitions) — deferred
  by choice.
- Cross-agent browser sharing (an agent touching another's browser) — the
  orchestrator keeps the god view; agents stay sandboxed to their own.
- Popups / `window.open` / `target=_blank` (still dropped).
- Bot-detection evasion beyond what real CDP input naturally provides.
</content>
