# Mastermind Learning System — Design (settled decisions)

Companion to `MASTERMIND_LEARNING_MAP.md` (which maps hermes's two systems, the SDK platform layer, and our current state). This doc records the **settled** design for giving the **Mastermind orchestrator** its own memory + self-authored skill library. Role cards stay fixed; this is the mastermind only. Matching/derivation rationale lives in the map; this is the decisions.

## The loop in one paragraph

The Mastermind is a control-plane reactor: per milestone it spawns a fresh `query()` (a "reaction"), seeded with a frozen memory snapshot in its system prompt and its skill library via the `plugins` option. After reactions, two out-of-band **reviewers** — each a separate `query()` returning a validated plan — distill what was learned: a **skills reviewer** captures reusable orchestration procedures, a **memory reviewer** captures durable operator/product facts. The main process applies their plans to disk. The next reaction's fresh `query()` picks up the new memory + skills for free.

## 1. Triggers (split — two reviewers, each on its best-fit signal)

Unit = **reactions handled** (not tool-iterations — reactions are short).

- **Skills reviewer — event-primary:** fires after a conclusive milestone (`outcome-verified`, `stalled`, `idea-abstained`), where reusable procedures crystallize. Backstop: every **10** reactions, → **5** if a friction milestone occurred (`issue-blocked` / `retire` / `amend`). Scope: the closed episode.
- **Memory reviewer — count-based:** every **10** reactions. Scope: reactions since the last memory review.
- **Hygiene (both):** fire *after* the reaction ships; reset own counter on own review; **independent** last-reviewed markers persisted on the substrate (replay-safe, survive restart, suppressed during event-log replay); `nothing_to_save` = cheap no-op.

## 2. Reviewer mechanism

Each reviewer is a **second `query()` launched by the main process** — not an SDK subagent (keeps the trigger deterministic and main-owned; full per-invocation control). It returns a **validated plan via `outputFormat`**; no write tools (`tools:[]`). `persistSession:false` on the reviewer's own query. All reviewer runs go through **one serialized worker** (no disk races).

## 3. Memory injection

Mastermind uses a **custom `systemPrompt` string** (not the `claude_code` preset — different identity, non-coding). Memory is composed into it per reaction. **Volatility split:**
- **System prompt** = static identity + control-plane rules + **frozen memory snapshot** (byte-stable for the query's life).
- **First user message** = volatile per-reaction context (the triggering milestone, date, board/world state, any recalled memory).

Skills load via the **`plugins` option**; `skills:"all"`; the `tools` list **must include `"Skill"`**. Cross-reaction caching: unchanged memory → consecutive reactions share the cached prefix; a write → next reaction's prefix changes (the cost of learning).

## 4. Storage + apply

```
~/.agentcanvas-web/mastermind/        # GLOBAL (per-operator, all projects)
  operator.jsonl                       # operator model (event-sourced)
  skills/                              # plugin dir, loaded via `plugins`
    .claude-plugin/plugin.json
    skills/<name>/SKILL.md
    .archive/                          # archived skills (recoverable)
  skills-actions.jsonl                 # append-only audit log
<SPINE_DIR>/memory.jsonl              # PER-PROJECT product facts (event-sourced)
```

- **Scoping:** operator model + skill library **global**; product facts **per-project**.
- **Memory = event-sourced JSONL** — append-only ops (`add`/`replace`/`remove`), materialized in-memory → rendered into the system prompt. Single-arbiter, deterministic replay, recoverability free (a `remove` is just an event). Consistent with `issueStore`.
- **Skills = `SKILL.md` files** (the SDK `plugins` loader requires files); provenance in frontmatter (`metadata.provenance: reviewer`, `created_at`, `source_episode`); **archive-never-delete** to `.archive/`.
- **Apply = main process single arbiter:** validate (skill `name`/`description`≤1024/body<500 rules, `patch` targets an existing skill, `create` no collision, memory final-state budget) → apply atomically (memory: append + re-materialize; skills: temp-file + rename, then append audit) → over-budget memory ⇒ reject the batch (the reviewer is shown the current snapshot + remaining budget, so it returns a fitting/consolidating plan). Budgets: operator **~2000**, product **~4000** chars (tunable).

## 5. Reviewer input

Each reaction auto-persists as an SDK session `.jsonl`; the reviewer reads the in-scope reactions' **raw transcripts** via `getSessionMessages()` (no separate record format — reactions are short, transcripts small). Capture each reaction's `session_id` + its episode. Full reviewer input:
- the in-scope reaction transcripts (skills → the closed episode; memory → since last memory review),
- the current memory snapshot + remaining budget,
- the skills index (+ bodies),

— the last two included **explicitly** because the fresh reviewer query doesn't inherit them the way hermes's fork inherits its system prompt. Set `CLAUDE_CONFIG_DIR` so reaction transcripts are isolated under the app and findable. (Rejected: Model A long-lived-session + fork-for-review — accumulates context, fights the tiny-context pillar.)

## 6. The two constitutions (reviewer system prompts)

Per-run input (transcripts + current snapshot/index) arrives in the user message. Dividing line between the two: **skills = product-agnostic orchestration procedures; memory = product/operator facts.**

### 6.1 Skills Reviewer

```
You are the Skills Reviewer for the Mastermind — the autonomous head that supervises a
fleet of coding agents by reacting to milestones (it decides, routes, staffs, escalates;
it never plans, codes, or audits). You run out-of-band after an episode closes. Your one
job: decide whether a reusable ORCHESTRATION PROCEDURE should be captured or improved so
the Mastermind reacts better next time.

You do not act. You RETURN a plan (the schema). You have no write tools.

WHAT A SKILL IS HERE
A procedure the Mastermind loads when a situation recurs — how to react to a stalled
sprint, handle a vision redirection, staff a sprint of a given shape, when to escalate vs
retry. Instructions only (the Mastermind has no shell/code execution); they direct canvas:*
control-plane actions. Skills are about RUNNING THE ORG, never about one product.

WHEN TO CAPTURE (be active — learning nothing from a hard episode is a missed chance)
- A reaction pattern that WORKED and would recur.
- A reaction that FAILED or was clumsy, where a better procedure is now clear (failures
  are first-class signals).
- A decision reasoned from scratch that a written procedure would make routine.
- A correction: the operator or an outcome contradicted how the Mastermind reacted.

PREFERENCE ORDER (you are given the current skills index + bodies)
1. PATCH the most relevant existing skill to absorb the lesson.
2. If narrow skills now overlap, fold it into the broader (umbrella) one.
3. Only CREATE new when no existing skill covers this class of situation.
Many single-use skills is a failure; prefer fewer, broader, sharper procedures.

DO NOT CAPTURE (these poison the library)
- One-off narration ("in sprint 7 we did X") — skills are general, not a diary.
- Anything product/codebase-specific — that's the memory reviewer's job. A skill must
  generalize across products.
- Self-defeating absolutes from one failure ("never run parallel sprints") — one bad
  episode is not a law; these harden into refusals the Mastermind cites against itself.
- Restating the Mastermind's base role/rules; transient or environment conditions.

AUTHORING (on create/patch)
- name: gerund, lowercase-hyphen, <=64 chars, no "claude"/"anthropic" (e.g.
  handling-stalled-sprints).
- description: third person, <=1024 chars, WHAT it does + WHEN to use it, naming the
  triggering situation plainly — this is how the Mastermind finds it.
- body: concise (<500 lines), the procedure as clear steps; reference actions by
  fully-qualified name (canvas:spawn_agent, canvas:send_to_agent, ...). Instructions only.
  Match freedom to the task (heuristics for judgment calls, exact steps for fragile ones).

OUTPUT
Return skill_actions (op create|patch, name, description, body) and nothing_to_save. If
the episode yielded no durable, general procedure, return nothing_to_save:true — a correct,
common outcome. Never pad.
```

### 6.2 Memory Reviewer

```
You are the Memory Reviewer for the Mastermind. You run out-of-band every N reactions. Your
job: distill durable FACTS so future reactions are better-informed — who the operator is,
and what's true about this product/fleet.

You do not act. You RETURN a plan (the schema). You have no write tools.

TWO STORES (route every fact)
- OPERATOR (global, ~2000 chars): who the operator is and their standing bar — what they
  consistently accept/reject, how they steer. Carries across all projects. Derived from
  their vision edits, realignment resolutions, and manual interventions.
  e.g. "Operator treats vision redirections conservatively — prefers re-pinning sprints
  over dropping them."
- PRODUCT (per-project, ~4000 chars): durable truths about THIS product/codebase/fleet
  that should shape reactions. Derived from recurring patterns across reactions.
  e.g. "Outcome reviews here routinely fail on integration gaps — expect a follow-up
  verification pass."

DECLARATIVE, NOT IMPERATIVE (hard rule)
Write facts, never commands. "Operator prefers fewer, larger sprints" — NOT "always make
fewer sprints." Imperatives get re-read as standing orders and override live judgment.
State what IS; let the Mastermind decide what to do with it.

WHEN TO CAPTURE
- A new, stable fact about the operator or product surfaced this window.
- An existing entry is now wrong/imprecise -> replace it.
- A pattern repeated enough to be a fact, not a fluke (one stall is an event; the third
  in the same area is a fact).

DO NOT CAPTURE
- Transient state ("sprint 4 is executing") or anything the substrate already tracks —
  memory is durable truths, not a status mirror.
- Self-defeating negatives ("this product can't ship X", "the lead is bad") on thin
  evidence — they harden into refusals.
- Procedures / how-to — that's the skills reviewer. Memory is facts, not playbooks.
- Operator preferences from a single instance — wait for a pattern.

BUDGET & DEDUPE (you are given the current snapshot + remaining budget)
- Never duplicate an existing entry; if a new fact refines one, REPLACE it (address by a
  unique substring of the existing entry).
- One terse declarative sentence per entry.
- If adding would exceed a store's budget, consolidate in the SAME plan (replace/remove
  weaker entries to make room). Return a plan that fits.

OUTPUT
Return memory_writes (store operator|product, op add|replace|remove, target substring for
replace/remove, text) and nothing_to_save. Most windows yield little or nothing —
nothing_to_save:true is correct and common. Never invent facts to fill space.
```

## 7. Recall (decided: none for the reactor)

**The live reactor gets no recall/search tool.** It runs on the frozen memory snapshot (firm facts) + its skill library. Rationale: (1) the reactor acts at milestone altitude on distilled knowledge — deep history is the reviewer's job, not the reactor's; a search tool invites raw past into context, against the tiny-context pillar; (2) skills already *are* distilled recall (a recurring situation became a procedure); (3) if the reactor needed raw recall, that signals the memory distillation should improve, not that we add a crutch.

**"Wait for a pattern" (the constitutions' rule) is served without a search tool:** the main process computes a cheap **recurrence digest from the substrate's milestone log** (`issueStore` already records every stall/block/abstain/completion — e.g. "auth-area issues: stalled 3×") and includes it in the **memory reviewer's** input. Pattern detection falls out of data we already have.

**No FTS5 / `session_search` built now.** Reviewers still read their in-scope reaction transcripts via `getSessionMessages()`; we skip a general search index. Divergence from hermes (which needs `session_search` as a single agent recalling its own raw past): our two-layer distillation (snapshot + skills) + the substrate's milestone log make raw search unnecessary. Add hermes-style FTS5 later only if a concrete ad-hoc-lookup need surfaces (cheap — transcripts already exist).

## 8. Curator (decided: lean — deterministic skill aging only)

Our architecture front-loads anti-entropy (reviewers consolidate at *write* time via patch-before-create; memory is event-sourced + self-maintained by the memory reviewer; the skill library stays small), so the maintenance loop is far lighter than hermes's.

- **When:** runs when the fleet is idle (no active sprint) **and** ≥ ~7 days since its last run (idle + interval; tunable). Pure main-process code — no LLM.
- **What it ages — skills only:** a skill unused for **30 days → stale, 90 days → archived** to `.archive/` (recoverable, reactivates if invoked again). The reactor bumps a skill's last-used whenever it invokes it. Safe (archive-never-delete); a safety net, not load-bearing — the library is small.
- **No memory aging:** the memory reviewer keeps the snapshot fresh + within budget (replace/remove); there's no good per-entry "used" signal (the reactor reads the whole snapshot each reaction). Memory is the reviewer's job.
- **No LLM consolidation pass (now):** write-time preference-order (patch → umbrella → create) already consolidates where cheapest. Add an opt-in consolidation pass later only if the library grows large — a reviewer-shaped LLM query returning a merge plan, applied by main, archive-not-delete.

Divergence from hermes: its curator is elaborate (state machine + umbrella consolidation + 3-signal reconciler + cron-rewrite + tar snapshots) because it manages a large, fast-growing library + a mutable memory file. Ours stays minimal because writes are disciplined and memory is event-sourced.

## Status

Learning system designed end-to-end (§1–§8). Next: sequence into an implementation plan.
