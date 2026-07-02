// The shared shell of every AGENT-facing MCP server: a token-scoped, stateless
// loopback HTTP endpoint attached to supervised cards via their staged per-card
// MCP config. A subclass supplies only its tools (`buildServer`) and a log tag —
// transport, auth, and the port-stability dance live here once. The calling card
// comes from the `X-Canvas-Card` header (a claude card's driver bakes the real
// cardId in directly; a codex card reads it from `CANVAS_CARD_ID` in its child
// env via `env_http_headers`); the spine token in `X-Canvas-Token` authenticates.
import http from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

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

export abstract class AgentMcpServer {
  port = 0
  /** Log tag (e.g. 'canvas-mcp'). */
  protected abstract readonly tag: string

  constructor(private readonly token: string) {}

  /** Build a per-request MCP server whose tools are bound to the calling card.
   *  Stateless: a fresh server + transport per POST, so there is no session to
   *  leak and any card can call at any time. */
  protected abstract buildServer(cardId: string): McpServer

  /** Bind the previous launch's port when possible — every server rebinds fresh
   *  on each app start (headless sessions don't survive a restart to care about
   *  port churn), but a stable port avoids needlessly rewriting a codex card's
   *  config.toml url or any firewall rule a user set up around it. Retries the
   *  persisted port ~10s (a dev hot-restart overlaps the dying process), then
   *  concedes to ephemeral as a last resort. */
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
        console.error(`[${this.tag}]`, err)
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
    if (!url.startsWith('/mcp') || req.headers['x-canvas-token'] !== this.token) {
      res.writeHead(404).end()
      return
    }
    // GET/DELETE (session SSE) are unused in stateless mode.
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
      console.error(`[${this.tag}] request failed`, e)
      if (!res.headersSent) res.writeHead(500).end()
    }
  }
}
