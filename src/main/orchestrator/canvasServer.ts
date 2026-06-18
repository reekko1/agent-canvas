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

/** Read-only canvas tools — safe to auto-run. Single source of truth: the gate
 *  builds orchestrator.ts's READ_ONLY from this, and the `readOnlyHint` annotations
 *  on list_world / get_agent_reply below mirror it (keep the two in sync). */
export const READ_ONLY_TOOLS = [
  'list_world',
  'get_agent_reply',
  'browser_read',
  'browser_screenshot',
] as const

/** Build the `canvas` MCP server backed by a CommandBus implementation. */
export function buildCanvasServer(bus: CommandBus) {
  const listWorld = tool(
    'list_world',
    'List every canvas, the cards on each (with status and current task), and anything blocked waiting on the user. The open canvas is already given to you each turn — use this to see the OTHER canvases or to act on one that is not currently open.',
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

  const openBrowser = tool(
    'open_browser',
    'Open a new browser card (an in-app web view) on a canvas, optionally loading a starting URL. Use this to show a running dev server, docs, or any page beside the agents.',
    {
      canvasId: z.string().optional().describe('Target canvas id; defaults to the active canvas'),
      url: z.string().optional().describe('URL to load (e.g. "http://localhost:3000"); defaults to a blank page'),
      name: z.string().optional().describe('Name for the browser card'),
    },
    async (args) => {
      try {
        const r = await bus.openBrowser(args)
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`open_browser failed: ${errText(e)}`)
      }
    },
  )

  const navigateBrowser = tool(
    'navigate_browser',
    'Point an existing browser card at a URL. Use a browser card id from list_world (kind "browser").',
    {
      cardId: z.string().describe('Browser card id from list_world'),
      url: z.string().describe('The URL to navigate to'),
    },
    async (args) => {
      try {
        const r = await bus.navigateBrowser(args.cardId, args.url)
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`navigate_browser failed: ${errText(e)}`)
      }
    },
  )

  const browserRead = tool(
    'browser_read',
    "See a browser card's page: returns its interactive elements (each with a stable `ref`, role, and name) plus the page text. Use the refs with browser_click / browser_type. Re-read after any action that changes the page — refs are only valid for the latest read. Use a browser card id from list_world (kind \"browser\").",
    { cardId: z.string().describe('Browser card id from list_world') },
    async (args) => {
      try {
        const r = await bus.readBrowser(args.cardId)
        return r.ok && r.snapshot ? okResult(r.snapshot) : failResult(r.message)
      } catch (e) {
        return failResult(`browser_read failed: ${errText(e)}`)
      }
    },
    { annotations: { readOnlyHint: true } },
  )

  const browserScreenshot = tool(
    'browser_screenshot',
    "Capture a screenshot of a browser card's page (an image). Prefer browser_read for acting on the page; reach for a screenshot to inspect visual layout or canvas-rendered content that the text snapshot can't convey. Use a browser card id from list_world.",
    { cardId: z.string().describe('Browser card id from list_world') },
    async (args) => {
      try {
        const r = await bus.screenshotBrowser(args.cardId)
        if (!r.ok || !r.image) return failResult(r.message)
        const m = /^data:(.+?);base64,(.*)$/.exec(r.image)
        if (!m) return failResult('screenshot was not a base64 data URL')
        return { content: [{ type: 'image' as const, data: m[2], mimeType: m[1] }] }
      } catch (e) {
        return failResult(`browser_screenshot failed: ${errText(e)}`)
      }
    },
    { annotations: { readOnlyHint: true } },
  )

  const browserClick = tool(
    'browser_click',
    "Click an element on a browser card's page. `ref` comes from the latest browser_read. Use a browser card id from list_world.",
    {
      cardId: z.string().describe('Browser card id from list_world'),
      ref: z.string().describe('Element ref from the latest browser_read'),
    },
    async (args) => {
      try {
        const r = await bus.actBrowser(args.cardId, { kind: 'click', ref: args.ref })
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`browser_click failed: ${errText(e)}`)
      }
    },
  )

  const browserType = tool(
    'browser_type',
    "Type text into an input/textarea on a browser card's page. It focuses the field for you (a real click) — no separate browser_click needed first. `ref` comes from the latest browser_read. Set clear to replace existing text; set submit to press Enter afterward (e.g. to submit a search). Use a browser card id from list_world.",
    {
      cardId: z.string().describe('Browser card id from list_world'),
      ref: z.string().describe('Element ref from the latest browser_read'),
      text: z.string().describe('The text to type'),
      clear: z.boolean().optional().describe('Clear the field before typing'),
      submit: z.boolean().optional().describe('Press Enter after typing'),
    },
    async (args) => {
      try {
        const r = await bus.actBrowser(args.cardId, {
          kind: 'type',
          ref: args.ref,
          text: args.text,
          clear: args.clear,
          submit: args.submit,
        })
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`browser_type failed: ${errText(e)}`)
      }
    },
  )

  const browserScroll = tool(
    'browser_scroll',
    "Scroll a browser card's page up or down by roughly one viewport (to reveal elements outside the current view, then browser_read again). Use a browser card id from list_world.",
    {
      cardId: z.string().describe('Browser card id from list_world'),
      direction: z.enum(['up', 'down']).describe('Scroll direction'),
    },
    async (args) => {
      try {
        const r = await bus.actBrowser(args.cardId, { kind: 'scroll', direction: args.direction })
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`browser_scroll failed: ${errText(e)}`)
      }
    },
  )

  const browserSelect = tool(
    'browser_select',
    'Choose an option in a dropdown (<select>) on a browser card\'s page. `ref` comes from the latest browser_read. Use a browser card id from list_world.',
    {
      cardId: z.string().describe('Browser card id from list_world'),
      ref: z.string().describe('Element ref from the latest browser_read'),
      value: z.string().describe('The option value to select'),
    },
    async (args) => {
      try {
        const r = await bus.actBrowser(args.cardId, { kind: 'select', ref: args.ref, value: args.value })
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`browser_select failed: ${errText(e)}`)
      }
    },
  )

  const browserHistory = tool(
    'browser_history',
    "Navigate a browser card's history: go back, forward, or reload. Use a browser card id from list_world.",
    {
      cardId: z.string().describe('Browser card id from list_world'),
      action: z.enum(['back', 'forward', 'reload']).describe('back, forward, or reload'),
    },
    async (args) => {
      try {
        const r = await bus.actBrowser(args.cardId, { kind: 'history', action: args.action })
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`browser_history failed: ${errText(e)}`)
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

  const killCard = tool(
    'kill_card',
    "Close a card — permanently ends its agent or shell session and removes it from the canvas. This is destructive and cannot be undone; only use it when the user clearly asks to close, stop, or remove a specific card. Use a card id from list_world.",
    { cardId: z.string().describe('Card id from list_world') },
    async (args) => {
      try {
        const r = await bus.killCard(args.cardId)
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`kill_card failed: ${errText(e)}`)
      }
    },
  )

  const approveAsk = tool(
    'approve_ask',
    "Allow or deny a permission request an agent is blocked on. Use an ask id from list_world's approvals. A blocked agent is normally the user's call — only act when the user has clearly authorized it, by a direct request or a standing instruction. When unsure, leave it for the user.",
    {
      askId: z.string().describe("Ask id from list_world's approvals"),
      decision: z.enum(['allow', 'deny']).describe('allow or deny the request'),
    },
    async (args) => {
      try {
        const r = await bus.approveAsk(args.askId, args.decision)
        return r.ok ? okResult(r) : failResult(r.message)
      } catch (e) {
        return failResult(`approve_ask failed: ${errText(e)}`)
      }
    },
  )

  return createSdkMcpServer({
    name: 'canvas',
    version: '0.1.0',
    tools: [
      listWorld,
      focusCanvas,
      spawnAgent,
      openBrowser,
      navigateBrowser,
      browserRead,
      browserScreenshot,
      browserClick,
      browserType,
      browserScroll,
      browserSelect,
      browserHistory,
      sendToAgent,
      getAgentReply,
      renameAgent,
      killCard,
      approveAsk,
    ],
  })
}
