# mastermind (main)

## Identity: one agent, two execution shapes

The mastermind is **Rakan's always-on personal agent** — it knows Rakan and his
whole world, thinks and brainstorms *with* him, and builds through the coding-agent
fleet (the cards are its eyes and hands; it never touches code itself). Card
orchestration is the moat and its build-arm, not its reason to exist. It is **one
identity** wearing two execution shapes that share the same voice, memory, and
knowledge of Rakan:

- **Orchestrator** (`../orchestrator/`) — the standing conversation: a long-lived
  Agent SDK session the user talks to (chat bar / voice).
- **Reactor** (`reactor.ts`, here) — a per-milestone reflex: a fresh `query()` that
  reads one milestone, decides one control action, and learns from it.

Both read the same operator memory (who Rakan is, global) and product memory (per
canvas). The learning core below is what lets that one agent get sharper over time.

## Scope fence — do NOT build (bias to subtraction)

These are deliberately NOT built. They are real future directions, not oversights —
adding them speculatively is the over-engineering this design pushed back against.

- ❌ No sense/tool **registry**, `ToolManifest`, MCP loader/factory, sense-**installer**,
  hot-load, or per-canvas sense enablement. Self-extension (a fleet-built tool becoming a
  new arm) plugs in at the `[SELF_EXTENSION_HOOK]` in `reactor.ts` — one comment, no
  machinery yet.
- ❌ No `CommandBus` dispatch-unification, `AgentMcp` base class, or skill-store
  unification.
- ❌ No third **"world" memory store** — the world view is **computed on demand**
  (`world.ts`); operator + product memory are the only stores.
- ❌ No mass **rename** of `orchestrator`→`mastermind` (~200 files, cosmetic). Identity
  lives in the prompts/docs, not the module name.
- ✅ When in doubt, subtract. The mastermind is one agent (orchestrator + reactor shapes),
  not a framework.

The mastermind's **learning core** — lifted from the proven `probe/` (see
`MASTERMIND_LEARNING_MAP.md` / `_DESIGN.md` / `_PLAN.md`). It is the self-improving
layer for the autonomous head: a per-reaction **reactor** that decides control
actions over its accrued memory + skills, and two out-of-band **reviewers** that
distill lessons from reaction transcripts into that memory + skill library.

**Status: live, no feature flags.** Wired into `manager.ts:notifyMilestone` and active
in partner/autonomous mode — manual mode suppresses everything (including this), so the
existing mode is the only on/off, by design. On a judgment milestone the reactor runs: a
`stalled` worker on an autonomous canvas is driven LIVE in nudge-only latitude; every
other judgment milestone is OBSERVED (the deterministic cascade drives it; the reviewers
learn from it). Reviewers grow memory + skills on a schedule; skill aging (`ageSkills`)
exists but is **unwired** — the library is empty until the reviewer authors into it, so
there is nothing to age yet (wire a timer in `index.ts` when there is). The substrate it
consumes (`stalled`/`retire`/`amend` milestones) fires from `issueStore.ts`. The module
loads lazily on first reaction.

**Who learns vs who uses:** the **reactor** authors skills (its reviewers) AND loads them;
the **orchestrator** (the agent Rakan talks to, and that drives the cascade) ALSO loads the
same library now, so what's learned actually reaches the agent that acts — and can **author
into it directly**: the `save_skill` canvas tool writes the SKILL.md inline (the orchestrator
is Opus; it drafts the body itself, no skill-creator sub-agent) via the same `applySkill`
arbiter, provenance `conversation`. Both authoring paths (reviewer + save_skill) recycle
through one seam (`fireSkillsChanged`). Because the SDK
can't hot-swap skills mid-session, a skill create/patch fires `setSkillsChangedListener`
(here) → `Orchestrator.notifySkillsChanged()`, which recycles the orchestrator session
(resumed, so the conversation survives) to reload the library. Memory reaches the
orchestrator too, but via `worldContext` injection — no recycle needed for facts.

It also **reaches out proactively**, kept deliberately simple: an idle **heartbeat** timer
(`index.ts`, every 20 min) wakes the orchestrator with its full context already injected
(operator memory + the whole world). The orchestrator decides FOR ITSELF whether anything
needs Rakan — there is no separate judgment model, no cooldown bookkeeping; the agent is
the bar. If something warrants it, it says a line and calls the **`notify_user`** canvas
tool to push it to his phone; otherwise it ends the turn silently. Off in manual.

The design principle throughout: **deterministic for control** (when/whether/where to
fire, budgets, validation, aging), **LLM for judgment** (what's true, what rhymes,
what to merge). The deterministic halves are unit-tested model-free in `edges.ts`
(`npm run mastermind:edges`).

## Files

- **paths.ts** — on-disk layout, decoupled from `spine.ts` on purpose (that module
  pulls in `node-pty` + the remote server) so the deterministic suite runs under tsx.
  Configurable root (`setMastermindRoot`; default `~/.agentcanvas-web/mastermind`, the
  app repoints it, tests redirect to tmp). GLOBAL: `operator.jsonl`, `skills/`,
  `reactor-cwd/`. PER-PROJECT: `products/<projectId>/memory.jsonl`.
- **memory.ts** — event-sourced memory, two stores. OPERATOR is global; PRODUCT is
  per-project (the one structural change from the probe — product fns take a
  `projectId`). Append-only ops → materialize → snapshot; single-arbiter
  `applyMemoryOps` validates the whole batch against final state (per store) within
  budget, then commits atomically. `remove` is just an event → history preserved.
  Budgets: operator 2000, product 4000 chars.
- **skills.ts** — the skill library as real `SKILL.md` files in a plugin dir (the SDK
  `plugins` loader needs files). `applySkill` is a single-arbiter **UPSERT** keyed by name
  (existence decides create-vs-update; `op` is advisory, so a mis-picked op / slightly-off
  target can't reject and silently drop the write — the old patch failure mode). A partial
  refine inherits the omitted field from the existing skill; updates preserve `created_at`
  (+ stamp `updated_at`). archive-never-delete to `.archive/`; usage tracked for curator
  aging. Paths are computed at call time because the root is configurable.
- **constitutions.ts** — the two reviewer system prompts, verbatim from the design §6.
- **triggers.ts** — deterministic reviewer triggers. `MilestoneKind = IssueMilestone['kind']`
  (imported, not re-declared — the single source of truth). Skills = event-primary
  (CONCLUSIVE: outcome-verified/stalled/idea-abstained) + count backstop (10, →5 on
  FRICTION: issue-blocked/retire/amend). Memory = every 10 reactions. Pure; counters are
  persisted by the wiring layer later.
- **reactions.ts** — the wiring layer for triggers: an append-only `ReactionLog` whose
  `record()` projects each milestone onto the per-project trigger counters + the skill
  "episode" / memory "window" session scopes, and computes the recurrence digest the
  memory reviewer reads. Replay-safe (mirrors issueStore).
- **learning.ts** — the learning coordinator: funnels reaction-completions
  (`recordReaction`) AND direct conversation (`recordConversation`) through one serialized
  worker, firing the reviewers on the trigger schedule. The module `manager.ts` / `index.ts`
  actually import to drive learning. Conversation learning is TWO independent reviews over the
  same coalesced window — facts (`reviewMemory`, common) and procedures (`reviewSkills`, rare,
  provenance `conversation`) — kept separate so the proven memory path is untouched and either
  can be tuned alone. A conversation-authored skill recycles via `fireSkillsChanged` (the one
  recycle seam, shared with the reaction reviewer and the orchestrator's `save_skill` tool).
- **curator.ts** — deterministic skill aging (unused 30d→stale, 90d→archived,
  reactivates on use). Skills only — memory self-maintains via the reviewer + budget.
  A pure `ageSkills(now)` function with no cadence/persistence; currently unwired.
- **models.ts** — the model split: reactor = Opus (`claude-opus-4-8`, matches the
  orchestrator), reviewers = Sonnet (`claude-sonnet-4-6`). `ensureSubscriptionAuth`
  drops a stray `ANTHROPIC_API_KEY`.
- **reviewers.ts** — the two reviewers: each a separate `query()` returning a validated
  plan via `outputFormat` (no write tools). Reads in-scope reaction transcripts via
  `getSessionMessages({ dir: reactorCwd() })`. Memory reviewer takes a `projectId`
  (product memory is per-canvas). `persistSession:false`. Both have a transcript-based core
  (`reviewMemory` / `reviewSkills`) reused by the conversation path in `learning.ts` — same
  constitutions, fed a raw transcript instead of session ids.
- **reactor.ts** — a fresh `query()` per milestone. systemPrompt = base identity +
  frozen memory snapshot; user message = the milestone + `bus.openCanvas()` board
  snapshot. Wires the canvas MCP (`buildCanvasServer(bus)` — the real addition over the
  probe, which only narrated) plus the self-authored skills (`plugins` + an EXPLICIT
  `skills: enabledSkillIds()` list of only our `mastermind:<name>` ids — NOT `'all'`, which
  would also pull in the host's `~/.claude` skills and the bundled built-in CLI skills).
  `settingSources:[]` adds isolation (no host CLAUDE.md). (The orchestrator loads the same
  library the same way; see `../orchestrator/CLAUDE.md`.) Latitude is computed per reaction (`observe` by default;
  `nudge` only for a stalled worker on an autonomous canvas): `observe` denies + records
  every mutation, `nudge` also allows `send_to_agent`. Runs in an isolated `reactorCwd()`.
  The canvas MCP is the one built-in arm — `[SELF_EXTENSION_HOOK]` marks where a fleet-built
  arm would later wire in.
- **world.ts** — `computeWorldView`: the cross-canvas "your whole world" synthesis
  (each canvas's vision headline + sprint state + a product-memory clip) the standing
  conversation gets each turn. Pure; no store (computed on demand). Covered by `edges.ts`.
- **edges.ts** — the model-free deterministic suite (45 checks): memory ops/budget/
  recoverability/replay, the operator/product split + per-project isolation, skill
  validation + archive, triggers, the world view, curator. `npm run mastermind:edges`.

## Conventions & gotchas

- **Determinism (replay):** memory + skills are event-logged/file-backed and re-derive
  on read, mirroring `issueStore`. Don't introduce a model call into the control paths.
- **Per-project vs global:** operator memory + the skill library are global; product
  memory is keyed by canvas id. A product op without a `projectId` throws (caught in
  the suite) rather than silently writing to the wrong place.
- **tsx-runnable suite:** keep `edges.ts` + its transitive imports free of the SDK,
  Electron, and native modules (that's why `paths.ts` doesn't import `SPINE_DIR` from
  `spine.ts`). The SDK-backed `reviewers.ts`/`reactor.ts` are typechecked but not run by
  the suite.
- **Auth is inherited:** the orchestrator already drops `ANTHROPIC_API_KEY` at startup,
  so the reactor + reviewers use the subscription creds when wired.
