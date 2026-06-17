// Standalone CLI to sanity-check the orchestrator ↔ MCP ↔ CommandBus wiring,
// against the in-memory stub world, with a stdin y/N confirm gate. No Electron.
//
//   # Auths off your `claude login` session; export CLAUDE_CODE_OAUTH_TOKEN to override.
//   npm run orchestrator:harness -- "what canvases exist? then switch to beta-web"
import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { runOrchestrator, type GateDecision } from './orchestrator'
import { makeStubBus } from './stubBus'

/** One-shot input stream: yield the single prompt, then end so the streaming
 *  session completes after the turn. */
async function* once(prompt: string): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }
}

async function confirm(
  toolName: string,
  input: Record<string, unknown>,
): Promise<GateDecision> {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  const answer = (
    await rl.question(`\n⚠️  ${toolName}(${JSON.stringify(input)}) — allow? [y/N] `)
  )
    .trim()
    .toLowerCase()
  rl.close()
  return answer === 'y' || answer === 'yes'
    ? { allow: true }
    : { allow: false, reason: 'User denied this action at the confirmation gate.' }
}

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(' ').trim()
  if (!prompt) {
    console.error('usage: npm run orchestrator:harness -- "<prompt>"')
    process.exit(1)
  }

  await runOrchestrator({
    bus: makeStubBus(),
    input: once(prompt),
    gate: confirm,
    onEvent: (e) => {
      if (e.kind === 'assistant') console.log(`\n${e.text}`)
      else if (e.kind === 'tool') console.log(`  · tool → ${e.text}`)
      else if (e.kind === 'result') console.log(`\n✓ ${e.text}`)
      else console.error(`\n✗ ${e.text}`)
    },
  })
}

main().catch((e) => {
  console.error('\nharness error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
