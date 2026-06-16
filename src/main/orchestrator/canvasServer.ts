// The in-process MCP server that exposes the CommandBus to the Agent SDK.
// Tools surface to the model as `mcp__canvas__<tool_name>`.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { CommandBus } from './contract'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const okResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
})
const failResult = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
})

/** Build the `canvas` MCP server backed by a CommandBus implementation. */
export function buildCanvasServer(bus: CommandBus) {
  const listWorld = tool(
    'list_world',
    'List every canvas, the cards on each (with status and current task), and anything blocked waiting on the user. Call this first so you reference real canvas and card ids.',
    {},
    async () => {
      try {
        return okResult(await bus.listWorld())
      } catch (e) {
        return failResult(`list_world failed: ${errText(e)}`)
      }
    },
    { annotations: { readOnlyHint: true } },
  )

  const focusCanvas = tool(
    'focus_canvas',
    'Switch the active canvas (bring it to the foreground). Pass a canvas id from list_world.',
    { canvasId: z.string().describe('Canvas id from list_world') },
    async (args) => {
      try {
        const r = await bus.focusCanvas(args.canvasId)
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`focus_canvas failed: ${errText(e)}`)
      }
    },
  )

  const spawnAgent = tool(
    'spawn_agent',
    'Spawn a new Claude agent card on a canvas, optionally with an initial instruction to start working on.',
    {
      canvasId: z.string().optional().describe('Target canvas id; defaults to the active canvas'),
      folder: z.string().optional().describe('Working directory; defaults to the canvas folder'),
      prompt: z.string().optional().describe('Initial instruction for the new agent'),
      name: z.string().optional().describe('Name for the new agent (e.g. "Chase"); defaults to "Agent N"'),
    },
    async (args) => {
      try {
        const r = await bus.spawnAgent(args)
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`spawn_agent failed: ${errText(e)}`)
      }
    },
  )

  const sendToAgent = tool(
    'send_to_agent',
    "Send a message — a new instruction or follow-up — to a running agent's terminal, as if the user typed it. Use a card id from list_world. If the agent is busy, the message is queued and processed when it next idles.",
    {
      cardId: z.string().describe('Agent card id from list_world'),
      message: z.string().describe('The instruction or follow-up to deliver to the agent'),
    },
    async (args) => {
      try {
        const r = await bus.sendToAgent(args.cardId, args.message)
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`send_to_agent failed: ${errText(e)}`)
      }
    },
  )

  const getAgentReply = tool(
    'get_agent_reply',
    "Read an agent's most recent full reply — its message from the last turn it finished. Use a card id from list_world. Returns empty if the agent hasn't finished a turn yet.",
    { cardId: z.string().describe('Agent card id from list_world') },
    async (args) => {
      try {
        const r = await bus.getAgentReply(args.cardId)
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`get_agent_reply failed: ${errText(e)}`)
      }
    },
    { annotations: { readOnlyHint: true } },
  )

  const renameAgent = tool(
    'rename_agent',
    'Rename an agent card so it can be referred to by name (e.g. "Chase"). Use a card id from list_world.',
    {
      cardId: z.string().describe('Agent card id from list_world'),
      name: z.string().describe('The new name'),
    },
    async (args) => {
      try {
        const r = await bus.renameAgent(args.cardId, args.name)
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`rename_agent failed: ${errText(e)}`)
      }
    },
  )

  return createSdkMcpServer({
    name: 'canvas',
    version: '0.1.0',
    tools: [listWorld, focusCanvas, spawnAgent, sendToAgent, getAgentReply, renameAgent],
  })
}
