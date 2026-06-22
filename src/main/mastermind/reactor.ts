// The mastermind reactor: a fresh query() per milestone (a "reaction").
// systemPrompt = base identity + frozen memory snapshot (the volatility split:
// durable memory in the system prompt; the volatile milestone + live board are the
// user message). Skills load from our plugin dir; the canvas MCP gives it the same
// control verbs the orchestrator has (the real addition over the probe, which only
// narrated).
//
// Mode (canUseTool gate): `observe` perceives + reasons, every mutation denied+recorded
// (the default — the deterministic cascade drives the milestone and the reviewers learn
// from the reaction); `nudge` is live but limited to perceiving + messaging agents,
// destructive verbs denied+recorded (drives a stalled worker). The mode is computed from
// the milestone + whether the canvas is autonomous: a `stalled` worker on an autonomous
// canvas earns a live `nudge`, everything else `observe`. Wired from
// manager.notifyMilestone (which reacts in partner/autonomous; a live nudge needs autonomous).
import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { IssueMilestone } from '../../shared/types'
import type { CommandBus } from '../orchestrator/contract'
import { buildCanvasServer, READ_ONLY_TOOLS } from '../orchestrator/canvasServer'
import { REACTOR_MODEL } from './models'
import { snapshot } from './memory'
import { skillLoadingOptions } from './skills'
import { reactorCwd } from './paths'

const BASE = `You are one reflex of Rakan's always-on mastermind — the same agent who orchestrates the fleet, here reacting to a single milestone. You react to ONE milestone at a time: read it, decide the single best control action (spawn/route/staff/escalate/repair), and state your decision in 1-3 plain sentences. You never plan, code, or audit yourself. If one of your loaded skills matches the situation, invoke it and follow it.`

export interface Reaction {
  sessionId: string
  text: string
  invokedSkills: string[] // inputs of any Skill tool calls the reactor made
  deniedActions: { tool: string; input: unknown }[] // the mutations the gate held back (never the allowed send_to_agent)
  mode: ReactorMode // the latitude this reaction ran under (observe = nothing executed)
}

/** How much the reactor may DO this reaction:
 *  - observe: perceive + reason, every mutation denied + recorded (the default — the
 *             deterministic cascade drives the milestone; the reviewers learn from it).
 *  - nudge:   live, but only perceive + message agents (send_to_agent); destructive
 *             verbs (spawn/kill/reassign) denied + recorded (drives a stalled worker). */
export type ReactorMode = 'observe' | 'nudge'

export interface ReactionOptions {
  /** Force the latitude — smokes only. Normally computed from (kind, isAutonomous). */
  mode?: ReactorMode
  /** Whether the milestone's canvas is in autonomous mode — the one input to the computed
   *  latitude: a `stalled` worker there earns a live `nudge`, everything else `observe`. */
  isAutonomous?: boolean
}

// Live "nudge" latitude beyond reads: message an agent, nothing destructive.
const NUDGE_TOOLS = ['send_to_agent']

/** The per-mode tool gate, exported so it's unit-testable without a live query. */
export function isToolAllowed(toolName: string, mode: ReactorMode): boolean {
  if (toolName === 'Skill') return true
  const bare = toolName.replace(/^mcp__canvas__/, '')
  if ((READ_ONLY_TOOLS as readonly string[]).includes(bare)) return true
  return mode === 'nudge' && NUDGE_TOOLS.includes(bare)
}

// A mode-specific note appended to the system prompt so the reactor reasons WITHIN its
// latitude instead of attempting tools that will be denied.
const LATITUDE: Record<ReactorMode, string> = {
  observe: '',
  nudge:
    '\n\nLATITUDE: you may PERCEIVE and MESSAGE agents (canvas:send_to_agent) only — you cannot spawn, kill, or reassign cards. If a stall needs more than a nudge (a restart or reassignment), do NOT attempt it: message the sprint LEAD to handle it and say so in your decision. This latitude OVERRIDES any skill: if a loaded skill tells you to spawn, kill, or reassign, do not follow that step here — nudge the lead instead.',
}

/** A plain-language rendering of the milestone for the user message. */
function describeMilestone(m: IssueMilestone): string {
  const where = m.detail ? ` ("${m.detail}")` : ''
  return `[milestone] ${m.kind}${where} on canvas ${m.projectId}${m.issueId ? `, issue ${m.issueId}` : ''}${m.ownerId ? `, worker ${m.ownerId}` : ''}.`
}

export async function runReaction(
  milestone: IssueMilestone,
  bus: CommandBus,
  opts: ReactionOptions = {},
): Promise<Reaction> {
  // Observe by default; only a stalled worker on an autonomous canvas earns a live nudge.
  // opts.mode is a smoke-only override.
  const mode: ReactorMode =
    opts.mode ?? (milestone.kind === 'stalled' && opts.isAutonomous ? 'nudge' : 'observe')
  const operator = snapshot('operator')
  const product = milestone.projectId ? snapshot('product', milestone.projectId) : ''
  const mem = [operator && `OPERATOR:\n${operator}`, product && `PRODUCT:\n${product}`].filter(Boolean).join('\n\n')
  const base = BASE + LATITUDE[mode]
  const systemPrompt = mem ? `${base}\n\nWHAT YOU KNOW (memory):\n${mem}` : base

  const board = await bus.openCanvas()
  const prompt = `${describeMilestone(milestone)}\n\n${board}`

  const invokedSkills: string[] = []
  const deniedActions: { tool: string; input: unknown }[] = []
  let text = ''
  let sessionId = ''

  // observe: let it perceive (Skill + read-only canvas tools) but DENY + record every
  // mutation so it changes nothing. nudge: additionally allow send_to_agent.
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (isToolAllowed(toolName, mode)) return { behavior: 'allow', updatedInput: input }
    deniedActions.push({ tool: toolName.replace(/^mcp__canvas__/, ''), input })
    return { behavior: 'deny', message: `[mastermind:${mode}] action not permitted` }
  }

  const q = query({
    prompt,
    options: {
      model: REACTOR_MODEL,
      systemPrompt,
      // [SELF_EXTENSION_HOOK] The canvas MCP is the mastermind's one built-in arm
      // today. Self-extension (future) lands here: a tool the fleet builds for Rakan
      // (e.g. "build a CLI to watch my email") becomes another entry in this map — a
      // new arm the same mastermind can reach for. No registry/loader yet, by design.
      mcpServers: { canvas: buildCanvasServer(bus) },
      // Load the mastermind's learned skill library (see skillLoadingOptions: our skills
      // only, never `'all'`; + host-CLAUDE.md isolation). Same recipe as the orchestrator.
      ...skillLoadingOptions(),
      tools: ['Skill'],
      cwd: reactorCwd(),
      canUseTool,
    },
  })

  for await (const m of q) {
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'tool_use' && b.name === 'Skill') invokedSkills.push(JSON.stringify(b.input))
      }
    } else if (m.type === 'result') {
      sessionId = m.session_id
      if (m.subtype === 'success' && !text) text = m.result
    }
  }
  return { sessionId, text, invokedSkills, deniedActions, mode }
}
