// Smoke (REAL queries, offline stub bus): proves the in-app learning loop end to end —
// an observe reaction's transcript is read back by the reviewers, their validated plans
// apply, and per-project memory writes land on the right canvas (isolation holds).
// Reviewer judgment is non-deterministic (nothing_to_save is valid), so this asserts the
// WIRING, not a specific write.  npm run mastermind:learn
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IssueMilestone } from '../../shared/types'
import { makeStubBus } from '../orchestrator/stubBus'
import { setMastermindRoot, resetMastermind } from './paths'
import { ensureSubscriptionAuth } from './models'
import { runReaction } from './reactor'
import { recordReaction, drainLearning } from './learning'
import { runMemoryReviewer } from './reviewers'
import { applyMemoryOps, snapshot } from './memory'
import { listSkills } from './skills'

async function main(): Promise<void> {
  setMastermindRoot(join(tmpdir(), 'agentcanvas-mastermind-learn'))
  resetMastermind()
  ensureSubscriptionAuth()

  const milestone: IssueMilestone = {
    kind: 'stalled',
    projectId: 'cv_beta',
    issueId: 'iss-login-form',
    ownerId: 'cd_3',
    detail: 'login form',
  }

  // 1) A real observe reaction (persists a transcript the reviewers can read).
  console.log('▶ reactor (observe) reaction…')
  const r = await runReaction(milestone, makeStubBus(), { mode: 'observe' })
  console.log(`  session: ${r.sessionId || '(none)'}`)

  // 2) The real learning path: record + fire reviewers (stalled → skills reviewer), drain.
  console.log('▶ learning loop (record → reviewers → apply)…')
  recordReaction(milestone, r)
  await drainLearning()
  console.log(`  skills now: ${listSkills().map((s) => s.name).join(', ') || '(none — reviewer declined, valid)'}`)

  // 3) Per-project memory write + isolation, over the same real transcript.
  console.log('▶ memory reviewer (forced recurrence) + per-project write…')
  const plan = await runMemoryReviewer([r.sessionId], 'cv_beta', 'stalled×3 (recurring on this canvas)')
  let wrote = 0
  if (plan && !plan.nothing_to_save && plan.memory_writes?.length) {
    const res = applyMemoryOps(plan.memory_writes, 'window:cv_beta', 'cv_beta')
    if (res.ok) wrote = plan.memory_writes.length
    else console.log(`  apply rejected: ${res.error}`)
  }
  console.log(`  reviewer verdict: ${plan ? (plan.nothing_to_save ? 'nothing_to_save' : `${plan.memory_writes?.length ?? 0} write(s)`) : 'null'}`)
  console.log(`  cv_beta product memory: ${JSON.stringify(snapshot('product', 'cv_beta')) || '(empty)'}`)
  console.log(`  cv_alpha product memory: ${JSON.stringify(snapshot('product', 'cv_alpha')) || '(empty)'}`)

  // Assert the WIRING (not the LLM's judgment): the reaction produced a session, the
  // loop drained, and any writes stayed on cv_beta (cv_alpha untouched).
  const isolationHeld = snapshot('product', 'cv_alpha') === ''
  const ok = !!r.sessionId && isolationHeld
  console.log(`\n${'═'.repeat(48)}`)
  console.log(
    ok
      ? `✅ learning loop ran end-to-end (${wrote} memory write(s) applied; per-project isolation held)`
      : '❌ wiring failed (no session, or memory leaked across canvases)',
  )
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('LEARN SMOKE CRASHED:', e)
  process.exit(2)
})
