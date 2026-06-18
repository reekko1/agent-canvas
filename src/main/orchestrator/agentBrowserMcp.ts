// The agent-facing browser MCP server: a loopback HTTP MCP endpoint attached to
// every supervised `claude` card via `--mcp-config`, giving each agent the
// ability to see and control ITS OWN browser. The transport is HTTP (the CLI is
// a separate process, so it can't share the orchestrator's in-process MCP);
// otherwise it's the same shape as the hook sink — a token-scoped loopback server
// keyed per card by the `X-Canvas-Card` header (set from `$CANVAS_CARD_ID` in the
// tmux session and substituted into the mcp.json headers by the CLI).
//
// One verb obtains a browser (request_browser, idempotent via the ownership
// link), the rest drive it. There is NO discovery tool — an agent only ever sees
// its own browser, resolved from getState by ownerId. All browser effects flow
// through the SAME CommandBus the orchestrator uses, so the Tier-A driver in the
// renderer is reused verbatim. See BROWSER_AGENCY_PLAN.md §§3–6.
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { CommandBus } from './contract'
import type { RemoteState } from '../../shared/types'

export interface AgentBrowserMcpDeps {
  /** The live command bus — shared with the orchestrator. */
  bus: CommandBus
  /** The latest published app state, for resolving a caller's owned browser. */
  getState: () => RemoteState | null
  /** Shared with the hook sink: cards authenticate with the spine token. */
  token: string
  /** Resolve once a browser card's guest is mounted and dom-ready — replaces the
   *  old fixed settle after spawning, so the first read can't outrun the webview. */
  ensureReady: (cardId: string) => Promise<void>
}

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] })
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true })

/** Read and JSON-parse a request body (best-effort; {} on empty/malformed). */
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

export class AgentBrowserMcp {
  port = 0

  constructor(private readonly deps: AgentBrowserMcpDeps) {}

  /** Bind the previous launch's port when possible — surviving tmux sessions read
   *  their mcp.json (and its url) once at launch, so the port must stay stable
   *  across app restarts, exactly like the hook sink. Ephemeral is last resort. */
  start(preferredPort: number | undefined, onReady: (port: number) => void): void {
    const server = http.createServer((req, res) => void this.handle(req, res))
    let retriesLeft = 20
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferredPort && retriesLeft > 0) {
        retriesLeft--
        setTimeout(() => server.listen(preferredPort!, '127.0.0.1'), 500)
      } else if (err.code === 'EADDRINUSE' && preferredPort) {
        preferredPort = undefined
        server.listen(0, '127.0.0.1')
      } else {
        console.error('[browser-mcp]', err)
      }
    })
    server.on('listening', () => {
      this.port = (server.address() as { port: number }).port
      onReady(this.port)
    })
    server.listen(preferredPort ?? 0, '127.0.0.1')
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? ''
    if (!url.startsWith('/mcp') || req.headers['x-canvas-token'] !== this.deps.token) {
      res.writeHead(404).end()
      return
    }
    // Stateless: a fresh server + transport per request, keyed off the card
    // header. GET/DELETE (session SSE) are unused in this stateless mode.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed (stateless server).' },
          id: null,
        }),
      )
      return
    }
    const cardId = String(req.headers['x-canvas-card'] ?? '')
    const body = await readBody(req)
    const server = this.buildServer(cardId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      console.error('[browser-mcp] request failed', e)
      if (!res.headersSent) res.writeHead(500).end()
    }
  }

  /** Build a per-request MCP server whose tools are bound to the calling card. */
  private buildServer(cardId: string): McpServer {
    const server = new McpServer({ name: 'browser', version: '0.1.0' })
    const { bus, getState, ensureReady } = this.deps

    const ownedBrowser = (): RemoteState['cards'][number] | undefined =>
      getState()?.cards.find((c) => c.kind === 'browser' && c.ownerId === cardId)
    const noCard = !cardId || cardId === 'unknown'

    server.registerTool(
      'request_browser',
      {
        description:
          'Get a browser window that you control and can see. Returns the same browser if you already have one (your reason is updated); otherwise opens a new one on your canvas, linked to you. State WHY you need it — the reason shows on the browser card so the human knows what you are doing. After this, use browser_read / browser_navigate / browser_click / browser_type.',
        inputSchema: {
          reason: z.string().describe('Why you need the browser (e.g. "checking the login redirect") — shown to the human on the browser card'),
          url: z.string().optional().describe('Optional URL to open immediately'),
        },
      },
      async ({ reason, url }) => {
        if (noCard) return fail('No calling card id — cannot resolve which agent is requesting.')
        try {
          const owned = ownedBrowser()
          if (owned) {
            await bus.setBrowserReason(owned.id, reason)
            if (url) await bus.navigateBrowser(owned.id, url)
            return text({ browserId: owned.id, url: url ?? owned.url ?? 'about:blank', reason, reused: true })
          }
          const caller = getState()?.cards.find((c) => c.id === cardId)
          const r = await bus.openBrowser({ canvasId: caller?.projectId, url, ownerCardId: cardId, reason })
          if (!r.ok || !r.cardId) return fail(r.message)
          // Wait for the guest to actually mount + reach dom-ready, so the agent's
          // first browser_read can't outrun the webview. Tolerate a timeout — the
          // card exists; a first read will just report "not ready" and retry.
          await ensureReady(r.cardId).catch(() => {})
          return text({ browserId: r.cardId, url: url ?? 'about:blank', reason, reused: false })
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e))
        }
      },
    )

    const needBrowser = (): RemoteState['cards'][number] | { error: string } => {
      if (noCard) return { error: 'No calling card id.' }
      const owned = ownedBrowser()
      return owned ?? { error: "You don't have a browser yet — call request_browser first." }
    }

    server.registerTool(
      'browser_read',
      {
        description:
          'See your browser: returns its interactive elements (each with a stable `ref`, role, and name) plus the page text. Use the refs with browser_click / browser_type. Re-read after anything that changes the page — refs are only valid for the latest read.',
        inputSchema: {},
      },
      async () => {
        const b = needBrowser()
        if ('error' in b) return fail(b.error)
        const r = await bus.readBrowser(b.id)
        return r.ok && r.snapshot ? text(r.snapshot) : fail(r.message)
      },
    )

    server.registerTool(
      'browser_navigate',
      {
        description: 'Point your browser at a URL.',
        inputSchema: { url: z.string().describe('The URL to load') },
      },
      async ({ url }) => {
        const b = needBrowser()
        if ('error' in b) return fail(b.error)
        const r = await bus.navigateBrowser(b.id, url)
        return r.ok ? text(r) : fail(r.message)
      },
    )

    server.registerTool(
      'browser_click',
      {
        description: 'Click an element on your browser page. `ref` comes from the latest browser_read.',
        inputSchema: { ref: z.string().describe('Element ref from the latest browser_read') },
      },
      async ({ ref }) => {
        const b = needBrowser()
        if ('error' in b) return fail(b.error)
        const r = await bus.actBrowser(b.id, { kind: 'click', ref })
        return r.ok ? text(r) : fail(r.message)
      },
    )

    server.registerTool(
      'browser_type',
      {
        description:
          'Type text into an input/textarea on your browser page. `ref` comes from the latest browser_read. Set clear to replace existing text; set submit to press Enter afterward.',
        inputSchema: {
          ref: z.string().describe('Element ref from the latest browser_read'),
          text: z.string().describe('The text to type'),
          clear: z.boolean().optional().describe('Clear the field before typing'),
          submit: z.boolean().optional().describe('Press Enter after typing'),
        },
      },
      async ({ ref, text: value, clear, submit }) => {
        const b = needBrowser()
        if ('error' in b) return fail(b.error)
        const r = await bus.actBrowser(b.id, { kind: 'type', ref, text: value, clear, submit })
        return r.ok ? text(r) : fail(r.message)
      },
    )

    server.registerTool(
      'browser_scroll',
      {
        description: 'Scroll your browser page up or down by about one viewport, then browser_read again.',
        inputSchema: { direction: z.enum(['up', 'down']).describe('Scroll direction') },
      },
      async ({ direction }) => {
        const b = needBrowser()
        if ('error' in b) return fail(b.error)
        const r = await bus.actBrowser(b.id, { kind: 'scroll', direction })
        return r.ok ? text(r) : fail(r.message)
      },
    )

    server.registerTool(
      'browser_screenshot',
      {
        description:
          'Capture a screenshot of your browser page (an image). Prefer browser_read for acting; reach for a screenshot to inspect visual layout or canvas-rendered content the text snapshot cannot convey.',
        inputSchema: {},
      },
      async () => {
        const b = needBrowser()
        if ('error' in b) return fail(b.error)
        const r = await bus.screenshotBrowser(b.id)
        if (!r.ok || !r.image) return fail(r.message)
        const m = /^data:(.+?);base64,(.*)$/.exec(r.image)
        if (!m) return fail('screenshot was not a base64 data URL')
        return { content: [{ type: 'image' as const, data: m[2], mimeType: m[1] }] }
      },
    )

    return server
  }
}
