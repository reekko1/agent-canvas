# Mastermind Learning System — Implementation Plan

Lifts the **probed** core (`probe/`, 28/28 green against the real SDK) into Agent Canvas, and adds the substrate it needs to fire. Companion to `MASTERMIND_LEARNING_MAP.md` (how hermes/SDK/ours work) and `MASTERMIND_LEARNING_DESIGN.md` (the settled decisions). Phased for safety — each phase is independently verifiable, and the learning phases change **no user-facing behavior** (the reactor runs in shadow until the cutover). The only gate is `npm run typecheck` + build (the zero-tooling stance holds — no new linters).

> Grounded against source on 2026-06-21. Every line number below was verified; the probe's vocabulary was reconciled with the real `IssueMilestone` union.

> **Shipped (2026-06-22): no feature flags.** The phased `MASTERMIND_REACTOR_SHADOW`/`_LIVE` env flags below were the *build ramp* and have been removed. The mastermind is simply **on in partner/autonomous mode** (manual suppresses it — the existing mode is the only on/off). A `stalled` worker on an autonomous canvas is driven live in nudge-only latitude; every other judgment milestone is observed so the reviewers learn from it; the curator runs on its idle timer. The "shadow" / "nudge" / "full" names survive only as the reactor's internal per-reaction tool-gate mode, not as user knobs.

## Where it attaches (one seam)

The system hooks at **`src/main/orchestrator/manager.ts:notifyMilestone` (line 219)** — the existing hub that already receives every `IssueMilestone`. It's wired from the store at **`src/main/index.ts:323`** (`issues.onMilestone = (m) => orchestrator?.notifyMilestone(m)`), and emission is **replay-suppressed** at `issueStore.ts:125` (`if (!this.replaying) this.onMilestone?.(m)`; the `replaying` flag is declared at `:86`). Nothing new is invented to "wake" the mastermind; that wire exists.

Principle from the design (deterministic control / LLM judgment):
- **Mechanical routing stays deterministic** in `notifyMilestone` — `issue-assigned → nudge worker` (manager.ts:221-230), `issue-done/blocked → nudge lead` (232-249). Pure routing keyed off a store state-change; it works, we don't touch it.
- **The Reactor adds LLM judgment.** Honest framing: `notifyMilestone` does *only* deterministic routing today — the real judgment (which idea wins) lives in spawned **cards** (the strategist tournament, a separate `claude` CLI), not here. So the reactor is a **new** judgment layer. Its clearest first job is **`stalled`** (a genuine gap — see below), while it *observes* the other judgment milestones (`outcome-verified` → `spawnStrategist` at 297-300; `idea-ready` → spawn planner at 251-273; `idea-abstained` → escalate at 275-295; `plan-ready` → PLAN READY fleet-event at 302-317) in shadow before any decision to replace those branches.
- **Reviewers learn** from the reactor's reaction transcripts. `retire`/`amend`/`issue-blocked` are the **friction** signals that tighten the skill-review cadence.

The Reactor is a **new per-reaction `query()`** (the design's model), *separate* from the long-lived NL-orchestrator session at `orchestrator.ts:97` (a streaming `query()` fed by an async input generator, idling between turns). The orchestrator keeps driving user chat; the reactor is the autonomous head.

## The milestone vocabulary (reconciled with the code)

The real union (`src/shared/types.ts:931-939`) is, **after this plan's additions**:

```
plan-ready | issue-assigned | issue-done | issue-blocked | sprint-ready
| outcome-verified | idea-ready | idea-abstained | stalled | retire | amend
```

- `stalled`, `retire`, `amend` are **added by this plan** (substrate work below). Before it, `stalled` was only a `CardStatus` (types.ts:8, set on a rate-limit `StopFailure`, `claudeEvents.ts:197`), and `retire`/`amend` were issue *actions* with no milestone.
- `sprint-ready` is in the type but **never emitted** — a documented dead kind; leave it until something emits it.

Trigger classification (`triggers.ts`), now all backed by real emissions:
- **CONCLUSIVE** (fire skills review immediately): `{ outcome-verified, stalled, idea-abstained }`
- **FRICTION** (lower the skill backstop 10 → 5): `{ issue-blocked, retire, amend }`
- **Counter-only** (advance memory every-10 / skill backstop): `{ plan-ready, issue-assigned, issue-done, idea-ready }`

`triggers.ts` should **import `IssueMilestone['kind']`** as its `MilestoneKind` — single source of truth, not a re-declared union (the drift this plan exists to fix).

## Substrate work (new — from two settled decisions)

Two decisions during grounding expanded scope; both are settled.

**1. Emit `retire`/`amend` milestones** so the lead's issue-repair actions become first-class friction the reviewers can learn from.
- `src/shared/types.ts:931-939` — add `'retire' | 'amend'` to `IssueMilestone['kind']`.
- `src/main/issueStore.ts` — emit in the `issue.amend` case (`:412`) and `issue.retire` case (`:439`), resolving `projectId`/`sprintId` via the existing `plan → sprint` pattern (`:335-336`). **Capture `issue.owner` before `:449` nulls it** so `ownerId` is populated.

**2. Build stall-detection** so `stalled` actually fires.
- `src/shared/types.ts` — add `'stalled'` to the milestone union; add `assignedAt?: number` to `Issue` (`:710-734`).
- **Heartbeat (the missing piece):** `statusSince` (CardMeta:24 → RemoteState `since`, types.ts:265) updates *only on status change*, so a long `running` task is indistinguishable from a hung one. Add a per-card **`lastEventAt`** (epoch ms) refreshed on **every** hook event in the spine ingestion (`src/main/spine/claudeEvents.ts`) and surface it to main. That is the true liveness signal.
- **Assignment stamp:** stamp `assignedAt = ctx.now()` on `issue.claim` (`:348`, where `owner` is set and status → `claimed`).
- **Sweep:** a `setInterval` in `src/main/index.ts` (mirror the auto-updater pattern at `:174`): for each `claimed`/`in_progress` issue, if its owner card's `lastEventAt` is silent past a threshold, have `issueStore` emit `stalled` (projectId/sprintId/issueId/ownerId) via `this.milestone` (replay-suppressed).
- **Fencing:** stamp the claim's `seq` (the monotonic log counter, `issueStore.ts:148`) onto the claim and carry it on the `stalled` milestone, so a stale worker can't mutate an issue after it's been re-assigned.

## Module: `src/main/mastermind/` (lift from `probe/`)

| Probe file | → real file | What changes on the lift |
|---|---|---|
| `memory.ts` | `mastermind/memory.ts` | `logPath` becomes a fn of store+project: operator → `SPINE_DIR/mastermind/operator.jsonl` (global); product → per-project, keyed by canvas id (today it's the module constant `PROJECT_DIR`) |
| `skills.ts` | `mastermind/skills.ts` | plugin dir → `SPINE_DIR/mastermind/skills/`; types tightened |
| `reviewers.ts` | `mastermind/reviewers.ts` | real `query()` + `getSessionMessages`; drop the probe's `as any` on the message stream; model = Sonnet (own param, no longer shared) |
| `constitutions.ts` | `mastermind/constitutions.ts` | verbatim |
| `triggers.ts` | `mastermind/triggers.ts` | `MilestoneKind = IssueMilestone['kind']`; counters **persisted** in `reactions.jsonl` (the one piece the probe stubbed) |
| `curator.ts` | `mastermind/curator.ts` | run on an idle/interval timer (the updater pattern) |
| `reactor.ts` | `mastermind/reactor.ts` | **add** `mcpServers: { canvas: buildCanvasServer(bus) }` + canvas tool perms (the probe reactor has none — it narrates, never acts); milestone + `bus.openCanvas()` board snapshot as the user message; model = Opus |

`SPINE_DIR = ~/.agentcanvas-web` (`src/main/spine/spine.ts:22`). The probe's deterministic suite (`probe/edges.ts`, 21 checks) ports into the module's test; the LLM probes (`run.ts`, `edges-llm.ts`) stay as `npm run probe` smoke tests.

## Phases (build order)

**Phase A — Substrate. (Adds milestones, nothing consumes them yet.)**
Add `stalled`/`retire`/`amend` to the union + their emissions, `assignedAt`, the `lastEventAt` heartbeat, the stall sweep, and fencing.
- *Verify:* `retire`/`amend`/`stalled` fire in an autonomous run; `npm run typecheck` + build green. User-visible only as new milestones; no behavior wired to them.

**Phase 0 — Land the core. No behavior change. (Safe.)**
Lift `probe/` → `src/main/mastermind/` with real paths, tightened types, the model split, and the per-project memory path. Nothing imports it from the app.
- *Verify:* `npm run typecheck` + the ported deterministic suite green. Zero runtime wiring → zero risk to the live app.

**Phase 1 — Reactor in shadow. (Safe — observe only.)**
Wire `reactor.ts` into `notifyMilestone` for judgment milestones (incl. `stalled`), behind a `MASTERMIND_REACTOR_SHADOW` flag: it runs a real `query()` (canvas MCP available) and *logs its decision* while the deterministic cascade still drives the app.
- *Verify:* each judgment milestone logs a reactor decision; compare to what the cascade did. No user-facing change.

**Phase 2 — Learning on. (Safe — still shadow.)**
Triggers advance persisted counters off `notifyMilestone` (skills event-primary, memory every-10), read the shadow reactions' transcripts via `getSessionMessages`, apply validated plans → memory + skills grow on disk. Recurrence digest from `reactions.jsonl`. Curator off.
- *Verify:* over a few sprints, `operator.jsonl` / per-project product memory / the skill library accrue sensible entries; the next shadow reaction's prompt shows them (absorption). Still no user-facing change.

**Phase 3 — Reactor drives + curator. (The cutover — user decides separately.)**
Flip shadow off: the reactor's `canvas:*` actions execute — **starting with `stalled`** (the genuine gap with no existing handler), then evaluate replacing `outcome-verified` / `idea-*` / `plan-ready` branches case-by-case (shadow logs inform this). Curator runs on fleet-idle + interval. Mechanical routing (`issue-assigned` / `issue-done/blocked`) stays deterministic.
- *Verify:* autonomous runs are driven by the reactor using accrued memory + skills; mechanical routing untouched.

## Cross-cutting wiring

- **Reactions log (replaces "milestone log"):** there is no milestone log — milestones are ephemeral, derived from `issues.jsonl` actions. The reactor writes one record per reaction (milestone + decision + sessionId) to `SPINE_DIR/mastermind/reactions.jsonl`. This feeds the **recurrence digest** *and* holds the **persisted trigger counters** + last-reviewed markers — replay-suppressed exactly like `issueStore` (the `replaying` flag pattern, `:86`/`:125`), so a restart never double-fires a review.
- **Session persistence + isolation:** the reactor `query()` runs with a fixed `cwd` and `CLAUDE_CONFIG_DIR` under `SPINE_DIR/mastermind` so reaction transcripts persist somewhere `getSessionMessages` can read and don't pollute the user's `~/.claude`.
- **Auth:** already handled — the process deletes `ANTHROPIC_API_KEY` (`orchestrator.ts:67`), so reactor + reviewers use the subscription creds (`CLAUDE_CODE_OAUTH_TOKEN` else host `claude login`).
- **Models:** reactor = `claude-opus-4-8` (matches the orchestrator); reviewers = `claude-sonnet-4-6` (cheaper, sufficient). Budgets: operator ~2000, product ~4000 chars.
- **Scoping:** operator memory + skill library global; product memory per-project/canvas.
- **Reactor visual/permission story (open, resolve at Phase 3):** the orchestrator's mutations fly a "comet" from the chat bar + `await landed()`. The reactor has no chat-bar origin — in autonomous mode its canvas actions need either a different visual (e.g. a comet from the affected card) or none.

## Deliberately NOT doing

- Not folding the reactor into the long-lived orchestrator session (per-reaction vs streaming — keep them separate).
- Not replacing the deterministic mechanical routing (`issue-assigned` / `issue-done/blocked`) — it's control, not judgment.
- No FTS5 / recall tool (design §7); the recurrence digest comes from `reactions.jsonl`.
- Not assuming the reactor replaces every deterministic branch — `stalled` first; the rest are shadow-tested before any cutover.
