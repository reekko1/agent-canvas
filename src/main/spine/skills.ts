// The curated skill library equipped into EVERY supervised agent card.
//
// Authored here as data, then materialized into a Claude Code plugin under
// SPINE_DIR (`<SPINE_DIR>/canvas-skills/`) at spine startup and attached to
// every `claude` session via `--plugin-dir` — see ClaudeAdapter.stageSkills /
// launchCommand. We keep the source in-process (not as on-disk SKILL.md files
// behind extraResources) so there's no dev-vs-packaged path resolution: the
// materializer rebuilds the plugin dir from this array each launch, so editing
// a skill ships on the next relaunch and a removed/renamed skill doesn't linger.
//
// The orchestrator does NOT pick a subset — the whole plugin is added to every
// card (per-card selection stays a non-goal). The Mastermind role skills
// (planner/lead/worker) ship on every card too; a card follows the one matching
// the role it was spawned as (its brief names the role), and the issue-MCP tool
// grant enforces what it can actually do — so a worker that opened the lead skill
// still has no lead tools.

import STRATEGIST_TOURNAMENT_SRC from './strategistTournament.js?raw'

export interface CanvasSkill {
  /** SKILL.md `name`: lowercase, `[a-z0-9-]`, ≤64 chars. Becomes the namespaced
   *  invocation `/canvas-skills:<name>`. */
  name: string
  /** SKILL.md `description`: what it does AND when to use it. This is the only
   *  part always in the agent's context — it drives auto-invocation, so lead
   *  with the trigger. ≤1024 chars. */
  description: string
  /** SKILL.md markdown body — loaded on demand (progressive disclosure) when the
   *  skill triggers, so it's effectively free until used. */
  body: string
}

/** Plugin manifest identity. The name namespaces every skill (`/canvas-skills:…`)
 *  and must stay stable so reattached sessions resolve the same plugin. */
export const PLUGIN_NAME = 'canvas-skills'
export const PLUGIN_VERSION = '0.1.0'

/** The pinned strategist tournament workflow source (authored in
 *  strategistTournament.js, inlined at build via `?raw`) — written into the plugin
 *  dir by stageSkills and invoked by the mastermind-strategist skill via scriptPath. */
export { STRATEGIST_TOURNAMENT_SRC }
/** Where stageSkills writes the pinned workflow inside the plugin dir. */
export const STRATEGIST_WORKFLOW_REL = 'workflows/strategist-tournament.js'
/** Token in the strategist SKILL.md body that stageSkills replaces with the
 *  workflow's absolute path (runtime-only, inside SPINE_DIR — never the user repo). */
export const STRATEGIST_WORKFLOW_PLACEHOLDER = '__STRATEGIST_WORKFLOW_PATH__'

export const CANVAS_SKILLS: CanvasSkill[] = [
  {
    name: 'working-in-agent-canvas',
    description:
      'Use at the start of any task to understand that you are running as a supervised agent card inside Agent Canvas. Explains how your status, checklist, and final reply are surfaced to the human supervisor, and how to keep them informed.',
    body: [
      '# Working in Agent Canvas',
      '',
      'You are running as a **supervised agent card** inside Agent Canvas — a',
      'master-stack viewer where a human watches a fleet of agents. Your session',
      'lives in a tmux session that outlives the app, so your scrollback is never',
      'lost. Work as you normally would; this skill just explains what the human',
      'sees so you can keep them well-informed.',
      '',
      '## What the supervisor sees',
      '',
      "- **Your checklist** is your `TodoWrite` plan. The card renders it live, so",
      '  maintain a clear, current plan — it is the supervisor’s primary window into',
      '  your progress. Mark items in-progress/completed as you go.',
      '- **Your status** is derived from your activity (running, waiting on a',
      '  permission ask, finished). You do not set it directly.',
      '- **Your final reply** — the last assistant message when you finish a turn —',
      '  is echoed to the supervisor and may be read aloud. End substantial turns',
      'with a concise summary of what you did and what (if anything) you need.',
      '- **Permission asks** are surfaced to the human to approve or deny. Expect a',
      '  brief hold when you request one; do not work around the permission system.',
      '',
      '## How to be a good fleet citizen',
      '',
      '- Keep the plan honest and granular enough to show real progress.',
      '- Surface blockers explicitly in your reply rather than stalling silently.',
      '- Prefer small, verifiable steps — the supervisor may be watching several',
      '  agents at once and relies on your checklist to triage attention.',
    ].join('\n'),
  },
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
      '  before you `approve_plan`.',
      '- **autonomous** — your brief is a complete spec; work from it without asking.',
      '  Your self-audit is the only gate before you deliver.',
      '',
      '## Flow',
      '1. `get_vision` — the north star the plan must serve. A vision must exist on',
      '   the canvas (the human sets it); if none, ask the human to set it first.',
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
  {
    name: 'mastermind-strategist',
    description:
      'Use this when you are spawned as the STRATEGIST (the autonomous head) for a canvas — to find the next sprint by running the pinned idea tournament (10 lensed generators, a Bradley-Terry contest, refinement, an absolute-bar gate), record the bracket, and hand the winning idea to a planner or abstain to the human. You conduct the contest; you never author or judge ideas, and never create a sprint or plan.',
    body: [
      '# Mastermind — Strategist',
      '',
      'You were spawned as the **strategist** — the autonomous head of this canvas. Your job:',
      'find the next sprint for this canvas by running an idea TOURNAMENT, then hand the winning',
      'idea to a planner (the system spawns it). You CONDUCT the contest — you never author or',
      'judge ideas yourself, and you never create a sprint or a plan. You have the **issues** MCP',
      'tools and the **Workflow** tool.',
      '',
      '## Flow',
      '1. PERCEIVE the vision: `get_vision` (current body, principles, anti-vision) and',
      '   `get_vision_history` (the trajectory of intent — where the vision is heading). A vision',
      '   must exist; if none is set, say so and stop.',
      '2. RUN THE PINNED TOURNAMENT. Invoke the **Workflow** tool with EXACTLY:',
      '   - `scriptPath`: "__STRATEGIST_WORKFLOW_PATH__"',
      '   - `args`: { "vision": "<the full vision as text — assemble the body, principles, and',
      '     anti-vision from get_vision, plus the version-history rationales from get_vision_history>" }',
      '   Do NOT author or edit a workflow script and do NOT pass `script`. The pinned workflow runs',
      '   10 lensed generators that read THIS repository, a pairwise Bradley-Terry tournament,',
      '   refinement rounds, and an absolute-bar gate — all on its own. Wait for it to finish.',
      '3. RECORD THE BRACKET. The workflow returns { gapRead, candidates, winnerLens, abstainReason }.',
      '   Call `record_conception` with that `gapRead` and `candidates` array verbatim (this is your',
      '   visible deliberation; it returns a conception id).',
      '4. DELIVER OR ABSTAIN:',
      '   - If `winnerLens` is set: `set_conception_winner` with the conception id and that',
      '     `winnerLens`. This hands the winning idea to a planner (the system spawns it). Done.',
      '   - If `winnerLens` is null: `abstain_conception` with the conception id and `abstainReason`.',
      '     No sprint is born and the human is asked to steer. Do NOT retry or manufacture a winner.',
      '5. End your turn with one line: what won (or that you abstained) and why.',
      '',
      '## Boundaries',
      '- You conduct; the workflow subagents generate and judge. You never write an idea or a',
      '  verdict yourself, and you never create a sprint, plan, or issue — the planner makes the',
      '  sprint from your winning idea.',
      '- Trust the tournament result: if its gate abstained, abstain — do not override it.',
    ].join('\n'),
  },
]
