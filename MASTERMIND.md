# Mastermind — Self-Directing Fleet Architecture

> **Status: design, not yet implemented.** This is the north-star architecture for turning
> agent-canvas's fleet from a set of supervised cards into a self-directing system that heads,
> perpetually, toward a product **vision**. It builds on the proven orchestration protocol from
> the NarraOS `.claude/commands/orchestration` + `orchestrate` systems (file/Linear blackboard,
> prose-plan-vs-tracker split, non-skippable audit gates, `clear-fix`/`needs-decision`
> classification, adversarial multi-lens audits) and lifts it onto a live, visible, parallel
> fleet. The existing `src/main/orchestrator/` (Agent SDK loop + in-process MCP over a command
> bus) is the seam this grows from. Nothing here ships until the schema (below) is built.

## The one idea

A coding-agent fleet that **steers itself toward a product vision**, where the top-level
orchestrator — the **mastermind** — never does any work with its own hands. It does not plan,
write plans, write code, audit, or even flip a status. It **designs an org and staffs it**, then
trusts correctness because it built independent verification into *every* seam.

The whole system is one loop: measure the gap between the product as it is and the product as the
vision describes it → close the most valuable part of that gap → re-measure → forever. The vision
is an asymptote; it is approached, never reached.

> Two principles carry everything below:
>
> 1. **Trust through structure, not inspection.** Correctness is not policed by a smart overseer
>    (that overseer becomes the bottleneck and the single point of failure). It is an *emergent
>    property of the org chart*: every actor that produces something has an independent, hired
>    auditor checking it — including the lead. The mastermind's skill is org design, not oversight.
> 2. **The orchestrator is pure control plane; agents are the entire data plane.** Producing or
>    mutating content (plans, code, audits, fixes, statuses) is the data plane and belongs to
>    agents. Deciding, routing, gating, hiring, firing is the control plane and is all the
>    mastermind ever does. Its hands never touch content.

## The stack — top to bottom

| Layer | What it is | Owned / authored by | Boundary |
|---|---|---|---|
| **Vision** | Per canvas (one product/repo). The purpose, end-state experience, principles/taste, and anti-vision (markdown body). The north star. | **Human** (sole writer) | Never "done" — an asymptote |
| **Sprint** | One outcome-bounded plan. The unit the mastermind reasons over. | Conceived by a strategist, staffed by the mastermind | Done when its **outcome is verified**, never when time elapses |
| **Plan** | The sprint's approved blueprint: stack, deps, structure. Prose + dependency graph. | The **lead** | Approved (gate) before any decomposition |
| **Issues** | The lead's decomposition of the approved plan into executable DAG nodes. | The **lead** creates; a **worker** owns each | Closed when done *and* audited |

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
| **Mastermind** (the orchestrator) | The org and its verification structure. Outcome-based. | `hire(role, skills, tools, brief)`, `fire(agent)`, `observe()` (read-only), `escalate(decision)`. Writes only the **fleet** (process lifecycle), never the blackboard. | Plan, code, audit, assign, or flip a status. |
| **Strategist** | Reads vision-vs-reality, proposes the next sprint to close the largest-leverage gap. | Gap analysis → next-sprint proposal. | Execute. |
| **Lead** (the "CEO") | Turns an approved plan into issues; assigns and coordinates. Is itself audited. | `create_issue`, `assign`, `set_deps`, `create_phase`. | Author the vision; bless its own plan. |
| **Worker** | One issue at a time; owns *its own* status. | `update_status` (own issues only), `comment`, `report_blocker`. | Touch another worker's issue or write a verdict. |
| **Auditor** | Independent verification at every seam. Adversarial and diverse. | `post_verdict(APPROVED \| ISSUES, findings)`. | Write work-status or code. |

The mastermind's only real intelligence is **how it reacts to failure** and **which gap to
close next** — and even those it delegates (strategist proposes, auditor checks, mastermind
staffs). Everything else is structure.

## The verification gates

A production step with no auditor is the hole through which false success escapes. So every
production in a sprint has an independent checker. The mastermind's obsession is **coverage** —
ensuring all of these gates *exist*, not judging the work itself.

| Gate | When | Question | Consequence of failure |
|---|---|---|---|
| **#0 Conception** | Before planning | Does this sprint's outcome serve the **vision**? | Don't start it. |
| **#1 Plan approval** | After the lead drafts the plan, before decomposition | Is the *structure* sound — stack right per current docs, deps coherent, decomposition-shape valid? | Re-brief the lead. (Cheapest, highest-leverage gate.) |
| **#2 Decomposition fidelity** | After plan → issues, before execution | Do the issues *faithfully and completely* cover the plan — every step has exactly one issue, no drops, no hallucinated extras, deps preserved? | Re-decompose. (NarraOS `/start` Step 6 proved leads drop/invent nodes.) |
| **#3 Per-issue audit** | At each issue's completion | Is this unit correct and **in-scope** (later-phase gaps are deferred, not blocking)? | `clear-fix` → dispatch a fixer; `needs-decision` → escalate to human. |
| **#4 Sprint-outcome audit** | When all issues are done | Does the **assembled whole** achieve the outcome? (Parts passing ≠ whole succeeding.) | Re-staff; the sprint is not DONE until this passes. |

Audits are run as multi-lens **adversarial** reviews (find → verify each finding is `real` *and*
`inScope` → adjudicate `clear-fix` vs `needs-decision`), per the NarraOS `audit-phase` workflow.
`clear-fix` is dispatched to a fixer agent — the mastermind never applies it itself.
`needs-decision` is escalated to the human (optionally after a decision-support panel lays out
options).

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
the org chart — enforced at the tool layer, not by good behavior:

- A **worker** physically cannot flip another worker's status (its `update_status` is restricted
  to issues it owns).
- An **auditor** physically cannot write work-status; only verdicts.
- The **lead**'s `create_issue` / `set_deps` unlock only *after* the plan passes gate #1.
- The **mastermind** has *zero* issue-mutation tools and no `Edit`/`Write`; it acts only through
  the command bus (hire/fire).
- The **vision** is human-write-only and read by everyone; agents may *propose* amendments, only
  the human commits them.

**Identity is the linchpin.** Each card gets an identity token at launch (injected by
`src/main/spine/` when it spawns the `claude` in tmux). The MCP server authorizes every call by
that identity → role → owned records. No card can spoof another's ownership. Get this right or
the role model is theater.

### Hooks vs MCP — two different signals

Keep these distinct:

- **Hooks = process liveness** (is the card alive, running, waiting). Already wired:
  `src/main/spine/` ingests Claude Code hook events into card status.
- **MCP = work progress** (did the unit advance, pass audit).

The mastermind reads both — hooks tell it a card is stuck *breathing*; MCP tells it the *work*
stalled.

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
Sprint        { id, projectId, visionVersionRef, outcome(definition-of-done), state, gapRationale }
Plan          { id, sprintRef, overview, stack[], structure, deps(DAG), nonGoals[], approved }
Issue    { id, planRef, title, description, verify(acceptance), status, owner,
           phase, deps[], labels[], kind:'task'|'audit-gate'|'decision',
           verdicts[], comments[], intentRef }
```

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
| Human approves plan + answers `needs-decision` | Mastermind staffs; **auditor verdicts are the gates**; human owns only the vision + escalations |
| No re-grounding | Verifier checks each issue's premise against the live repo before dispatch |

## Honest risks & load-bearing conditions

These are the conditions under which "trust the flow" is *earned* rather than blind:

- **Auditor independence/diversity.** If the auditor shares the worker's model and blind spots,
  "trust the flow" = "trust a yes-man." Auditors must be a different lens, adversarially told to
  refute, ideally voting.
- **Verification coverage.** A seam without an auditor is the escape hatch for false success. The
  mastermind hunts *uncovered productions*, not bad work.
- **Vision calibration is the hardest authoring skill.** Too vague → auditors can't judge "does
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
- **"Distance to vision" is assessed, not computed** — a recurring independent auditor judgment,
  not a number.
- **Atomic claims** — if workers self-claim ready issues, test-and-set (a real transactional
  store, not a JSON blob) prevents two grabbing one.
- **Identity/auth** is the security spine of the whole role model.
- **Event-driven, not polling** — main emits transitions (`audit-failed`, `phase-done`); the
  mastermind wakes on *verification outcomes*, the renderer re-renders.
- **Cost** — every node becomes a fan-out-and-judge; max-compute is the chosen stance, but the
  mastermind must still be *able* to choose not to fan out for trivial work.

## Open questions

- **Mastermind's failure repertoire.** On terminal failure, does it fire-and-rehire the same
  role, escalate, or *restructure* the org (insert an auditor, split a role, change the skill
  loadout)? This — how a board reacts to a failing company — is the only real reasoning the
  mastermind needs.
- **Strategist as a distinct role vs. a mastermind function.** Is gap-analysis a hired agent or
  the mastermind's one act of authorship? (Leaning: hired, to preserve never-by-hand.)
- **TodoWrite.** Kept as an agent's *private* scratchpad for executing one issue; the shared
  issue store is the coordination layer. Two layers, never merged.

## The summary in one breath

You author the vision. A strategist reads the gap and proposes the next sprint. The mastermind
stages and audits the org. The lead plans and decomposes into issues. Workers own them. Auditors
gate every seam (0–4). The store holds all of it — visible to you, controllable by agents over
MCP. Your scarce attention concentrates entirely at the top, *because* everything beneath is
delegated and independently verified. The product approaches its own vision, forever.
