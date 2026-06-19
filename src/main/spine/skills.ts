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
      'Use this when you are spawned as a PLANNER for a sprint on the Mastermind board — to research and write the sprint plan (the blueprint), self-audit it, and deliver it to the lead via your issues tools.',
    body: [
      '# Mastermind — Planner',
      '',
      'You were spawned as a **planner** for a sprint. Your job: research and write',
      "the sprint's plan — the blueprint the lead will decompose — then self-audit and",
      'deliver it. You have the **issues** MCP tools plus your normal codebase tools.',
      '',
      '## Flow',
      '1. `get_vision` — the north star the plan must serve.',
      '2. `list_sprints` — find your sprint (its outcome + gap rationale).',
      '3. **Research** the codebase and the relevant docs thoroughly. Spawn subagents',
      '   to investigate in parallel (framework-expert subagents come later).',
      '4. `create_plan` — capture overview, stack, structure, deps, and non-goals at a',
      '   judgeable altitude: concrete enough to act on, no hand-waving.',
      '5. **Self-audit before you deliver** (mandatory): spawn adversarial subagents to',
      '   *refute* the plan — wrong stack? incoherent deps? gaps vs the vision? unsafe',
      '   assumptions? Assume it is wrong; revise until it survives.',
      '6. `approve_plan` — this is your delivery to the lead (it advances the sprint).',
      '   Do NOT call it until your self-audit has signed off.',
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
      '1. `get_vision` and `list_sprints` — find your sprint and its approved plan.',
      '2. `create_issue` per unit of work — title, the impl steps (description), and',
      '   acceptance criteria (verify). `set_deps` to wire the dependency DAG.',
      '3. **Self-audit the distribution before you staff** (mandatory): spawn adversarial',
      '   subagents — does the issue set *faithfully and completely* cover the plan? No',
      '   drops, no invented scope, deps right? Fix gaps.',
      '4. Ask the mastermind to hire workers: `request_workers` with how many and a',
      "   brief. (If that tool isn't available yet, state in your reply how many workers",
      '   you need and for what, and wait to be told they are ready.)',
      '5. When workers are live, `assign_issue` the ready frontier (issues with no open',
      '   deps) to them — start one issue per worker. As issues reach `done`, assign the',
      '   newly-unblocked frontier.',
      '6. `set_sprint_state` → `EXECUTING` once work is assigned.',
      '7. When the DAG drains, **self-audit the assembled whole** (adversarial subagents:',
      '   does it achieve the sprint outcome?), then `set_sprint_state` → `OUTCOME_REVIEW`',
      '   → `DONE`.',
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
      '2. `list_issues` — you see ONLY your assigned issues. Pick one whose `openDeps`',
      '   are empty (don’t start an issue whose dependencies aren’t done).',
      '3. `get_issue` — read the description (steps) and **verify** (acceptance criteria).',
      '4. `update_issue_status` → `in_progress`.',
      '5. Do the work with your normal tools (Edit/Bash/etc.).',
      '6. **Self-audit before you deliver** (mandatory): spawn adversarial subagents to',
      '   *refute* your work against the `verify` criteria and the vision — assume it is',
      '   wrong, hunt for what breaks. Fix everything real they surface.',
      '7. `update_issue_status` → `in_review`, and `comment_issue` with a one-line summary',
      '   of what you did and what your self-audit checked.',
      '8. If stuck, `report_blocker` with the reason — never stall silently.',
      '',
      '## Boundaries',
      '- You never claim or pick up unassigned work — the lead assigns. You act only on',
      '  your own issues and cannot see the rest of the canvas.',
    ].join('\n'),
  },
]
