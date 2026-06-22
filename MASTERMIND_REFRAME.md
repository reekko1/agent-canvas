# Mastermind Reframe — Committed Implementation Plan

**Status: EXECUTED ✓ (all 5 phases).** Landed on branch `feat/mastermind-substrate`, working-tree (uncommitted). Each phase gated green: `npm run typecheck` + `npm run build` + `npm run mastermind:edges` (44/44) + the relevant live smokes (`observe`, `live`, `learn`, `operator`, `reachout`). Open decision resolved: **all three orchestrator modes kept** (manual/partner/autonomous), clarified in prompt/docs rather than collapsed — no migration, no capability loss. Goal met: two birds — **(A) simplify/subtract** *and* **(B) realize the always-on personal-agent architecture** — in one pass. Companions: `MASTERMIND_LEARNING_{MAP,DESIGN,PLAN}.md` (the learning core's history).

> Execution notes (what landed beyond the literal spec): added a `mode` field to `Reaction` so `manager` branches on the latitude the reactor computed (single source of truth); added permanent deterministic coverage of `world.ts` to `edges.ts` (38→44 checks); added `RemoteServer.pushNote` + a `pushToPhone` dep for backgrounded-phone reach-out. `settingSources:[]` removed from the reactor only (reviewers keep it). The two future-seam markers landed: `[SELF_EXTENSION_HOOK]` (`reactor.ts`) and `[WORLD_INFLUENCE_HOOK]` (`world.ts`).

> **Correction (post-build):** Phase 2's "remove `settingSources:[]` from the reactor (cargo-cult)" was **wrong** and has been reverted — `settingSources:[]` is back on both the reactor and the orchestrator. Skill scoping resolved cleanly: both load `plugins: [mastermind]` with an **explicit `skills: enabledSkillIds()` list** of only our `mastermind:<name>` ids (NOT `'all'`). `'all'` enables every *discovered* skill — the operator's `~/.claude` skills (e.g. `graphify`) AND the ~14 bundled built-in CLI skills (code-review, simplify, loop…); the explicit list hides all of those (verified functionally — a listed plugin skill invokes, unlisted ones are hidden + rejected). `settingSources:[]` is belt-and-suspenders (no host CLAUDE.md). The list is recomputed each `query()`, so the recycle picks up new skills. (An earlier note here wrongly claimed explicit lists can't match plugin skills — that was a model-self-report artifact; the init message lists *discovered* skills regardless of the filter, so verify functionally, not via init.)

> **Phase 4 revised (post-review, operator call): no judgment model.** The first cut had a separate Sonnet "is this worth interrupting Rakan?" bar (`reachout.ts` + `shouldReachOut`) — rightly flagged as over-engineering ("a committee to send a notification"). Replaced with the simplest correct shape: the 20-min idle timer is now a **heartbeat** (`Orchestrator.heartbeat()`) that just wakes the orchestrator — which already gets operator memory + the whole world injected every turn — and lets IT decide, in-context, whether anything needs Rakan. The reach-out arm is a real **`notify_user` canvas tool** (web-push to the phone) the agent calls whenever it judges fit. Deleted: `reachout.ts`, `reachout-smoke.ts`, `mastermind:reachout`, and the cooldown/situation-builder machinery in `manager`. The "learned bar" survives — it's the agent's own judgment over its injected context, not a second model. Deterministic control = the timer + manual/mid-turn guards; judgment = the agent.

## North star (the agreed final form)
The mastermind is **Rakan's always-on personal agent** — *one identity*, two execution shapes:
- **Orchestrator** — the standing conversation (chat bar / voice), long-lived SDK session.
- **Reactor** — a per-milestone reflex (fresh query), sharing the same voice + memory.

It **knows Rakan and his whole world** (cross-canvas), **thinks and brainstorms WITH him**, and **never touches code** — it is a **conductor**; the role-card fleet are its **eyes and hands**. Card orchestration is the moat and its build-arm. It **reaches out proactively** (chat + phone) on a bar **learned from the relationship**, not a hardcoded dial. Self-extension (build a tool via the fleet → it becomes a new arm) is a **future** direction.

## Hard guardrails (the fence — do NOT build)
- ❌ No sense/tool **registry**, ToolManifest, MCP loader/factory, sense-**installer**, hot-load, per-canvas sense enablement, CommandBus dispatch-unification, AgentMcp base class, or skill-store unification. **All future.** At most one comment marking where self-extension plugs in.
- ❌ No third **"world" memory store** — the world view is **computed on demand**.
- ❌ No mass **rename** of `orchestrator`→`mastermind` (~200 files, cosmetic). Fix identity (prompts/docs), not the name.
- ✅ Bias every change to **subtraction**.

---

## Phase 1 — Identity unification *(prompts + docs only; zero behavior change)* — VERIFIED ✓
Lift the ceiling: the agent stops thinking it's an app-operator and becomes Rakan's agent.

- **`orchestrator.ts` `SYSTEM_PROMPT` (15–17):** app-centric → operator-centric. *"You are Rakan's always-on mastermind — orchestrator, strategist, and advisor in one. You know Rakan and his whole world… you think WITH him, never touching code yourself. Building via the role-card fleet is your signature move: cards are your eyes and hands…"* Retain the tool/mechanics paragraphs (18–23).
- **`orchestrator.ts` (24–25):** voice = "his thinking partner, not a chipper assistant — sharp enough to push back."
- **`orchestrator.ts` cascade section (~29):** "MASTERMIND CASCADE" → "ORCHESTRATION CASCADE — you orchestrate the role-card fleet, your thinking partners"; reframe "you never audit" as delegation-via-partnership.
- **`orchestrator.ts` `operatorContext()` label (~41):** "WHAT YOU KNOW ABOUT THE OPERATOR" → "ABOUT RAKAN". *(Note: this function is replaced in Phase 3 — keep the rename consistent there.)*
- **`reactor.ts` `BASE` (22):** "autonomous head that supervises a fleet" → "one reflex of Rakan's always-on mastermind — the same agent who orchestrates the fleet."
- **`constitutions.ts`:** `SKILL_CONSTITUTION` (3) + `MEMORY_CONSTITUTION` (19) — drop "supervises a fleet"; "Rakan's mastermind — the always-on agent that…".
- **`src/main/mastermind/CLAUDE.md`:** add an **"Identity: one agent, two execution shapes"** section (orchestrator = standing conversation; reactor = per-milestone reflex; shared voice/memory/knowledge of Rakan).
- **`src/main/orchestrator/CLAUDE.md`:** reframe the header + modes lines to "Rakan's always-on agent's standing conversation."
- **`manager.ts` comments** (REACTOR_JUDGMENT ~75, learnFromConversation ~171): keep consistent with the unified identity.
- **One future-seam comment** `[SELF_EXTENSION_HOOK]` (in `reactor.ts` or `skills.ts`) marking where a fleet-built tool would later become an arm.

*Verify:* `npm run typecheck` + `build`; a quick chat sanity-check that tone/behavior is unchanged (identity only).

## Phase 2 — Reactor latitude simplification *(breaking OK)* — corrections folded in
Subtraction in the autonomous mind. **Scoped to the reactor** (orchestrator modes are NOT removed — see Open Decision).

- **`reactor.ts` `ReactorMode` (36):** `'shadow'|'nudge'|'full'` → **`'observe'|'nudge'`**. Delete the `'full'` variant.
- **`reactor.ts` `LATITUDE` (55–60) + `isToolAllowed` (46–51):** drop the `full` branch; rename `shadow`→`observe`.
- **`reactor.ts` `runReaction` (73–110):** **compute the mode internally** from `(milestone.kind, isAutonomous)` — `observe` by default, `nudge` when `kind==='stalled' && isAutonomous`. Keep an optional `opts.mode` override **only** so the smokes can force a mode. Caller (`manager.ts:runMastermindReaction` ~370–393) passes `isAutonomous`, not a mode.
- **`reactor.ts` (106):** **remove `settingSources: []`** — cargo-cult isolation from when this was a separate system; it's the host's own agent now.
- **`reactor.ts` top docstring (1–12):** drop "partner/autonomous only" → "autonomous mode only" wording where the reactor's live path is described.
- **Grep before renaming:** `grep -rn "'shadow'\|'full'\|mode:" src/ --include="*.ts"` and update every hit:
  - `edges.ts` `toolGateSection` (122–136): `(shadow/nudge/full)` → `(observe/nudge)`; delete the `full` checks.
  - `shadow-smoke.ts` → **rename to `observe-smoke.ts`**; `mode:'shadow'` → `'observe'`; update docstring; **`package.json` `mastermind:shadow` → `mastermind:observe`**.
  - `learn-smoke.ts` (mode arg ~32 + docstring), `live-smoke.ts` (docstring).
- **`src/main/mastermind/CLAUDE.md`:** any "shadow" mode references → "observe".

*Verify:* `typecheck` + `build` + `npm run mastermind:edges` (gate checks now cover observe/nudge) + `mastermind:observe` + `mastermind:live`.

## Phase 3 — "Your whole world" synthesis *(compute-on-demand; NO new store)* — corrections folded in
Give the agent a cross-canvas view of everything Rakan is building, injected each turn.

- **NEW `src/main/mastermind/world.ts`:** `computeWorldView(canvases, issueSnapshot, getProductSnapshot)` → a terse string ("you have 3 canvases building, 1 in review, 2 stalled…", each with its vision + state). Pure synthesis. One future-seam comment at the bottom (bidirectional operator influence — note only).
- **`contract.ts` `CommandBus` (~142):** add `worldContext(): Promise<string>` — assembles the open-canvas snapshot **+ operator memory + cross-canvas world** into one block.
- **`manager.ts`:** add `issueSnapshot` to **`MainBusDeps`** (it exists on `OrchestratorDeps` ~43 but is **not** threaded to `MainBusDeps`); pass it in the `makeMainBus(...)` call (~615).
- **`mainBus.ts` (`makeMainBus` ~156–378):** implement `worldContext()` — guard `getState()` null; iterate `state.canvases`; per canvas read `snapshot('product', id)`; call `computeWorldView`; prepend `openCanvas()` + operator memory.
- **`orchestrator.ts` UserPromptSubmit hook (~138):** `additionalContext: await bus.worldContext()` (one call). **Delete `operatorContext()`** (35–45) — folded into `worldContext()`.

*Verify:* `typecheck` + `build`; in a multi-canvas session the injected context shows the world summary; per-canvas product memory stays isolated.

## Phase 4 — Proactive reach-out *(the one real new capability; keep it small)* — corrections folded in, scope tightened
The mastermind initiates, on a **learned** bar — not a hardcoded dial.

- **Wake:** a modest idle `setInterval` in `index.ts` (mirror the stall-sweep / curator timer pattern; cleared in `before-quit`).
- **Learned bar (the core):** a small judgment that reads **operator memory + the current situation** and decides "is this worth interrupting Rakan?" — a light model call, *not* a hardcoded threshold and *not* an inert placeholder. New `src/main/mastermind/reachout.ts` (smallest correct thing).
- **Reach-out path:** `manager.ts` gains a method to inject a proactive line into the input queue (so the orchestrator speaks it in its own voice) and/or fire phone push via the existing `remoteEmit` / web-push seam. Guard: skip in `manual` mode.
- **Deconflict:** do **not** thread `getOperatorSnapshot` into `SYSTEM_PROMPT` — operator memory already reaches the orchestrator via the Phase-3 `worldContext()` hook. The reach-out judgment reads operator memory directly.

*Verify:* `typecheck` + `build`; a smoke that, given seeded operator memory + a situation, the bar fires/declines sensibly; manual mode stays silent.

## Phase 5 — Cleanup + scope fence *(comment-only subtraction)* — VERIFIED ✓
- Strip stale **Phase 1/2/3**, **flag-gated**, **cutover**, **Phase A** language from headers/comments: `manager.ts` (REACTOR_JUDGMENT jsdoc, notifyMilestone inline), `learning.ts` header, `reactor.ts` `ReactorMode` jsdoc, `learn-smoke.ts`/`live-smoke.ts` headers, `triggers.ts` header, `models.ts`.
- Land the **future-seam** comments (self-extension; bidirectional operator influence) — markers only.
- Record the **DO-NOT-BUILD fence** (above) in `mastermind/CLAUDE.md` so scope can't creep.

*Verify:* `typecheck` + `build` (comment-only; no logic touched).

---

## Sequencing & gate
Execute **1 → 5 in order** (each leaves the tree green). Identity first (everything reads cleaner once it knows what it is); world before proactivity (the bar wants the world view); cleanup last. **Gate after every phase:** `npm run typecheck` + `npm run build` + `npm run mastermind:edges` + the relevant smokes. The zero-tooling stance holds (no new linters).

## Open decision (yours)
**Orchestrator modes.** The audit's spec wanted to *delete* `partner` (collapse to manual + autonomous) — but that's a capability loss (human-originated-but-assisted) + a config migration, i.e. churn, not cleanup. **Recommendation: keep all three** and just clarify in prompt/docs that modes govern *how much the mastermind acts on the fleet unattended* — it is always present, always learning, in every mode (manual included). If you'd rather truly collapse to two, say so and I'll add the migration; otherwise Phase 2 leaves the three modes intact.
