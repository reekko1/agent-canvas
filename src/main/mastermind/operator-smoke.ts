// Smoke (REAL Sonnet review): proves the operator model grows from plain conversation
// with NO active canvas (the manual-mode case) — "my name is Rakan" lands in global
// operator memory.  npm run mastermind:operator
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setMastermindRoot, resetMastermind } from './paths'
import { ensureSubscriptionAuth } from './models'
import { recordConversation, drainLearning } from './learning'
import { snapshot } from './memory'

async function main(): Promise<void> {
  setMastermindRoot(join(tmpdir(), 'agentcanvas-mastermind-operator'))
  resetMastermind()
  ensureSubscriptionAuth()

  console.log('▶ user says (no active canvas, manual-like): "my name is Rakan, I prefer concise answers"\n')
  recordConversation('USER: hey — my name is Rakan, and I prefer concise, no-fluff answers.', undefined)
  await drainLearning()

  const op = snapshot('operator')
  console.log(`operator memory now:\n${op || '(empty)'}`)

  const ok = /rakan/i.test(op)
  console.log(`\n${'═'.repeat(48)}`)
  console.log(ok ? '✅ operator model learned the name from conversation (no canvas needed)' : '❌ name not captured')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('OPERATOR SMOKE CRASHED:', e)
  process.exit(2)
})
