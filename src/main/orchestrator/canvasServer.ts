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

  return createSdkMcpServer({
    name: 'canvas',
    version: '0.1.0',
    tools: [listWorld, focusCanvas, spawnAgent],
  })
}
