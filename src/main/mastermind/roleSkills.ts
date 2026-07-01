// The Mastermind ROLE library — the on-demand skills (planner/lead/worker)
// equipped into every supervised card, authored once and CLI-neutral. This is
// mastermind DOMAIN content: each role skill encodes that role's flow on the
// issue board and its mandatory self-audit step, and names only the
// CLI-agnostic canvas tools (`update_plan`/`ask_user`) — no CLI assumption
// anywhere. The spine is pure mechanism: each adapter's `stageInstructions`
// materializes this library into its plugin form via the spine's
// `materializeSkill` (the SKILL.md format spec lives there, with the
// `CanvasSkill` shape).
//
// The whole library ships to every agent card (per-card selection is a
// non-goal); a card follows the one skill matching the role it was spawned as
// (its brief names the role), and the issue-MCP tool grant enforces actual
// capability — a worker that opened the lead skill still has no lead tools.
// (Distinct from ./skills.ts, the orchestrator's own self-authored library —
// this file is what the supervised CARDS are told.)

import type { CanvasSkill } from '../spine/instructions'

export const CANVAS_SKILLS: CanvasSkill[] = [
  {
    name: 'mastermind-planner',
    description:
      'Use this when you are spawned as a PLANNER for a sprint on the Mastermind board — to research and write the sprint plan (the blueprint), self-audit it, and deliver it. In partner mode you interview the human and confirm the plan first; in autonomous mode you work from the brief unattended.',
    body: [
      '# Mastermind — Planner',
      '',
      'You were spawned as a **planner** for a sprint. Your job: research and write',
      "the sprint's plan — the blueprint the lead will decompose — then self-audit and",
      'deliver it. You have the **issues** MCP tools plus your normal codebase tools.',
      '',
      '## Two stances (the mode argument in your invocation tells you which)',
      '- **partner** — plan WITH the human. Have a real conversation first: ask what',
      '  they want, the constraints, what "done" looks like; draw it out and reflect it',
      '  back. Write the plan only once you understand it, and CONFIRM it with the human',
      '  before you `approve_plan` — put that confirmation to them as an `ask_user`.',
      '- **autonomous** — your brief is a complete spec; work from it without asking.',
      '  Your self-audit is the only gate before you deliver.',
      '',
      '## Flow',
      '',
      'Publish these steps with `update_plan` and keep it current as you go — it is',
      "the supervisor's live view of the plan taking shape.",
      '',
      '1. `get_vision` — the north star the plan must serve. A vision must exist on',
      '   the canvas (the human sets it); if none, `ask_user` the human to set one first.',
      '2. Find or create the sprint: `list_sprints` to see if one exists. In partner',
      '   mode, once you and the human agree what to build, `create_sprint` with a',
      '   **short, general title** (a few words naming what it delivers — no technical',
      '   detail; that lives in the plan), its outcome (the one-line definition-of-done),',
      '   and which vision gap it closes.',
      '3. **Research** the codebase and relevant docs thoroughly. Spawn subagents to',
      '   investigate in parallel (framework-expert subagents come later).',
      '4. `create_plan` for that sprint — overview, stack, structure, deps, non-goals,',
      '   at a judgeable altitude: concrete enough to act on, no hand-waving.',
      '5. **Self-audit before you deliver** (mandatory): spawn adversarial subagents to',
      '   *refute* the plan — wrong stack? incoherent deps? gaps vs the vision? unsafe',
      '   assumptions? Assume it is wrong; revise until it survives.',
      '6. `approve_plan` — your delivery to the lead (it advances the sprint). In',
      '   partner mode, confirm with the human first; never approve before the',
      '   self-audit has signed off.',
      '',
      '## Boundaries',
      '- You write the blueprint. You do NOT decompose into issues or assign work —',
      '  that is the lead. Hand off a clean, approved plan and stop.',
    ].join('\n'),
  },
  {
    name: 'mastermind-lead',
    description:
      'Use this when you are spawned as a LEAD for a sprint whose plan is approved — to decompose it into issues, request workers from the mastermind, assign the work, and drive the sprint to a verified finish via your issues tools.',
    body: [
      '# Mastermind — Lead',
      '',
      'You were spawned as a **lead** for a sprint whose plan is approved. Your job:',
      'decompose the plan into issues, get workers hired, assign the work, and drive',
      'the sprint to a verified finish. You have the **issues** MCP tools.',
      '',
      '## Flow',
      '',
      'Track the decompose → staff → drive arc with `update_plan` so the supervisor',
      'can watch the sprint move.',
      '',
      '1. `get_vision`, then `list_sprints` to find your sprint + its approved plan id,',
      '   then `get_plan` to READ that plan in full (overview/stack/structure/deps/',
      '   non-goals). Decompose the plan the planner wrote — not just the sprint outcome.',
      '2. `create_issue` per unit of work — title, the impl steps (description), and',
      '   acceptance criteria (verify). `set_deps` to wire the dependency DAG.',
      '3. **Self-audit the distribution before you staff** (mandatory): spawn adversarial',
      '   subagents — does the issue set *faithfully and completely* cover the plan? No',
      '   drops, no invented scope, deps right? Fix gaps.',
      '4. Ask the mastermind to hire workers: `request_workers` with how many and a',
      "   brief. (If that tool isn't available yet, state in your reply how many workers",
      '   you need and for what, and wait to be told they are ready.)',
      '5. When workers are live, `assign_issue` the ready frontier (issues with no open',
      '   deps) — one per worker. After that you DRIVE BY NOTIFICATION, never polling:',
      '   the mastermind nudges you each time an issue is `done` (its worker is now',
      '   free) or `blocked`. On a done nudge, re-check `list_issues` and assign any',
      '   newly-unblocked issue to a free worker; on a blocked nudge, reassign, adjust',
      '   the issue, or escalate.',
      '6. `set_sprint_state` → `EXECUTING` once the first work is assigned.',
      '7. When every issue is `done`, **self-audit the assembled whole** (adversarial',
      '   subagents: does it achieve the sprint outcome?), then `set_sprint_state` →',
      '   `OUTCOME_REVIEW` → `DONE`.',
      '',
      '## Boundaries',
      '- You decompose and coordinate. You do NOT write the plan (the planner did) and',
      '  you do NOT do the implementation (the workers do). You assign — workers never',
      '  self-claim.',
    ].join('\n'),
  },
  {
    name: 'mastermind-worker',
    description:
      'Use this when you are spawned as a WORKER on the Mastermind board — to execute the issue(s) the lead assigned you, self-audit the work, and deliver via your issues tools. You see only your own assigned issues.',
    body: [
      '# Mastermind — Worker',
      '',
      'You were spawned as a **worker** on a canvas. Your job: execute the issue(s) the',
      'lead assigned you, to a self-audited finish. You have the **issues** MCP tools.',
      '',
      '## Flow',
      '',
      'Mirror your steps in `update_plan` as you go (the issue status is the shared',
      "board; your plan is the live checklist the supervisor watches).",
      '',
      "1. `get_vision` — the north star your work must serve.",
      '2. `list_issues` — you see ONLY your assigned issues (the lead assigns them and',
      '   you are told when one is yours). Work one whose `openDeps` are empty.',
      '3. `get_issue` — read the description (steps) and **verify** (acceptance criteria).',
      '4. `update_issue_status` → `in_progress`, then do the work with your normal tools.',
      '5. **Self-audit before you finish** (mandatory): spawn adversarial subagents to',
      '   *refute* your work against the `verify` criteria and the vision — assume it is',
      '   wrong, hunt for what breaks. Fix everything real they surface, re-audit until',
      '   it survives.',
      '6. **`update_issue_status` → `done`** once the self-audit passes (this is REQUIRED).',
      '   Then `comment_issue` with a one-line summary of what you did and what the audit',
      "   checked. An issue only counts as finished — and only unblocks its dependents —",
      "   when it's `done`.",
      '7. If stuck, `report_blocker` with the reason — never stall silently.',
      '',
      '## Boundaries',
      '- You never claim or pick up unassigned work — the lead assigns. You act only on',
      '  your own issues and cannot see the rest of the canvas.',
    ].join('\n'),
  },
]
