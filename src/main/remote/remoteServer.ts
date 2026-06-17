import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { QuestionAnswers, RemoteState } from '../../shared/types'
import { composeAskNotification, type FreshAsk } from './notify'
import type { PushService } from './push'

/// One mobile terminal: a tmux client attached to a card's session, wrapped so
/// the transport stays agnostic about node-pty.
export interface TermSession {
  onData(cb: (data: string) => void): void
  onExit(cb: () => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Scroll history by `lines` (+back / −forward) via tmux copy-mode. */
  scroll(lines: number): void
  kill(): void
}

/** The mutating routes — gated behind the session token (see handle()). */
const MUTATIONS = new Set(['/subscribe', '/decide', '/answer', '/decline'])

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/// The remote panel: supervision — and the orbit Allow/Deny + answer-questions —
/// from any device on your tailnet. `GET /` serves a self-contained page,
/// `GET /state` the JSON snapshot, `POST /decide {id, allow}` answers a held
/// permission ask, `POST /answer {id, answers}` answers an AskUserQuestion,
/// `POST /decline {id}` declines one. Installable as a PWA (manifest + sw).
///
/// It binds loopback only; reachability is deliberately a proxy's job:
/// `tailscale serve --bg localhost:<port>` adds TLS + tailnet identity.
/// **Never expose it publicly** (Funnel, port-forward): the buttons approve
/// arbitrary tool calls on this machine. (Port of the Swift RemoteServer.)
export class RemoteServer {
  /** A decision arriving from the panel — same authority as the in-app
   *  toasts, routed to the same spine.decide. */
  onDecide?: (askId: string, allow: boolean) => void
  /** A held AskUserQuestion answered from the panel. */
  onAnswer?: (askId: string, answers: QuestionAnswers) => void
  /** A held AskUserQuestion declined from the panel. */
  onDecline?: (askId: string) => void

  /** Web-push delivery (set by the spine). Absent → the panel works, just no
   *  notifications. */
  push?: PushService
  /** True when the desktop window is focused — we skip the phone push then,
   *  since you're already looking at the canvas. */
  isDesktopFocused?: () => boolean
  /** Open a mobile terminal for a card (set by the spine) — a tmux client
   *  attached to the card's live session. */
  openTerminal?: (cardId: string, cols: number, rows: number) => TermSession | null

  port = 0
  // Per-session CSRF token. tailscale serve fronts the panel at an https origin,
  // so a loopback Origin check would break the real deployment; instead the
  // panel fetches this once (GET /token) and echoes it as x-canvas-token on
  // every mutating request — the custom header forces a CORS preflight, closing
  // the simple-request hole that lets a cross-origin tailnet page fire approvals.
  private token = randomBytes(16).toString('hex')
  private stateJSON = '{}'
  private latestState: RemoteState | null = null
  // The bundled mobile app (vite.remote.config → out/remote). Sits beside
  // out/main, where this file is bundled.
  private staticDir = join(__dirname, '../remote')
  // Actionable ask/question ids already pushed for — so we ping on the NEW one,
  // not every 2s republish. `primed` suppresses a burst for whatever's pending
  // at startup.
  private notified = new Set<string>()
  private primed = false

  start(preferredPort: number | undefined, onReady: (port: number) => void): void {
    const server = http.createServer((req, res) => this.handle(req, res))
    // WebSocket terminal: /term?card=<id>&cols=&rows= bridges to a tmux client.
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      if ((req.url ?? '').split('?')[0] !== '/term') return socket.destroy()
      wss.handleUpgrade(req, socket, head, (ws) => this.handleTerm(req, ws))
    })
    // Same stable-identity contract as the hook sink: a `tailscale serve` route
    // is pinned to this port across restarts, so retry the held port through a
    // dying old process (e.g. a dev hot-restart) before conceding to ephemeral.
    let retriesLeft = 20 // ~10s at 500ms
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferredPort && retriesLeft > 0) {
        retriesLeft--
        setTimeout(() => server.listen(preferredPort!, '127.0.0.1'), 500)
      } else if (err.code === 'EADDRINUSE' && preferredPort) {
        console.log(`[remote] port ${preferredPort} stuck after retries — falling back to ephemeral`)
        preferredPort = undefined
        server.listen(0, '127.0.0.1')
      } else {
        console.error('[remote]', err)
      }
    })
    server.on('listening', () => {
      this.port = (server.address() as { port: number }).port
      onReady(this.port)
    })
    server.listen(preferredPort ?? 0, '127.0.0.1')
  }

  /** Bridge a terminal WebSocket to a tmux client. Server→client frames are raw
   *  pty output; client→server frames are JSON: `{i}` input, `{r:[cols,rows]}`
   *  resize. Closing the socket detaches the client (the session survives). */
  private handleTerm(req: http.IncomingMessage, ws: WebSocket): void {
    const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
    // The card id reaches tmux as a `-t` target (and inside an `if-shell`
    // command string), so validate it here at the trust boundary — a tailnet
    // device must not smuggle tmux/shell metacharacters through. Legit ids are
    // `card-<base36>-<n>`; everything else is refused.
    const cardId = q.get('card') ?? ''
    const sess = /^[\w-]+$/.test(cardId)
      ? this.openTerminal?.(cardId, Number(q.get('cols')), Number(q.get('rows')))
      : null
    if (!sess) {
      ws.close()
      return
    }
    sess.onData((d) => ws.readyState === ws.OPEN && ws.send(d))
    sess.onExit(() => ws.close())
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString())
        if (typeof m.i === 'string') sess.write(m.i)
        else if (Array.isArray(m.r)) sess.resize(Number(m.r[0]), Number(m.r[1]))
        else if (typeof m.s === 'number') sess.scroll(m.s)
      } catch {
        // ignore malformed frames
      }
    })
    // A 'ws' 'error' with no listener is rethrown as an uncaught exception —
    // handle it (and reclaim the pty) so a dropped phone never crashes main.
    ws.on('error', () => {
      try {
        ws.terminate()
      } finally {
        sess.kill()
      }
    })
    // Heartbeat: reap a half-open socket (phone out of range / asleep) so its
    // tmux client + pty don't leak waiting on a close that never comes.
    let alive = true
    ws.on('pong', () => {
      alive = true
    })
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate()
        return
      }
      alive = false
      try {
        ws.ping()
      } catch {
        // socket already tearing down
      }
    }, 30_000)
    ws.on('close', () => {
      clearInterval(heartbeat)
      sess.kill()
    })
  }

  publish(state: RemoteState): void {
    this.stateJSON = JSON.stringify(state)
    this.latestState = state
    this.maybeNotify(state)
  }

  /** The most recently published state, for in-main readers (the orchestrator).
   *  Null until the renderer publishes its first snapshot. */
  getLatestState(): RemoteState | null {
    return this.latestState
  }

  /** Push when a NEW thing needs you — and only while the desktop isn't
   *  focused (you'd see it there otherwise). */
  private maybeNotify(state: RemoteState): void {
    const items: FreshAsk[] = [
      ...state.approvals.map((a) => ({ id: a.id, name: a.name, kind: 'approval' as const })),
      ...state.questions.map((q) => ({ id: q.id, name: q.name, kind: 'question' as const })),
    ]
    const current = new Set(items.map((i) => i.id))
    const fresh = items.filter((i) => !this.notified.has(i.id))
    this.notified = current

    if (!this.primed) {
      this.primed = true // first snapshot just seeds the set — no startup burst
      return
    }
    if (!fresh.length || !this.push || this.isDesktopFocused?.()) return

    const n = composeAskNotification(state, fresh)
    if (n) void this.push.notify(n)
  }

  /** Read a JSON POST body, then run `ok`. Malformed → 400. */
  private body(req: http.IncomingMessage, res: http.ServerResponse, ok: (obj: any) => boolean): void {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        if (!ok(JSON.parse(Buffer.concat(chunks).toString('utf8')))) throw new Error()
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      } catch {
        res.writeHead(400).end()
      }
    })
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(this.stateJSON)
      return
    }
    if (req.method === 'GET' && url === '/vapid') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(this.push?.publicKey ?? '')
      return
    }
    if (req.method === 'GET' && url === '/token') {
      // Unauthenticated by design: the panel fetches this once, then echoes it
      // back as x-canvas-token on every mutating request.
      res.writeHead(200, { 'content-type': 'text/plain' }).end(this.token)
      return
    }
    // Gate the mutating routes behind the session token — mismatch → 404 (the
    // same opaque refusal HookSink uses) so a probe can't even confirm the route.
    if (
      req.method === 'POST' &&
      MUTATIONS.has(url) &&
      req.headers['x-canvas-token'] !== this.token
    ) {
      res.writeHead(404).end()
      return
    }
    if (req.method === 'POST' && url === '/subscribe') {
      this.body(req, res, (o) => {
        if (typeof o?.endpoint !== 'string') return false
        this.push?.subscribe(o)
        return true
      })
      return
    }
    if (req.method === 'POST' && url === '/decide') {
      this.body(req, res, (o) => {
        if (typeof o.id !== 'string' || typeof o.allow !== 'boolean') return false
        this.onDecide?.(o.id, o.allow)
        return true
      })
      return
    }
    if (req.method === 'POST' && url === '/answer') {
      this.body(req, res, (o) => {
        if (typeof o.id !== 'string' || typeof o.answers !== 'object' || !o.answers) return false
        this.onAnswer?.(o.id, o.answers as QuestionAnswers)
        return true
      })
      return
    }
    if (req.method === 'POST' && url === '/decline') {
      this.body(req, res, (o) => {
        if (typeof o.id !== 'string') return false
        this.onDecline?.(o.id)
        return true
      })
      return
    }
    if (req.method === 'GET') {
      void this.serveStatic(url, res)
      return
    }
    res.writeHead(404).end()
  }

  /** Serve the bundled mobile app (out/remote) for any non-API GET. Path is
   *  normalized and confined to staticDir; a missing build → a hint, not a
   *  blank page. */
  private async serveStatic(url: string, res: http.ServerResponse): Promise<void> {
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '')
    const file = normalize(join(this.staticDir, rel))
    if (!file.startsWith(this.staticDir)) {
      res.writeHead(403).end()
      return
    }
    try {
      const data = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(data)
    } catch {
      if (rel === 'index.html') {
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end('<body style="font:15px sans-serif;padding:24px">Mobile panel not built — run <code>npm run build:remote</code>.</body>')
      } else {
        res.writeHead(404).end()
      }
    }
  }
}

