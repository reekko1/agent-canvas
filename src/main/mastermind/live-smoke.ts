// Smoke (REAL Opus query, offline stub bus): proves the live `nudge` path — the reactor
// may perceive + message agents, but destructive verbs (spawn/kill/reassign) are denied +
// recorded. Asserts the latitude held (nothing a read or a message ever landed in the
// held-back list).  npm run mastermind:live
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IssueMilestone } from '../../shared/types'
import { makeStubBus } from '../orchestrator/stubBus'
import { setMastermindRoot, resetMastermind } from './paths'
import { ensureSubscriptionAuth } from './models'
import { runReaction } from './reactor'

const READS = ['list_world', 'get_agent_reply', 'browser_read', 'browser_screenshot']

async function main(): Promise<void> {
  setMastermindRoot(join(tmpdir(), 'agentcanvas-mastermind-live'))
  resetMastermind()
  ensureSubscriptionAuth()

  const milestone: IssueMilestone = {
    kind: 'stalled',
    projectId: 'cv_beta',
    issueId: 'iss-login-form',
    ownerId: 'cd_3',
    detail: 'login form',
  }

  console.log('▶ reactor LIVE in nudge-only latitude against a `stalled` milestone…\n')
  const r = await runReaction(milestone, makeStubBus(), { mode: 'nudge' })

  console.log(`decision: ${r.text.trim() || '(no text)'}`)
  console.log(`held back (denied destructive verbs): ${r.attemptedActions.map((a) => a.tool).join(', ') || '(none)'}`)
  console.log(`session: ${r.sessionId || '(none)'}`)

  // The gate must never have denied a read or a message — only destructive verbs can
  // appear in the held-back list. (Whether the reactor chose to message is its judgment.)
  const latitudeHeld = r.attemptedActions.every((a) => a.tool !== 'send_to_agent' && !READS.includes(a.tool))
  const ok = !!r.sessionId && latitudeHeld
  console.log(`\n${'═'.repeat(48)}`)
  console.log(ok ? '✅ live nudge ran; perception + messaging allowed, destructive verbs denied' : '❌ latitude breached')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('LIVE SMOKE CRASHED:', e)
  process.exit(2)
})
