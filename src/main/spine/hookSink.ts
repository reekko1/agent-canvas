import http from 'node:http'

export interface HookRequest {
  cardId: string
  event: string
  payload: Record<string, unknown>
  /** Answer the hook. null = 200 empty ("no decision"); JSON string = a decision body.
   *  May be called later (the held PermissionRequest). Safe to call at most once. */
  respond: (body: string | null) => void
}

/// The local event sink: hook semantics over a loopback HTTP server. Each
/// Claude Code HTTP hook POSTs its JSON payload to /hook with the card id in
/// the X-Canvas-Card header. The response body is bidirectional: a request's
/// `respond` may be called later, keeping the connection open until the user
/// decides. (Port of the Swift HookSink + HTTPServer.)
export class HookSink {
  onRequest?: (req: HookRequest) => void
  port = 0

  constructor(readonly token: string) {}

  /** Bind the previous launch's port when possible (stable spine identity —
   *  tmux sessions outlive the app and their hooks must keep landing here);
   *  fall back to ephemeral if it's taken. */
  start(preferredPort: number | undefined, onReady: (port: number) => void): void {
    const server = http.createServer((req, res) => this.handle(req, res))
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferredPort) {
        console.log(`[sink] port ${preferredPort} taken — falling back to ephemeral`)
        preferredPort = undefined
        server.listen(0, '127.0.0.1')
      } else {
        console.error('[sink]', err)
      }
    })
    server.on('listening', () => {
      this.port = (server.address() as { port: number }).port
      onReady(this.port)
    })
    server.listen(preferredPort ?? 0, '127.0.0.1')
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/hook' || req.headers['x-canvas-token'] !== this.token) {
      // Wrong endpoint or missing/stale token: a bare 404 — an unauthenticated
      // peer learns nothing, and a hook with a stale config fails fast.
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let done = false
      // The hook's own timeout governs a held ask: if the client gives up and
      // closes, the late respond() must become a no-op, not a crash.
      res.on('close', () => { done = true })
      const respond = (body: string | null): void => {
        if (done) return
        done = true
        if (body) res.writeHead(200, { 'content-type': 'application/json' }).end(body)
        else res.writeHead(200).end()
      }
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        respond(null) // malformed → ack and move on
        return
      }
      const cardId = String(req.headers['x-canvas-card'] ?? '')
      const event = payload?.hook_event_name
      if (!cardId || typeof event !== 'string' || !this.onRequest) {
        respond(null)
        return
      }
      this.onRequest({ cardId, event, payload, respond })
    })
  }
}
