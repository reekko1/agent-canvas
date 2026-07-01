// The spine's instruction MECHANISM plus its one piece of spine-owned content.
//   BASELINE_SUPERVISION — the always-on supervision briefing EVERY card gets
//     (spine content: it describes the supervision surface itself). Each adapter
//     renders it in its own always-on channel (Claude via
//     `--append-system-prompt-file`, codex via `AGENTS.md`) — never a skill, so
//     it can't be missed by auto-discovery.
//   CanvasSkill + materializeSkill — the SKILL.md format spec and serializer the
//     adapters materialize any skill library with. The mastermind ROLE library
//     itself (planner/lead/worker) is domain content and lives in
//     `../mastermind/roleSkills.ts` — the spine ships whatever it's given, and
//     the whole library goes to every agent card (per-card selection is a
//     non-goal).
//
// Nothing here carries a CLI assumption; the adapter owns every CLI-specific
// detail (packaging, invocation syntax, delivery channel) — each renders both
// instruction channels in its `stageInstructions`. See CliAdapter / skillRef.
//
// Instructions are authored in-process (not as on-disk SKILL.md files behind
// extraResources) so there's no dev-vs-packaged path resolution: the
// materializer rebuilds the plugin dir from source each launch, so an edit
// ships on the next relaunch and a removed/renamed skill doesn't linger.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

/** Write one skill as `<skillsRoot>/<name>/SKILL.md` — the one SKILL.md
 *  serializer, shared by every adapter's plugin materializer. `name` is
 *  constrained to `[a-z0-9-]` so it's YAML-safe bare; `description` is free text
 *  (may contain ':'), so it's emitted as a double-quoted scalar — JSON string
 *  escaping is valid YAML flow-scalar syntax. */
export function materializeSkill(skillsRoot: string, s: CanvasSkill): void {
  const dir = join(skillsRoot, s.name)
  mkdirSync(dir, { recursive: true })
  const md = `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}\n`
  writeFileSync(join(dir, 'SKILL.md'), md)
}

/** The always-on supervision briefing every card boots with — CLI-neutral, delivered
 *  by each adapter in its own always-on channel (NOT a skill, so auto-discovery can't
 *  skip it). Both CLIs now route the checklist through the same in-memory `update_plan`
 *  MCP tool, so there is no per-CLI difference to fork on — one source. */
export const BASELINE_SUPERVISION = [
  '# Working in Agent Canvas',
  '',
  'You are running as a **supervised agent card** inside Agent Canvas — a',
  'master-stack viewer where a human watches a fleet of agents. Your session',
  'lives in a tmux session that outlives the app, so your scrollback is never',
  'lost. Work as you normally would; this briefing explains what the human sees',
  'so you can keep them well-informed.',
  '',
  '## Your Agent Canvas tools',
  '',
  'Two tools keep the supervisor in the loop. Use THESE — not any built-in to-do',
  'or question tool:',
  '- **`update_plan`** — publish your checklist. Call it at the start of a task',
  '  with your steps, then again each time a step changes status. Send your WHOLE',
  '  plan each time (it replaces the last). This is the supervisor’s primary window',
  '  into your progress, so keep it current and granular, one step in_progress.',
  '- **`ask_user`** — when you hit a real decision you cannot make yourself (a fork',
  '  in approach, a preference, a missing requirement), ask the human with concrete',
  '  options rather than guessing. It blocks until they answer. Reserve it for',
  '  genuine forks; decide the details yourself.',
  '',
  '## What else the supervisor sees',
  '',
  '- **Your status** is derived from your activity (running, waiting on a permission',
  '  ask, finished). You do not set it directly.',
  '- **Your final reply** — your last message when you finish a turn — is echoed to',
  '  the supervisor and may be read aloud. End substantial turns with a concise',
  '  summary of what you did and what (if anything) you need.',
  '- **Permission asks** — cards run unattended by default (no permission gates), but',
  '  if your session is in a gated permission mode, asks are surfaced to the human to',
  '  approve or deny; expect a brief hold and do not work around the permission system.',
  '',
  '## How to be a good fleet citizen',
  '',
  '- Keep the plan (`update_plan`) honest and granular enough to show real progress.',
  '- Surface blockers explicitly in your reply rather than stalling silently.',
  '- Prefer small, verifiable steps — the supervisor may be watching several agents',
  '  at once and relies on your checklist to triage attention.',
  '',
].join('\n')
