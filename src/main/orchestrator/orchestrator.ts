// The orchestrator loop: an Agent SDK `query()` whose only tools are the
// in-process `canvas` MCP server. Read-only tools auto-run; mutating tools are
// routed through the host-provided `gate` (human-in-the-loop confirmation).
import { query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { buildCanvasServer } from './canvasServer'
import type { CommandBus } from './contract'
import type { OrchestratorEvent } from '../../shared/types'

const SYSTEM_PROMPT = `You are the orchestrator for Agent Canvas, a desktop app where the user runs fleets of coding agents arranged on "canvases" (each canvas is a project folder; each card on it is a Claude agent or a shell).

Your job is to drive the app on the user's behalf through the canvas tools — nothing else. You are NOT a coding agent: you never read or write files, run builds, or inspect repos. You operate the app. When the user asks you to tell or ask an existing agent to do something, use send_to_agent to relay the instruction to that agent (resolve which agent from list_world). After an agent finishes a turn, read its full reply with get_agent_reply to report back what it said.

Always call list_world before acting, so you reference real canvas and card ids rather than guessing. Keep replies short and concrete: state what you did (or are about to do) and the outcome. If a request is ambiguous (which canvas? which card?), ask one brief question instead of guessing.`

/** Tools the model may run without confirmation (read-only). */
const READ_ONLY = new Set<string>(['mcp__canvas__list_world', 'mcp__canvas__get_agent_reply'])

export type GateDecision = { allow: true } | { allow: false; reason: string }

export interface RunOptions {
  bus: CommandBus
  prompt: string
  /** Confirm a mutating tool call. Read-only tools never reach here. */
  gate: (toolName: string, input: Record<string, unknown>) => Promise<GateDecision>
  onEvent: (e: OrchestratorEvent) => void
  /** Resume a prior orchestrator session, so the chat is one continuous
   *  conversation rather than a fresh agent per message. */
  resume?: string
  /** Receives the session id (capture it to resume on the next turn). */
  onSessionId?: (id: string) => void
}

/** Run one orchestrator turn to completion, streaming events to `onEvent`. */
export async function runOrchestrator(opts: RunOptions): Promise<void> {
  const { bus, prompt, gate, onEvent } = opts

  // Subscription auth: a stray ANTHROPIC_API_KEY outranks CLAUDE_CODE_OAUTH_TOKEN
  // and would silently bill pay-as-you-go. Force the OAuth (subscription) path.
  delete process.env.ANTHROPIC_API_KEY
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error('CLAUDE_CODE_OAUTH_TOKEN not set — run `claude setup-token` and export it')
  }

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (READ_ONLY.has(toolName)) return { behavior: 'allow', updatedInput: input }
    const decision = await gate(toolName, input)
    return decision.allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: decision.reason }
  }

  for await (const m of query({
    prompt,
    options: {
      model: 'claude-opus-4-8',
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { canvas: buildCanvasServer(bus) },
      // Read-only tool is pre-approved; mutating ones fall through to canUseTool.
      allowedTools: ['mcp__canvas__list_world', 'mcp__canvas__get_agent_reply'],
      // Drop every built-in tool — the orchestrator only has canvas verbs.
      tools: [],
      canUseTool,
      // Continue the same conversation across chat turns.
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  })) {
    if (m.type === 'system' && m.subtype === 'init') {
      opts.onSessionId?.(m.session_id)
    } else if (m.type === 'assistant') {
      for (const block of m.message.content) {
        if (block.type === 'text') {
          if (block.text.trim()) onEvent({ kind: 'assistant', text: block.text })
        } else if (block.type === 'tool_use') {
          onEvent({ kind: 'tool', text: `${block.name} ${JSON.stringify(block.input)}` })
        }
      }
    } else if (m.type === 'result') {
      if (m.subtype === 'success') onEvent({ kind: 'result', text: m.result })
      else onEvent({ kind: 'error', text: `result: ${m.subtype}` })
    }
  }
}
