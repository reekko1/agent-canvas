# Browser Agency — design plan

Give **agents** (the supervised `claude` CLI cards), not just the orchestrator,
the ability to **see and control** an in-app browser. Each agent self-serves a
private browser card via a single idempotent tool; the canvas renders who owns
which browser and why.

This is the agent-facing companion to the orchestrator's existing
`open_browser` / `navigate_browser` tools. It reuses three patterns the codebase
already owns:

- **Skill staging** (`ClaudeAdapter.stageSkills` → `--plugin-dir`) — the model for
  attaching a capability to every launched card.
- **The hook sink** (`HookSink`: token-scoped loopback HTTP, per-card
  `X-Canvas-Card` header, held connections up to 600 s) — the model for the
  agent-facing MCP transport and the blocking request.
- **The command bus** (`CommandBus` → `dispatch` → IPC → `Canvas.tsx` handler →
  `BrowserView` `goto` nonce) — the model for turning a tool call into a webview
  action.

No new architecture — two more tool surfaces on rails we've already laid.

---

## 1. What exists today

- **Browser card** = an Electron `<webview>` guest (`BrowserView.tsx`), own
  process, shared `persist:browser` session, no tmux/pty/spine. Built imperatively
  once on mount; `hidden` toggles CSS *visibility* so the guest stays live
  offscreen. Already calls `capturePage()` (demote snapshot) and `loadURL()`.
- **Orchestrator → browser**: `open_browser` / `navigate_browser` MCP tools
  (`canvasServer.ts`), `CommandBus.openBrowser/navigateBrowser` (`contract.ts`),
  `mainBus.ts` impl with comet signaling + `landed()` timing, dispatched to the
  renderer where `Canvas.tsx` bumps the card's `goto.nonce` and `BrowserView`
  loads the URL. **One-way, navigate-only** — the orchestrator cannot read pixels,
  read the DOM, or interact with page content.
- **Skills** are materialized into a Claude Code plugin under `SPINE_DIR` and
  attached to every card via `--plugin-dir`; the *whole* plugin goes to *every*
  card (no per-card subset — a deliberate v1 non-goal).
- **Agent isolation**: a card maps 1:1 to a tmux session; agents are separate OS
  processes. Their hooks reach main over loopback HTTP carrying
  `X-Canvas-Card: $CANVAS_CARD_ID` + `X-Canvas-Token`.

---

## 2. The shared backend: `BrowserController`

Write the browser-driving code **once**, in main, keyed by card id. Both the
orchestrator and agents call into it; only the *transport* differs.

```
BrowserController (main)
  screenshot(browserId)        → data URL        (capturePage)
  read(browserId)              → indexed DOM/a11y snapshot
  click(browserId, ref)        → ActionResult
  type(browserId, ref, text)   → ActionResult
  scroll(browserId, dir|ref)   → ActionResult
  navigate(browserId, url)     → ActionResult     (already exists as goto)
```

**Two implementation tiers, same contract:**

- **Tier A (v1)** — renderer-side, reuse the `WebviewTag` handle. A new
  `CommandBus` verb dispatches to `Canvas.tsx`, which calls `view.capturePage()` /
  `view.executeJavaScript(...)` and `reply()`s the result back through the bus
  (the bus is already round-trip: `navigateBrowser` awaits `r.ok`). Works while
  the card is **stacked** (capture/JS don't need visibility). No new dependency.
- **Tier B (upgrade)** — main-side via `webContents.debugger.attach('1.3')` + CDP
  (`Page.captureScreenshot`, `Accessibility.getFullAXTree`,
  `Input.dispatchMouseEvent`/`dispatchKeyEvent`). The renderer reports
  `view.getWebContentsId()` up once on `dom-ready` (alongside the existing
  url/title/favicon reports). Gives the full a11y tree and **true synthetic
  input** for canvas/drag-heavy pages. **The Tier-A contract does not change** —
  only the implementation behind it.

**Observation format** (steal from browser-use): the `read` tool returns an
**indexed list of interactive elements** (set-of-marks) + a compact text
snapshot, not raw pixels. Actions reference an element by an opaque `ref`, which
is far more reliable and cheaper than pixel coordinates. `screenshot` is the
supplement, not the primary channel.

### The `read` snapshot contract

This is the one type that **must not change** across Tier A → Tier B — pin it
first. Design it against what `Accessibility.getFullAXTree` can produce *now*, so
Tier A fills it via injected JS without ever forcing a contract change.

```ts
/** The agent-facing observation. Returned by `browser_read`. */
interface BrowserSnapshot {
  url: string
  title: string
  /** Scroll position + page height, so the agent knows where it is and whether
   *  there is more below/above. All in CSS px. */
  scroll: { x: number; y: number; maxY: number; viewportH: number }
  /** Interactive elements, set-of-marks indexed, viewport-first order. */
  elements: BrowserElement[]
  /** Compact readable text of the page's main content, for read-only
   *  comprehension (the agent often just wants to *read*, not act). Interactive
   *  spots are annotated inline as `[ref=N]` so text and elements cross-reference. */
  text: string
  /** True if `elements` or `text` were capped (see Scoping below). The agent can
   *  scroll or narrow focus and re-read for more. */
  truncated: boolean
}

interface BrowserElement {
  /** Opaque handle the agent passes back verbatim to click/type/scroll. The
   *  controller owns resolution (Tier A: a stamped `data-canvas-ref`; Tier B: a
   *  CDP `backendNodeId`). The agent MUST treat it as opaque — never parse it. */
  ref: string
  /** ARIA/a11y role: 'button' | 'link' | 'textbox' | 'checkbox' | 'radio'
   *  | 'combobox' | 'menuitem' | 'tab' | 'option' | 'switch' | … */
  role: string
  /** Accessible name: aria-label / associated <label> / visible text, normalized. */
  name: string
  /** Current value for inputs/selects/textareas (omitted when empty/N/A). */
  value?: string
  /** Only the flags that are meaningful for this element are present. */
  state?: {
    disabled?: boolean
    checked?: boolean | 'mixed'
    expanded?: boolean
    selected?: boolean
    focused?: boolean
    required?: boolean
  }
  /** Currently within the visible viewport (vs. present but scrolled off). */
  inViewport: boolean
  /** Controller-internal: CSS-px rect for Tier-B input dispatch and
   *  scroll-into-view. Agents ignore it; kept in the type so the schema is
   *  identical across tiers. */
  bbox?: { x: number; y: number; w: number; h: number }
}
```

**Action verbs all key on `ref`:**

```ts
browser_click(ref: string): ActionResult
browser_type(ref: string, text: string, opts?: { clear?: boolean; submit?: boolean }): ActionResult
browser_select(ref: string, value: string): ActionResult          // <select>/combobox
browser_scroll(target: 'up' | 'down' | { toRef: string }): ActionResult
browser_navigate(url: string): ActionResult                        // = existing goto path
```

**Invariants (the part that makes the swap safe):**

1. **`ref` is opaque and snapshot-scoped.** It is valid only for the snapshot
   that produced it; an action that mutates the DOM (or any navigation)
   invalidates outstanding refs. **Always `read` after a mutating action** before
   referencing elements again. (Tier B *may* keep refs stable across snapshots via
   `backendNodeId`, but the contract guarantees only per-snapshot validity — don't
   rely on stability.) A stale/unknown ref → `ActionResult { ok:false,
   reason:'stale-ref' }`, the agent's cue to re-read.
2. **Interactivity predicate is shared by both tiers.** An element is included iff
   it has an interactive role/affordance: `a[href]`, `button`, `input`,
   `select`, `textarea`, `[role=button|link|checkbox|radio|combobox|menuitem|tab|switch|option]`,
   `[contenteditable]`, `[tabindex]:not([tabindex="-1"])`, or an attached click
   handler. Tier A and Tier B must agree on this set, or refs drift between
   implementations. **This predicate is itself part of the contract** — change it
   in lockstep.
3. **Scoping / truncation.** Cap `elements` (default ~150) and `text` (default
   ~8 KB), **viewport-first** so the most relevant marks survive the cut; set
   `truncated` when anything is dropped. Never silently truncate without the flag.
4. **Frames.** v1 reads the **top frame only**. Tier A's `executeJavaScript`
   cannot reach cross-origin iframes; Tier B can via CDP but it's deferred.
   Same-origin same-document content is in scope. Document this so an agent isn't
   surprised by missing in-frame controls.
5. **`screenshot` is a separate verb** returning an image, kept off `read` so text
   reads stay cheap; the agent escalates to pixels only when the snapshot is
   insufficient (e.g. canvas-rendered UI).

---

## 3. Two consumers, one backend

| Consumer | Transport | Why |
|---|---|---|
| **Orchestrator** | existing **in-process** MCP (`canvasServer.ts`) | runs inside main; calls `BrowserController` directly |
| **Agents** | new **HTTP MCP** server in main, modeled on `HookSink` | separate OS process — needs a real transport |

### Agent HTTP MCP server

- Loopback HTTP server in main (sibling to `HookSink`), token-scoped.
- Attached to every card at launch via **`--mcp-config`**, parallel to how
  `--plugin-dir` attaches skills. The config carries the same headers the hooks
  use: `X-Canvas-Card: $CANVAS_CARD_ID`, `X-Canvas-Token: <token>`. So the server
  knows *which card is calling* with zero arguments from the agent — the same
  mechanism `installConfig` already uses for hooks.
- Staged the same way as skills: written up front in `Spine.start()` (no
  sink/port dependency for the file itself), rebuilt each start so edits ship on
  relaunch.
- Could alternatively be bundled into the existing `canvas-skills` plugin
  manifest, but a per-launch `--mcp-config` keeps token/card handling identical to
  the hook path and avoids static-config rigidity.

---

## 4. The agent protocol

**One verb to obtain a browser, then drive verbs.** No discovery tool — ownership
makes it unnecessary.

### `request_browser(reason: string) → { browserId, url }`

**Idempotent per agent.** Resolve the caller from `X-Canvas-Card`:

1. Is there a browser card where `ownerCardId === caller`?
   - **Yes** → update its `reason` (re-request = re-declare intent), return it.
   - **No** → spawn one, set `ownerCardId` + `reason`, return it.
2. **Block** (held HTTP response, like `PermissionRequest`'s 600 s decision
   channel) until the browser card lands, then return `{ browserId, url }`.
   - The "notification" *is* the tool returning — no fragile mid-turn injection.
   - Timeout → `{ ok: false, reason }` so the agent reports a blocker (like a
     denied permission).

Idempotency dissolves the double-spawn race: the link is the source of truth, so
two calls from one agent can't create two browsers.

### Drive verbs (per §2)

`browser_screenshot`, `browser_read`, `browser_click`, `browser_type`,
`browser_scroll`, `browser_navigate` — all implicitly scoped to the caller's
owned browser (no `browserId` argument needed; resolved from the header). They
fail cleanly if the agent has no browser yet ("call `request_browser` first").

**The full agent loop:** `request_browser(reason)` → `read` → act → `read` …

---

## 5. Data model

Add to the browser card's `CardData` (`src/renderer/src/cards/meta.ts`):

- **`ownerCardId?: string`** — the agent card that owns this browser. The binding
  the MCP resolves on every call. Absent for browsers opened by the orchestrator
  or by hand.
- **`reason?: string`** — the agent's stated intent, rendered on the window bar.
  Updatable via re-request.

Both flow through the spawn payload (`spawnBrowser` dispatch) and the existing
`onNavigate`-style report path so they persist with the workspace snapshot.

---

## 6. Spawn flow: orchestrator-brokered, with fallback

`request_browser` needs a browser to exist. The MCP server is in main and *can*
spawn directly (`dispatch({ cmd: 'spawnBrowser' })`, the same path
`mainBus.openBrowser` uses). Routing through the orchestrator is a deliberate
choice for supervision + placement:

```
request_browser(reason)
   │
   ├─ orchestrator live?
   │     yes → orchestrator brokers the spawn (action tracer shows it;
   │            sane placement/naming; optional human confirm)
   │     no  → BrowserController spawns directly (no hard block when the
   │            orchestrator isn't running — it no-ops without Agent SDK auth)
   │
   └─ hold response until the browser card lands → return { browserId, url }
```

Either way the agent sees one synchronous call. Brokering buys oversight when
available; direct-spawn guarantees the agent never dead-ends.

---

## 7. UI-UX the ownership link unlocks

The binding is first-class data, so the canvas can render the relationship:

- **Window bar = provenance.** `«owner name» · «reason»` instead of bare host.
  The supervisor sees *who* opened each browser and *why* — triage at a glance.
- **Owner badge → fly-to.** Click the owner chip on a browser to fly to its
  agent (and a browser affordance on the agent poster to fly back). Provenance
  becomes navigation.
- **Visual tether.** A faint canvas edge between an agent and its browser, or a
  paired highlight on focus — the supervisor sees the graph of who has eyes on
  the web.
- **Owner poster shows the browser thumb.** The agent's `PosterFace` can surface
  its browser's `snapshot` — "what my agent is looking at" without promoting.
- **Lifecycle coupling.** Closing the agent closes its linked browser (the
  kind-aware close path already exists; the link tells it what to take). A browser
  whose owner died renders as "orphaned."

**Guardrail:** keep the **colour = an agent needs you** rule. Owner name + reason
are neutral text/chips, never status colour — a busy browser must not masquerade
as an attention signal.

---

## 8. Open decisions

- **Login isolation.** Per-owner partition (`persist:browser-<ownerId>`) makes
  each agent's cookies its own — natural now that ownership is explicit. Cost:
  agents don't inherit your existing logged-in session. **Default shared vs.
  isolated is a real call;** the link makes either trivial to wire.
- **WebGL budget.** N agents × one webview each marches toward the ~16 GL-context
  cap. The link enables the fix: **evict/suspend** a browser whose owner is idle,
  and let the idempotent re-request re-spawn it on demand. Decide the eviction
  policy (idle timeout? LRU past a cap?).
- **One browser per agent** assumed for v1. If an agent ever needs two, the link
  becomes a slot map (`request_browser(slot, reason)`). Don't build it now.
- **Cross-agent visibility.** Dropping discovery means an agent can't touch
  another agent's browser — good isolation. The **orchestrator keeps the god
  view** (`list_world` sees every browser), so cross-agent access, if ever needed,
  lives at the supervisor tier.

---

## 9. Phasing

0. **Pin `BrowserSnapshot` + the interactivity predicate** (§2). Land the type and
   the shared element-inclusion rule before any implementation, so Tier A and
   Tier B are written against the same contract.
1. **`BrowserController` (Tier A)** + extend the orchestrator's MCP with the drive
   verbs (`screenshot`/`read`/`click`/`type`/`select`/`scroll`). Proves the
   backend with the easy consumer first. Renderer reports `webContentsId` up
   (sets up Tier B).
2. **Agent HTTP MCP server** modeled on `HookSink` + `--mcp-config` staging
   modeled on `stageSkills`. Token + `X-Canvas-Card` scoping.
3. **`request_browser`** — idempotent ownership resolution, held response,
   orchestrator-brokered-with-fallback spawn. Add `ownerCardId` + `reason` to
   `CardData`.
4. **UI-UX** — window-bar provenance, owner badge fly-to, lifecycle coupling.
5. **Tier B (CDP)** — swap `BrowserController` internals to
   `webContents.debugger`; full a11y tree + true input. Contract unchanged.
6. **Hardening** — login-partition decision, WebGL eviction policy.

---

## 10. Out of scope (v1)

- Per-card *skill* selection (still a non-goal).
- Multiple browsers per agent.
- Agents reaching browsers they don't own.
- Popups / `window.open` / `target=_blank` (already dropped in the browser card).
</content>
</invoke>
