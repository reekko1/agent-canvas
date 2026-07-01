// The idea tournament, run OFF-CARD — uniformly for every canvas regardless of its
// cards' CLI. It is a MASTERMIND deliberation, not a card task: a headless `claude`
// (the mastermind's own brain, which is Claude for every canvas) runs the pinned
// Workflow in the canvas repo, and we write the resulting Conception to the store.
// The card CLI is irrelevant — this path is identical whether the canvas holds claude
// or codex cards, which is the whole point (no strategist card = no CLI dependence).
//
// Replaces the old strategist CARD, which ran the same Workflow via the Claude-only
// Workflow tool inside the card and so couldn't run on a codex-card canvas.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { IssueActionRequest, IssueActionResult, IssueSnapshot } from '../../shared/types'
import TOURNAMENT_WORKFLOW_SRC from './tournamentWorkflow.js?raw'

export interface TournamentDeps {
  projectId: string
  /** The canvas's repo — the tournament's generators Read it to ground ideas in reality. */
  repoDir: string
  /** The canvas vision the ideas are judged against (passed to the workflow as args.vision). */
  vision: string
  /** SPINE_DIR — where we materialize the workflow script for the headless run. */
  spineDir: string
  apply: (a: IssueActionRequest) => IssueActionResult
  snapshot: () => IssueSnapshot
  /** Live progress — each workflow phase/log line, streamed so the mastermind can
   *  narrate the tournament (there is no card to watch). */
  onProgress?: (line: string) => void
}

interface TournamentResult {
  gapRead?: string
  candidates: { idea: string; why: string; outcome: string; visionLink: string; lens: string; rating?: number; eliminatedRound?: number }[]
  winnerLens?: string | null
  abstainReason?: string | null
}

/** Run the tournament and record its Conception. Returns a one-line outcome for narration.
 *  Best-effort — a headless-run or parse failure records nothing and reports why. */
export async function runTournament(deps: TournamentDeps): Promise<{ ok: boolean; message: string }> {
  // Materialize the workflow to a stable path (main runs it directly; it is no longer
  // bundled into a card plugin). Rewritten each run so a tournamentWorkflow.js edit ships.
  const wfPath = join(deps.spineDir, 'idea-tournament.js')
  mkdirSync(deps.spineDir, { recursive: true })
  writeFileSync(wfPath, TOURNAMENT_WORKFLOW_SRC)

  let result: TournamentResult | null
  try {
    result = await runWorkflowHeadless(wfPath, deps.repoDir, deps.vision, deps.onProgress)
  } catch (e) {
    return { ok: false, message: `tournament run failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!result || !Array.isArray(result.candidates) || !result.candidates.length)
    return { ok: false, message: 'the tournament assembled no candidate field' }

  const created = deps.apply({
    kind: 'conception.create',
    projectId: deps.projectId,
    gapRead: result.gapRead,
    candidates: result.candidates,
  })
  if (!created.ok || !created.id) return { ok: false, message: created.message ?? 'failed to record conception' }
  const id = created.id

  if (result.winnerLens) {
    // Resolve the winning candidate's id by its lens from the STORED conception (the
    // store assigned ids on create) — same resolution the old set_conception_winner did.
    const conception = deps.snapshot().conceptions.find((c) => c.id === id)
    const winner = conception?.candidates.find((c) => c.lens === result!.winnerLens)
    if (!winner) return { ok: false, message: `winning lens "${result.winnerLens}" not found in the field` }
    const r = deps.apply({ kind: 'conception.setWinner', id, winnerIdeaRef: winner.id })
    return r.ok ? { ok: true, message: `winner: ${winner.idea}` } : { ok: false, message: r.message ?? 'set-winner failed' }
  }
  const r = deps.apply({ kind: 'conception.abstain', id, reason: result.abstainReason ?? undefined })
  return r.ok ? { ok: true, message: 'abstained — no idea cleared the bar' } : { ok: false, message: r.message ?? 'abstain failed' }
}

/** Run the pinned Workflow via a headless `claude` in the canvas repo, STREAMING its
 *  progress (there is no card to watch) and parsing its return value. `bypassPermissions`
 *  because this is an unattended autonomous-mode deliberation (the workflow's generators
 *  only Read the repo); no `--allowedTools` restriction, so those generator sub-agents
 *  keep their Read/Grep/Glob tools. `stream-json` surfaces the workflow's phase/log
 *  progress as `system/task_progress` events; the final `result` event carries the agent's
 *  text, from which we extract the workflow's raw return JSON. */
function runWorkflowHeadless(
  wfPath: string,
  repoDir: string,
  vision: string,
  onProgress?: (line: string) => void,
): Promise<TournamentResult | null> {
  const prompt =
    `Use the Workflow tool exactly once: call it with scriptPath="${wfPath}" and args set to a JSON ` +
    `object whose "vision" field is the canvas vision below (verbatim). Let the workflow run to ` +
    `completion. Then output ONLY the workflow's raw return value as a single JSON object — no prose, ` +
    `no markdown fences, nothing else.\n\n<vision>\n${vision}\n</vision>`
  return new Promise((resolve, reject) => {
    // Via the login shell, like every other CLI launch in this app: a packaged
    // (Finder-launched) Electron process has a minimal PATH that won't resolve
    // `claude`; `-lc` resolves it from the user's real PATH.
    const shell = process.env.SHELL ?? '/bin/zsh'
    const child = spawn(
      shell,
      ['-lc', 'exec claude -p --output-format stream-json --verbose --permission-mode bypassPermissions'],
      { cwd: repoDir },
    )
    child.stdin.end(prompt) // over stdin so no flag can swallow it
    let resultText = '' // the final `result` event's text (has the workflow return)
    let lastAssistant = '' // fallback: the last assistant text block
    const seen = new Set<string>() // dedupe cumulative workflow_progress snapshots
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      let ev: Record<string, any>
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type === 'system' && ev.subtype === 'task_progress' && Array.isArray(ev.workflow_progress)) {
        for (const p of ev.workflow_progress) {
          const label = p?.type === 'workflow_phase' ? p.title : (p?.message ?? p?.title)
          if (typeof label !== 'string' || !label) continue
          const key = `${p.type}:${p.index ?? ''}:${label}`
          if (seen.has(key)) continue
          seen.add(key)
          onProgress?.(label)
        }
      } else if (ev.type === 'result' && typeof ev.result === 'string') {
        resultText = ev.result
      } else if (ev.type === 'assistant') {
        for (const b of ev.message?.content ?? [])
          if (b?.type === 'text' && typeof b.text === 'string') lastAssistant = b.text
      }
    })
    child.on('error', reject)
    child.on('close', () => resolve(extractJson(resultText || lastAssistant)))
  })
}

/** Extract the workflow's return object from the agent's final text — the JSON object,
 *  whether bare or fenced. Returns null if nothing parseable is found. */
function extractJson(text: string): TournamentResult | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1)) as TournamentResult
  } catch {
    return null
  }
}
