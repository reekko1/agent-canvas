// The agent-facing CANVAS-CORE MCP server: a loopback HTTP MCP endpoint attached
// to EVERY supervised card (any CLI) — the CLI-agnostic replacement for tools that
// used to be Claude built-ins. Rides the shared AgentMcpServer shell (agentMcp.ts),
// like agentBrowserMcp/agentIssueMcp. Unlike the issue MCP it is NOT role-gated —
// every card gets these tools.
//
// Tools:
//   - update_plan — the agent publishes its task checklist (the supervisor's primary
//     window into progress). Replaces the plan wholesale; emitted to the renderer as
//     a CardEvent.todoChange so the existing poster/checklist renders it unchanged.
//     Works identically on claude/codex/any CLI — the plan store is OURS, not the
//     CLI's native TodoWrite / update_plan (which are disabled / mode-gated).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  UNKNOWN_CARD,
  type AgentTodo,
  type CardEvent,
  type Question,
  type QuestionAnswers,
  type QuestionAskInfo,
} from '../../shared/types'
import { AgentMcpServer } from './agentMcp'
import { failResult, okResult } from './mcpResults'

export interface AgentCanvasMcpDeps {
  token: string
  /** Push a semantic update for a card to the renderer (same channel spine.onUpdate
   *  uses) — update_plan emits a todoChange through it. */
  emitCardEvent: (cardId: string, event: CardEvent) => void
  /** Surface a held question to the renderer (same channel spine.onQuestion uses) —
   *  ask_user holds until answered/declined through answer()/decline()/releaseFor(). */
  onQuestion: (ask: QuestionAskInfo) => void
}

// Anchors the tool enum to AgentTodo's documented status set. `blocked` is ours —
// a flat signal Claude's native checklist never had (it expressed blocking via
// dependency edges); fine for a glanceable per-card checklist.
const TODO_STATUS = ['pending', 'in_progress', 'blocked', 'completed'] as const

export class AgentCanvasMcp extends AgentMcpServer {
  protected readonly tag = 'canvas-mcp'

  /** Held ask_user calls, keyed by our own `q-<n>` ask id. The resolver settles the
   *  MCP tool call: a QuestionAnswers map = answered, null = declined. Distinct id
   *  prefix from the spine's `ask-<n>` so index.ts routes answers to the right holder. */
  private askSeq = 1
  private pending = new Map<
    string,
    { cardId: string; resolve: (answers: QuestionAnswers | null) => void }
  >()

  constructor(private readonly deps: AgentCanvasMcpDeps) {
    super(deps.token)
  }

  /** Answer a held ask_user with the chosen options — resolves the tool call.
   *  Returns false if this server doesn't own the ask (so index.ts falls to the spine). */
  answer(askId: string, answers: QuestionAnswers): boolean {
    const p = this.pending.get(askId)
    if (!p) return false
    this.pending.delete(askId)
    p.resolve(answers)
    return true
  }

  /** Decline a held ask_user — the tool call returns `{ declined: true }` so the
   *  agent proceeds. Returns false if not owned here. */
  decline(askId: string): boolean {
    const p = this.pending.get(askId)
    if (!p) return false
    this.pending.delete(askId)
    p.resolve(null)
    return true
  }

  /** Release a card's held questions (the fly-in path: focusing the terminal drops
   *  the toast). No native picker for an MCP call, so release = decline. */
  releaseFor(cardId: string): void {
    for (const [askId, p] of this.pending) {
      if (p.cardId === cardId) {
        this.pending.delete(askId)
        p.resolve(null)
      }
    }
  }

  protected buildServer(cardId: string): McpServer {
    const server = new McpServer({ name: 'canvas', version: '0.1.0' })
    const noCard = !cardId || cardId === UNKNOWN_CARD

    server.registerTool(
      'update_plan',
      {
        description:
          'Publish your task checklist to the human supervisor. Call this whenever your plan ' +
          'changes: at the start of a task with your initial steps, then again each time you ' +
          'begin or finish a step. Send your WHOLE current plan every time — it replaces the ' +
          'previous list. This checklist is the supervisor’s primary window into your ' +
          'progress, so keep it current and granular, with exactly one step in_progress.',
        inputSchema: {
          todos: z
            .array(
              z.object({
                content: z.string().describe('The step, imperative (e.g. "Add auth middleware")'),
                status: z
                  .enum(TODO_STATUS)
                  .describe('pending | in_progress | blocked | completed'),
                activeForm: z
                  .string()
                  .optional()
                  .describe('Present-continuous form shown while in_progress (e.g. "Adding auth middleware")'),
              }),
            )
            .describe('Your full current plan, in order — replaces the previous checklist'),
        },
      },
      async ({ todos }) => {
        if (noCard) return failResult('No calling card id — cannot resolve which card is planning.')
        const list: AgentTodo[] = todos.map((t, i) => ({
          id: `t${i}`,
          content: t.content,
          status: t.status,
          activeForm: t.activeForm,
        }))
        this.deps.emitCardEvent(cardId, { todoChange: { kind: 'replace', todos: list } })
        return okResult({ ok: true, count: list.length })
      },
    )

    server.registerTool(
      'ask_user',
      {
        description:
          'Ask the human supervisor to make a decision you genuinely cannot make yourself — a ' +
          'fork in the approach, a preference, a missing requirement at a trust boundary. Present ' +
          'concrete options; the human picks one (or types their own answer). This BLOCKS until ' +
          'they respond, so use it sparingly — decide implementation details yourself and reserve ' +
          'this for real forks. Returns their chosen answer per question, or { declined: true } if ' +
          'they dismissed it (proceed with your best judgment).',
        inputSchema: {
          questions: z
            .array(
              z.object({
                question: z.string().describe('The decision you need the human to make'),
                header: z
                  .string()
                  .optional()
                  .describe('A short chip label, ≤12 chars (e.g. "Auth method")'),
                options: z
                  .array(
                    z.object({
                      label: z.string().describe('The option, terse'),
                      description: z
                        .string()
                        .optional()
                        .describe('What this option means / its trade-off'),
                    }),
                  )
                  .min(2)
                  .max(4)
                  .describe('2–4 concrete choices (the human can also type their own)'),
                multiSelect: z
                  .boolean()
                  .optional()
                  .describe('Allow selecting several options instead of one'),
              }),
            )
            .min(1)
            .max(4)
            .describe('1–4 questions to ask at once'),
        },
      },
      async ({ questions }) => {
        if (noCard) return failResult('No calling card id — cannot resolve which card is asking.')
        const q: Question[] = questions.map((x) => ({
          question: x.question,
          header: x.header,
          options: x.options.map((o) => ({ label: o.label, description: o.description })),
          multiSelect: x.multiSelect,
        }))
        const askId = `q-${this.askSeq++}`
        const answers = await new Promise<QuestionAnswers | null>((resolve) => {
          this.pending.set(askId, { cardId, resolve })
          this.deps.onQuestion({ askId, cardId, questions: q })
        })
        return answers === null ? okResult({ declined: true }) : okResult({ answers })
      },
    )

    return server
  }
}
