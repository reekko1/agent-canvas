// Deterministic edge-case suite — no model calls. Proves the non-LLM logic of the
// lifted module: memory ops/budget/recoverability/replay (now per-project), the
// operator/product store split, skill validation, archive-never-delete, triggers,
// curator aging. Runnable under tsx (no SDK / Electron / native deps pulled in).
//   npm run mastermind:edges
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setMastermindRoot, resetMastermind, productMemoryPath } from './paths'
import { applyMemoryOps, materialize, snapshot, BUDGET } from './memory'
import { ensurePlugin, applySkill, patchSkillBody, deleteSkill, writeSkillFile, removeSkillFile, listSkills, skillExists, archivedExists, archiveSkill, recordSkillUse, skillBody } from './skills'
import { initTriggers, onReaction, type MilestoneKind } from './triggers'
import { ageSkills } from './curator'
import { isToolAllowed } from './reactor'
import { READ_ONLY_TOOLS } from '../orchestrator/canvasServer'
import { reactionLog, ReactionLog } from './reactions'
import { computeWorldView } from './world'
import type { IssueMilestone, IssueSnapshot } from '../../shared/types'

const checks: { label: string; ok: boolean; detail: string }[] = []
const check = (label: string, ok: boolean, detail = ''): void => {
  checks.push({ label, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}
const DAY = 24 * 60 * 60 * 1000
const PROJ = 'canvas-test'
const OTHER = 'canvas-other'

function memorySection(): void {
  console.log('\n— memory (per-project product store) —')
  applyMemoryOps([{ store: 'product', op: 'add', text: 'CI runs in about 8 minutes.' }], 't', PROJ)
  applyMemoryOps([{ store: 'product', op: 'add', text: 'Auth module is fragile.' }], 't', PROJ)
  check('memory add + materialize', materialize('product', PROJ).length === 2)
  let r = applyMemoryOps([{ store: 'product', op: 'replace', target: 'CI runs', text: 'CI runs in about 12 minutes.' }], 't', PROJ)
  check('memory replace by substring', r.ok && snapshot('product', PROJ).includes('12 minutes'))
  r = applyMemoryOps([{ store: 'product', op: 'remove', target: 'Auth module' }], 't', PROJ)
  check('memory remove by substring', r.ok && !snapshot('product', PROJ).includes('Auth module'))
  // recoverability: removed text still present in the event log (history preserved)
  const raw = readFileSync(productMemoryPath(PROJ), 'utf8')
  check('recoverability: removed entry still in event log', raw.includes('Auth module is fragile'))
  // replay determinism
  check('replay determinism (two fresh materializations equal)', JSON.stringify(materialize('product', PROJ)) === JSON.stringify(materialize('product', PROJ)))
  // budget overflow rejected, nothing written
  const before = snapshot('product', PROJ)
  r = applyMemoryOps([{ store: 'product', op: 'add', text: 'x'.repeat(BUDGET.product + 50) }], 't', PROJ)
  check('budget overflow rejected', !r.ok && snapshot('product', PROJ) === before, r.error)
  // replace target-not-found rejected
  r = applyMemoryOps([{ store: 'product', op: 'replace', target: 'does-not-exist', text: 'y' }], 't', PROJ)
  check('replace target-not-found rejected', !r.ok, r.error)
}

function storeSplitSection(): void {
  console.log('\n— operator (global) vs product (per-project) split —')
  applyMemoryOps([{ store: 'operator', op: 'add', text: 'Operator prefers fewer, larger sprints.' }], 't')
  check('operator store is global (no projectId)', snapshot('operator').includes('fewer, larger sprints'))
  // a product write to another canvas must not leak into PROJ
  applyMemoryOps([{ store: 'product', op: 'add', text: 'Other canvas uses Rust.' }], 't', OTHER)
  check('per-project isolation (OTHER not visible from PROJ)', !snapshot('product', PROJ).includes('Rust') && snapshot('product', OTHER).includes('Rust'))
  // a product write without a projectId is a hard error (caught, not silent)
  let threw = false
  try {
    applyMemoryOps([{ store: 'product', op: 'add', text: 'no project' }], 't')
  } catch {
    threw = true
  }
  check('product write without projectId rejected', threw)
}

function skillsSection(): void {
  console.log('\n— skills validation + archive —')
  check('bad name rejected', !applySkill({ name: 'Bad Name', description: 'd', body: 'b' }, 't').ok)
  check('reserved word rejected', !applySkill({ name: 'claude-helper', description: 'd', body: 'b' }, 't').ok)
  check('oversized body rejected', !applySkill({ name: 'huge', description: 'd', body: Array(600).fill('line').join('\n') }, 't').ok)
  check('valid create ok', applySkill({ name: 'handling-stalls', description: 'when a sprint stalls', body: 'step 1' }, 't').ok)
  // upsert: same name updates in place instead of rejecting on collision
  check('upsert: same name updates in place', applySkill({ name: 'handling-stalls', description: 'when a sprint stalls', body: 'step 1 revised' }, 't').ok && skillBody('handling-stalls') === 'step 1 revised')
  // a NEW skill still needs full content — a body-only refine of an absent name can't land
  check('new skill without description rejected', !applySkill({ name: 'no-such-skill', body: 'b' }, 't').ok)
  const p = applySkill({ name: 'handling-stalls', body: 'step 1 improved' }, 't')
  check('valid patch updates body', p.ok && skillBody('handling-stalls').includes('improved'))
  // partial update: description-only refine keeps the existing body (no blind overwrite)
  check('partial update inherits existing body', applySkill({ name: 'handling-stalls', description: 'sharper desc' }, 't').ok && skillBody('handling-stalls') === 'step 1 improved')
  archiveSkill('handling-stalls')
  check('archive-never-delete (recoverable, hidden from active)', archivedExists('handling-stalls') && !skillExists('handling-stalls') && !listSkills().some((s) => s.name === 'handling-stalls'))

  // hermes-parity actions: string patch, delete→archive, supporting files
  applySkill({ name: 'patch-me', description: 'd', body: 'alpha\nbeta\nalpha' }, 't')
  check('patch no-match writes nothing', !patchSkillBody('patch-me', 'zzz', 'x').ok && skillBody('patch-me') === 'alpha\nbeta\nalpha')
  check('patch non-unique without replaceAll rejected', !patchSkillBody('patch-me', 'alpha', 'A').ok)
  check('patch replaceAll hits every match', patchSkillBody('patch-me', 'alpha', 'A', true).ok && skillBody('patch-me') === 'A\nbeta\nA')
  check('patch unique match edits in place', patchSkillBody('patch-me', 'beta', 'B').ok && skillBody('patch-me') === 'A\nB\nA')
  check('delete archives (history preserved)', deleteSkill('patch-me').ok && archivedExists('patch-me') && !skillExists('patch-me'))
  check('delete of unknown skill rejected', !deleteSkill('no-such-skill').ok)

  applySkill({ name: 'with-files', description: 'd', body: 'b' }, 't')
  check('write_file under allowed subdir ok', writeSkillFile('with-files', 'scripts/run.sh', 'echo hi').ok)
  check('write_file traversal rejected', !writeSkillFile('with-files', '../escape.sh', 'x').ok)
  check('write_file outside allowed subdir rejected', !writeSkillFile('with-files', 'secrets/x', 'x').ok)
  check('write_file to missing skill rejected', !writeSkillFile('no-such-skill', 'scripts/x', 'x').ok)
  check('remove_file drops the file', removeSkillFile('with-files', 'scripts/run.sh').ok && !removeSkillFile('with-files', 'scripts/run.sh').ok)
}

function triggersSection(): void {
  console.log('\n— triggers —')
  let s = initTriggers()
  check('skills reviewer fires on a conclusive milestone (stalled)', onReaction(s, 'stalled').fireSkill)
  s = initTriggers()
  let firedMemoryAt = 0
  for (let i = 1; i <= 10; i++) {
    const res = onReaction(s, 'issue-done')
    s = res.state
    if (res.fireMemory) firedMemoryAt = i
  }
  check('memory reviewer fires at exactly 10 reactions', firedMemoryAt === 10, `fired at ${firedMemoryAt}`)
  s = initTriggers()
  let firedSkillAt = 0
  for (let i = 1; i <= 10 && !firedSkillAt; i++) {
    const res = onReaction(s, 'issue-done')
    s = res.state
    if (res.fireSkill) firedSkillAt = i
  }
  check('skill backstop fires at 10 without friction', firedSkillAt === 10, `fired at ${firedSkillAt}`)
  s = initTriggers()
  firedSkillAt = 0
  const seq: MilestoneKind[] = ['issue-done', 'retire', 'issue-done', 'issue-done', 'issue-done']
  for (let i = 0; i < seq.length && !firedSkillAt; i++) {
    const res = onReaction(s, seq[i])
    s = res.state
    if (res.fireSkill) firedSkillAt = i + 1
  }
  check('friction (retire) lowers skill backstop to 5', firedSkillAt === 5, `fired at ${firedSkillAt}`)
}

// Every mutating canvas verb (canvasServer.ts) EXCEPT send_to_agent — none of these may
// ever be allowed in observe, and only send_to_agent may be added in nudge. If a verb
// here ever drifts into READ_ONLY_TOOLS, these checks fail (the safety-critical guard).
const DESTRUCTIVE = [
  'focus_canvas', 'spawn_agent', 'open_browser', 'navigate_browser', 'browser_click',
  'browser_type', 'browser_scroll', 'browser_select', 'browser_history', 'rename_agent',
  'kill_card', 'approve_ask', 'notify_user',
]
const READS = READ_ONLY_TOOLS as readonly string[] // the single source of truth — drift here is caught at compile, not silently

function toolGateSection(): void {
  console.log('\n— reactor tool gate (observe / nudge) —')
  // observe: perceive only — Skill + every read allowed, every mutation denied
  check('observe allows Skill', isToolAllowed('Skill', 'observe'))
  check('observe allows all reads', READS.every((t) => isToolAllowed(`mcp__canvas__${t}`, 'observe')))
  check('observe DENIES send_to_agent', !isToolAllowed('mcp__canvas__send_to_agent', 'observe'))
  check('observe DENIES every destructive verb', DESTRUCTIVE.every((t) => !isToolAllowed(`mcp__canvas__${t}`, 'observe')))
  // nudge: perceive + message only; every destructive verb still denied
  check('nudge ALLOWS send_to_agent + reads', isToolAllowed('mcp__canvas__send_to_agent', 'nudge') && READS.every((t) => isToolAllowed(`mcp__canvas__${t}`, 'nudge')))
  check('nudge DENIES every destructive verb', DESTRUCTIVE.every((t) => !isToolAllowed(`mcp__canvas__${t}`, 'nudge')))
  // unknown / unprefixed tool: denied in both modes
  check('unknown tool denied in observe/nudge', !isToolAllowed('mcp__canvas__made_up', 'observe') && !isToolAllowed('weird', 'nudge'))
}

function reactionsSection(): void {
  console.log('\n— reaction log (persisted triggers + scoping + recurrence) —')
  const mile = (kind: MilestoneKind, projectId: string): IssueMilestone => ({ kind, projectId })
  const P = 'canvas-rx'
  let early = 0
  for (let i = 0; i < 9; i++) {
    const o = reactionLog.record(mile('issue-done', P), `sess-${i}`)
    if (o.fireSkill || o.fireMemory) early++
  }
  check('no reviewer fires in the first 9 routine reactions', early === 0)
  const tenth = reactionLog.record(mile('issue-done', P), 'sess-9')
  check('memory + skill fire at the 10th routine reaction', tenth.fireMemory && tenth.fireSkill)
  check('memory window = 10 sessions', tenth.window.length === 10)
  check('skill episode = 10 sessions', tenth.episode.length === 10)
  // a conclusive milestone fires skills immediately on a fresh project
  const c = reactionLog.record(mile('stalled', 'canvas-rx2'), 'sx-0')
  check('conclusive (stalled) fires skills immediately', c.fireSkill && c.episode.length === 1)
  check('recurrence digest counts kinds', reactionLog.recurrenceDigest(P).includes('issue-done'))
  // persistence: a fresh log replays the file and resumes mid-stream (the 10th reset
  // survives reload, so reaction #11 starts a new episode rather than re-firing)
  const fresh = new ReactionLog()
  const next = fresh.record(mile('issue-done', P), 'sess-10')
  check('persisted state survives reload (no spurious re-fire after replay)', !next.fireSkill && !next.fireMemory)
}

function worldSection(): void {
  console.log('\n— world view (cross-canvas synthesis) —')
  const snap = {
    visions: [{ projectId: PROJ, currentVersion: 'vv1' }],
    versions: [{ id: 'vv1', projectId: PROJ, body: '# Ship the thing\n\nmore detail here' }],
    sprints: [
      { id: 's1', projectId: PROJ, state: 'EXECUTING' },
      { id: 's2', projectId: PROJ, state: 'DONE' },
      { id: 's3', projectId: OTHER, state: 'PLAN_REVIEW' },
    ],
    plans: [],
    issues: [],
    distance: [],
    conceptions: [],
  } as unknown as IssueSnapshot
  const canvases = [
    { id: PROJ, name: 'main-canvas' },
    { id: OTHER, name: 'other-canvas' },
    { id: 'empty', name: 'fresh' },
  ]
  const view = computeWorldView(canvases, snap, (id) => (id === PROJ ? 'CI is slow.' : ''))
  check('world view lists every canvas', canvases.every((c) => view.includes(c.name)))
  check('world view shows the vision headline (heading stripped)', view.includes('Ship the thing'))
  check('world view summarizes live sprints and ignores DONE', /main-canvas:.*building/.test(view) && !/main-canvas:.*done/.test(view))
  check('world view marks a canvas with no sprint', view.includes('no sprint yet'))
  check('world view folds in per-canvas product memory', view.includes('CI is slow'))
  check('empty canvas list yields empty string (open-canvas fallback)', computeWorldView([], snap, () => '') === '')
}

function curatorSection(): void {
  console.log('\n— curator aging —')
  const now = Date.now()
  applySkill({ name: 'old-unused', description: 'd', body: 'b' }, 't')
  applySkill({ name: 'recently-used', description: 'd', body: 'b' }, 't')
  const future = now + 100 * DAY
  recordSkillUse('recently-used', future - 10 * DAY) // used 10 days before "now"
  const { archived } = ageSkills(future) // 100 days later
  check('curator archives an unused skill', archived.includes('old-unused') && !skillExists('old-unused'))
  check('curator keeps a recently-used skill (reactivation)', !archived.includes('recently-used') && skillExists('recently-used'))
}

function main(): void {
  setMastermindRoot(join(tmpdir(), 'agentcanvas-mastermind-test'))
  resetMastermind()
  ensurePlugin()
  memorySection()
  storeSplitSection()
  skillsSection()
  triggersSection()
  toolGateSection()
  reactionsSection()
  worldSection()
  curatorSection()

  const passed = checks.filter((c) => c.ok).length
  console.log(`\n${'═'.repeat(48)}`)
  console.log(`MASTERMIND EDGE SUITE: ${passed}/${checks.length} checks passed`)
  for (const c of checks.filter((c) => !c.ok)) console.log(`  ❌ ${c.label} — ${c.detail}`)
  process.exit(passed === checks.length ? 0 : 1)
}

main()
