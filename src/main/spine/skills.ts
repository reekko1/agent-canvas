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
// card. Per-card selection is a deliberate non-goal for v1.

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
]
