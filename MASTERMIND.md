# Mastermind — Self-Directing Fleet Architecture

> **Status: design, not yet implemented.** This is the north-star architecture for turning
> agent-canvas's fleet from a set of supervised cards into a self-directing system that heads,
> perpetually, toward a product **vision**. It builds on the proven orchestration protocol from
> the NarraOS `.claude/commands/orchestration` + `orchestrate` systems (file/Linear blackboard,
> prose-plan-vs-tracker split, non-skippable audit gates, `clear-fix`/`needs-decision`
> classification, adversarial multi-lens audits) and lifts it onto a live, visible, parallel
> fleet. The existing `src/main/orchestrator/` (Agent SDK loop + in-process MCP over a command
> bus) is the seam this grows from. **Milestone 1** (the visible per-canvas substrate) and the
> **Milestone 2 worker channel** are now implemented; the roles + mastermind below are the
> remaining build.

## The one idea

A coding-agent fleet that **steers itself toward a product vision**, where the top-level
orchestrator — the **mastermind** — never does any work with its own hands. It does not plan,
write plans, write code, audit, or even flip a status. It **designs an org and staffs it**, then
**trusts the flow** — every role audits its own output before handing it off, so the mastermind
only ever sees *validated milestones* ("plan ready", "sprint ready", "issue done").

The whole system is one loop: measure the gap between the product as it is and the product as the
vision describes it → close the most valuable part of that gap → re-measure → forever. The vision
is an asymptote; it is approached, never reached.

> Two principles carry everything below:
>
> 1. **Trust through structure, not inspection.** Correctness is not policed by a smart overseer
>    (that overseer becomes the bottleneck and the single point of failure). It is an *emergent
>    property of the org chart*: **every role audits its own output — adversarially, via its own
>    subagents — before handing it off**, so nothing reaches the next role (or the mastermind)
>    unvalidated. The mastermind's skill is org design, not oversight.
> 2. **The orchestrator is pure control plane; agents are the entire data plane.** Producing or
>    mutating content (plans, code, audits, fixes, statuses) is the data plane and belongs to
>    agents. Deciding, routing, gating, hiring, firing is the control plane and is all the
>    mastermind ever does. Its hands never touch content.

## The stack — top to bottom

| Layer | What it is | Owned / authored by | Boundary |
|---|---|---|---|
| **Vision** | Per canvas (one product/repo). The purpose, end-state experience, principles/taste, and anti-vision (markdown body). The north star. | **Human** (sole writer) | Never "done" — an asymptote |
| **Sprint** | One outcome-bounded plan. The unit the mastermind reasons over. | Conceived by a strategist, staffed by the mastermind | Done when its **outcome is verified**, never when time elapses |
| **Plan** | The sprint's blueprint: stack, deps, structure. Prose + dependency graph. | The **planner** (later: + framework-expert subagents) | Self-audited by the planner before handoff to the lead |
| **Issues** | The lead's decomposition of the delivered plan into executable DAG nodes. | The **lead** creates; a **worker** owns each | Closed when done *and* self-audited by its worker |

`Vision → Sprints → Plans → Issues` is a single chain. Every sprint cites which part of the
vision it closes; every issue traces up to a plan, a sprint, and ultimately the vision. Every
"is this in scope?" question resolves *upward* to the vision.

## Outcome-based, not time-based

Human sprints are time-boxed because human capacity is fixed and serial: you **fix time and flex
scope**. Agents invert every input — compute is elastic and parallel — so you **fix the outcome
and flex the compute.** A sprint has *no end-date field, no velocity, no time-box*; if there's no
place to put a deadline, no one can smuggle time-thinking back in. The only thing it keeps from
human sprints is scope-coherence: one sprint = one coherent outcome.

This gives the system **two clocks**: each sprint has a hard stop (its verified outcome
converges), while the vision never stops (perpetual gap-closing). Bounded steps, unbounded
direction.

## Vision versioning — the diff is a planning directive

The vision is **version-controlled**: every committed edit produces a new immutable version
(append-only, never mutated in place; "current vision" is a pointer to the latest). This is not
just history — it turns *changes in intent* into first-class events the system reasons about. The
mental model is **git for intent** (commit = version, message = rationale, diff = delta), but
semantic: the diff has consequences the system acts on, and downstream artifacts are *bound* to
versions.

A version holds: the **full body** at that point (a self-contained snapshot, not just a delta),
**timestamp + author** (always the human), a **rationale** (*why* it changed — the context that
makes the new state judgeable), and a **classification** whose downstream impact differs:

- **Clarification** — sharpens wording, no direction change. Invalidates nothing.
- **Redirection** — changes direction. May invalidate in-flight sprints.
- **Expansion** — opens new territory. May spawn new sprints.

**The propagation pass.** A version bump is a first-class event that **re-runs gate #0 across the
fleet** — every in-flight and backlogged sprint is re-verdicted against the new vision *using the
diff*: still-aligned → continue; now-misaligned → pause + escalate or re-plan; newly-needed → the
strategist proposes a new sprint. This is where the turn-1 staleness problem is *solved*: drift is
**detected the moment intent changes**, not discovered sprints later. The vision diff literally
recomputes the planning queue. (The propagation pass is itself adversarially verified — a wrong
"no impact" classification silently strands misaligned work.)

**Binding & coherent alignment.** Every sprint pins the vision version it was conceived under
(`visionVersionRef`); plans and issues inherit it, giving a full provenance chain ("what intent
was this built for?"). When the vision moves, an in-flight agent doesn't re-read the whole vision —
it receives the **specific delta relevant to its issue** ("v8 now favors X over Y; your acceptance
touches Y; re-check"). Coherence comes from every actor knowing not just *current* intent but
*that it changed, why, when, and how it bears on their work.*

**Why this makes planning sublime.** The strategist plans not from "reality vs vision" alone but
with the **trajectory of intent** — the richest planning input there is, letting it anticipate
where the human is heading. Vision edits become steering inputs with legible consequences (you
adjust the north star, the queue recomputes visibly). Alignment is provable; misalignment is
detected.

## The org chart

| Role | Owns / does | Verbs | Never |
|---|---|---|---|
| **Human** | The vision; final authority; court of last resort. | Author/steward vision; arbitrate gap-priority; commit vision amendments. | — |
| **Mastermind** (the orchestrator) | The org. Outcome-based; sees only validated milestones. | `hire(role, brief)`, `fire(agent)`, `observe()` (read-only milestone feed), `escalate(decision)`. Writes only the **fleet** (process lifecycle). | Plan, code, audit, assign, or flip a status. |
| **Strategist** *(optional)* | Reads vision-vs-reality, proposes the next sprint to close the largest-leverage gap. | Gap analysis → next-sprint proposal. | Execute. |
| **Planner** | Researches and **writes the plan**; self-audits it before handoff. Later: framework-expert subagents. | `get_vision`, read, `create_plan`, then **self-audit → deliver**. | Decompose, assign, or touch issues. |
| **Lead** | Decomposes the delivered plan into issues, sets deps, requests workers, assigns; self-audits the distribution. | `create_issue`, `set_deps`, `assign_issue`, `request_workers`, then **self-audit → deliver**. | Write the plan or the vision. |
| **Worker** | One assigned issue at a time; self-audits its work before delivering. | `update_status` (own only), `report_blocker`, `comment`; **self-audit → `done`**. | Touch another worker's issue. |

**Auditing is not a role — it's a step in every role.** Planner, lead, and worker each, as the
final step of their skill, spawn their own **adversarial subagents** to audit their output (the
plan, the issue distribution, the work) *before* handing it off. The mastermind hires no auditor
and gates nothing; it trusts the flow because the audit is built into each role's workflow.

The mastermind's only real intelligence is **how it reacts to a stalled milestone** and **which
gap to close next** — and even those it delegates (the strategist proposes, each role self-audits,
the mastermind only staffs). Everything else is structure.

## What the mastermind sees

The mastermind lives on a feed of **validated milestones** — never the work that produced them.
Each role, after its self-audit passes and it delivers, leaves a green checkmark the mastermind
reads (read-only) and wakes on:

| Signal | Store fact | Mastermind reacts by |
|---|---|---|
| **plan ready** | planner self-audited → `plan.approved` → sprint `APPROVED` | spawn / notify the **lead** |
| **sprint ready** | lead self-audited the distribution + assigned → `EXECUTING` | let it run |
| **issue done** | worker self-audited → `status: done` | tally progress |
| **outcome verified** | all issues done → sprint `DONE` | recognize completion / next gap |
| *(stalled)* | `blocked` / `REALIGNMENT_PENDING` lingering | **escalate to the human** |

It never sees a draft, an in-progress diff, or a self-audit report. Because it ingests only
validated milestones, its context stays **tiny** (org state + the signal feed) — which is exactly
what lets it supervise a *large* fleet without drowning. It operates at milestone altitude, never
raw-work altitude: cheap, robust, and it scales because it refuses to look down.

## The verification gates

A production delivered without a self-audit is the hole through which false success escapes. So
every production in a sprint ends with the producing role auditing its *own* output before handoff
— the four gates live **inside** the roles, not at external checkpoints:

| Gate | Self-audited by | Question | On failure |
|---|---|---|---|
| **#0 Conception** | strategist / human | Does this sprint's outcome serve the **vision**? | Don't start it. |
| **#1 Plan** | **planner**, before handoff | Is the *structure* sound — stack right per current docs, deps coherent, shape valid? | The planner revises. (Cheapest, highest-leverage gate.) |
| **#2 Distribution** | **lead**, before requesting workers | Do the issues *faithfully and completely* cover the plan — no drops, no hallucinated extras, deps preserved? | The lead re-decomposes. (NarraOS `/start` Step 6 proved decomposition drifts.) |
| **#3 Per-issue** | **worker**, before `done` | Is this unit correct and **in-scope** (later-phase gaps are deferred, not blocking)? | The worker fixes; genuine ambiguity → escalate to the human. |
| **#4 Outcome** | **lead**, when the DAG drains | Does the **assembled whole** achieve the outcome? (Parts passing ≠ whole succeeding.) | Fix or escalate; the sprint isn't DONE until it passes. |

Each self-audit is a multi-lens **adversarial** review the role runs over its *own* output —
fresh-context subagents told to *refute* it (find → verify each finding is `real` *and* `inScope`),
the NarraOS `audit-phase` pattern turned inward. The role fixes what survives before delivering; a
genuine `needs-decision` (a tradeoff it can't resolve) is escalated to the human. The mastermind
applies nothing — it only sees the resulting validated milestone.

## The substrate — one store, two faces

Everything above reads and writes **one store**, owned by the Electron main process. A flat JSON
file (NarraOS's first cut) does not survive here: agent-canvas is multi-project, multi-card, and
concurrent, and the store must be *reactive* and *visible*. Main is the single arbiter —
logically each agent owns its own records, physically every write funnels through main, which
serializes them (atomic claims, no races).

The store is projected two ways:

- **IPC → the renderer** = the live, visible board: the `Vision → Sprint → Plan → Issue` tree, the
  dependency DAG, who owns what, statuses flowing, audit gates as distinct nodes, and a
  **"distance to vision"** crown view. This is "make it visible."
- **MCP → the agents** = how the fleet reads assignments and writes status/results/verdicts. The
  agents are real `claude` CLIs in tmux (separate processes), so MCP — not Electron IPC — is the
  sanctioned channel. This replaces the brittle current seam (scraping replies from Stop-hooks +
  transcript JSONL, sending via idle-timed text injection) with structured tool calls.

Same data, two faces. One type definition in `src/shared/` feeds main, the renderer, and the MCP
schema.

### The MCP surface *is* the org chart

The agent-facing MCP server is **role-scoped**, and that scoping *is* the authority model from
the org chart — enforced at the tool layer, not by good behavior. The same `role` flag drives both
the tool grant (capability) and the role's skill (behavior):

- A **planner** has `create_plan` but no `create_issue` — it writes the blueprint, never decomposes.
- A **lead** has `create_issue` / `set_deps` / `assign_issue` / `request_workers` but no
  `create_plan` — it decomposes a *delivered* plan, never authors one.
- A **worker** physically cannot flip another worker's status (its `update_status` is restricted to
  issues it owns).
- The **mastermind** has *zero* issue-mutation tools and no `Edit`/`Write`; it acts only through
  the command bus (hire/fire) and reads the board.
- The **vision** is human-write-only and read by everyone; agents may *propose* amendments, only
  the human commits them.

There is no auditor grant — auditing is each role spawning its *own* subagents, which need no
issue-store tools (they read the work and report back to their parent role).

**Identity is the linchpin.** Each card gets an identity token at launch (injected by
`src/main/spine/` when it spawns the `claude` in tmux). The MCP server authorizes every call by
that identity → role → owned records. No card can spoof another's ownership. Get this right or
the role model is theater.

### Hooks vs MCP — two different signals

Keep these distinct:

- **Hooks = process liveness** (is the card alive, running, waiting). Already wired:
  `src/main/spine/` ingests Claude Code hook events into card status.
- **MCP = work progress** (did the unit advance, pass audit).

The mastermind doesn't read either for *work* — it reacts to the board's **milestone
transitions** (above). Liveness is only its stalled-card detector: a card breathing but producing
no milestone is the cue to escalate.

## Data model (sketch)

Lives in `src/shared/` (source of truth for IPC + MCP payloads). Final shapes TBD.

In agent-canvas **each canvas (project) is a product/repo**, so the whole chain — vision included
— is **per-canvas**: one north star per product (`projectId` keys every record). The store holds
flat arrays the renderer filters to the active canvas.

```
Vision        { projectId, currentVersion }                // per-canvas pointer to latest version
VisionVersion { id, projectId, n, body(md), principles[], antiVision[], rationale,
                class:'clarification'|'redirection'|'expansion',
                author:'human', committedAt }              // immutable, append-only
Sprint        { id, projectId, visionVersionRef, title(short headline), outcome(definition-of-done), state, gapRationale }
Plan          { id, sprintRef, overview, stack[], structure, deps(DAG), nonGoals[], approved } // approved = planner self-audit passed
Issue    { id, planRef, title, description, verify(acceptance), status, owner,
           phase, deps[], labels[], kind:'task'|'audit-gate'|'decision',
           verdicts[], comments[], intentRef }
```

`verdicts[]` is the **self-audit trail** — the producing role records its own audit outcome there,
so the board (and you) can see *that* a role audited and what it found, not just the final status.

**Sprint state machine** (this *is* the mastermind's decision input — "what to do next"):

```
DRAFT → PLAN_REVIEW → APPROVED → DECOMPOSED → EXECUTING → OUTCOME_REVIEW → DONE
         (gate #1)     (gate #1)  (gate #2)               (gate #4)
```

A sprint also passes **gate #0** before `DRAFT` (does it serve the vision?). The mastermind reads
where each sprint sits and reacts by staffing — plan stuck in `PLAN_REVIEW` → re-brief the lead;
`OUTCOME_REVIEW` failed → the whole didn't integrate, re-staff.

## Mapping onto agent-canvas seams

| Concern | Seam |
|---|---|
| Mastermind loop + command bus (hire/fire) | `src/main/orchestrator/` — extend the existing Agent SDK loop + in-process MCP |
| Agent-facing issue MCP server (over local HTTP) | `src/main/remote/` pattern (HTTP+WS server) reused to host it |
| Per-card identity token injection at launch | `src/main/spine/` (launches `claude` in tmux) |
| Card status from hooks (process liveness) | `src/main/spine/` (already ingests hook events) |
| Shared types for store + IPC + MCP schema | `src/shared/` |
| Renderer IPC surface for the board | `src/preload/` |
| The visible board + "distance to vision" view | `src/renderer/src/canvas/` |
| Card ↔ issue link (a card is *who*, an issue is *what*; `owner` links them) | `cards/` ↔ board |

## What this improves over the prior art (NarraOS)

| NarraOS | Here |
|---|---|
| Sequential phases (one session) | Real **DAG** — every dep-satisfied issue fires in parallel across the fleet |
| Blackboard in a JSON file, then Linear | One **main-owned reactive store**, visible and concurrent-safe |
| Invisible (file/Linear comments) | **Visible** live board, canvas-native |
| Blind `kill $PPID` shell phase-runner loop | A **conversational, watchable** mastermind you can talk to (NL + voice) |
| Two-way comms via hook-scraping + text injection | Structured **MCP** tool calls |
| Single active workflow | **Per-project** concurrent sprints |
| Human approves plan + answers `needs-decision` | Each role **self-audits before handoff**; the mastermind staffs and sees only validated milestones; the human owns the vision + escalations |
| No re-grounding | Verifier checks each issue's premise against the live repo before dispatch |

## Honest risks & load-bearing conditions

These are the conditions under which "trust the flow" is *earned* rather than blind:

- **Self-audit independence is the whole ballgame.** A role auditing its *own* output is weaker
  than a separate auditor — even fresh subagents can inherit the producer's blind spots. So each
  role's skill must make the audit subagents genuinely **adversarial and diverse** (told to
  *refute*, multiple lenses), never a rubber stamp. "Trust the flow" holds exactly to that degree;
  the **next role** consuming the output and the **human** are the backstops beyond it.
- **The self-audit must live in every role's skill.** A role whose skill skips or weakens its audit
  step *is* the hole — there's no external auditor to catch it. Skill quality = trust.
- **Vision calibration is the hardest authoring skill.** Too vague → no self-audit can judge "does
  this serve it?" Too concrete → it becomes a finite spec you can *complete*, killing the
  asymptote. State qualities and direction, not enumerated features.
- **A wrong vision (or wrong gap analysis) marches the system confidently in the wrong direction
  forever** — it never stops to question. The vision and gap analysis are the highest-leverage,
  highest-risk artifacts; concentrate the human's scarce attention there, precisely *because*
  everything below is delegated and verified.
- **Vision churn cascades.** Each edit fires a propagation pass; editing too often thrashes the
  queue. Versioning *makes the cost visible* ("this edit invalidated 6 sprints"), which disciplines
  deliberate edits — the risk is partly self-regulating, but the "slowest-changing artifact" rule
  still holds.
- **The edit classification is itself a verdict.** A subtle wording change mis-tagged
  "clarification" can silently strand misaligned work; the propagation pass must be adversarially
  verified, not trusted.
- **Mid-plan version races** — the human commits a new version while a sprint is being planned
  against the old one. Don't lock; **pin** the version the sprint started under and let the
  propagation pass reconcile it after.
- **"Distance to vision" is assessed, not computed** — a recurring independent judgment,
  not a number.
- **Atomic claims** — if workers self-claim ready issues, test-and-set (a real transactional
  store, not a JSON blob) prevents two grabbing one.
- **Identity/auth** is the security spine of the whole role model.
- **Event-driven, not polling** — main emits transitions (`audit-failed`, `phase-done`); the
  mastermind wakes on *verification outcomes*, the renderer re-renders.
- **Cost** — every node becomes a fan-out-and-judge; max-compute is the chosen stance, but the
  mastermind must still be *able* to choose not to fan out for trivial work.

## Open questions

- **Mastermind's failure repertoire.** On a stalled milestone, does it fire-and-rehire the same
  role, escalate, or *restructure* (split a role, strengthen a role's self-audit skill, change the
  loadout)? This — how a board reacts to a failing company — is the only real reasoning the
  mastermind needs.
- **Strategist as a distinct role vs. a mastermind function.** Is gap-analysis a hired agent or
  the mastermind's one act of authorship? (Leaning: hired, to preserve never-by-hand.)
- **TodoWrite.** Kept as an agent's *private* scratchpad for executing one issue; the shared
  issue store is the coordination layer. Two layers, never merged.

## The summary in one breath

You author the vision. A strategist reads the gap and proposes the next sprint. The mastermind
stages the org and trusts the flow — it sees only validated milestones. The planner writes and
self-audits the plan; the lead decomposes and self-audits the distribution; workers execute and
self-audit their work — each spawning adversarial subagents before it hands off. The store holds
all of it, visible to you and controllable by agents over MCP. Your scarce attention concentrates
entirely at the top, *because* every role validates its own output before the next one — or the
mastermind — ever sees it. The product approaches its own vision, forever.
