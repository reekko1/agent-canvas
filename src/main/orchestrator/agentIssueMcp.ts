// The agent-facing ISSUE MCP server: a loopback HTTP MCP endpoint attached to
// every supervised `claude` card via `--mcp-config`, giving each agent the
// worker-shaped tools to act on the Mastermind issue board (MASTERMIND.md) — read
// the canvas's vision, find ready issues, claim one (atomic), advance its status,
// comment, and report blockers. Same shape as agentBrowserMcp: a token-scoped
// stateless loopback server keyed per card by the `X-Canvas-Card` header
// (`$CANVAS_CARD_ID` from the tmux session, substituted into mcp.json by the CLI).
//
// It talks DIRECTLY to the in-process IssueStore (no command bus) — main is the
// single arbiter, so an agent's `claim` is the same check-then-append atomic write
// a human's click is. Scope is the caller's canvas (project), resolved from the
// published RemoteState; an agent never sees another canvas's issues. This is the
// WORKER slice of Milestone 2 — role-scoped lead/auditor tools and a mastermind
// that spawns role-cards come next.
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import {
  UNKNOWN_CARD,
  type Issue,
  type IssueActionRequest,
  type IssueActionResult,
  type IssueSnapshot,
  type RemoteState,
} from '../../shared/types'
import { errText, failResult, okResult } from './mcpResults'

export interface AgentIssueMcpDeps {
  /** Apply one mutation to the issue store (the single-arbiter write path). */
  apply: (action: IssueActionRequest) => IssueActionResult
  /** Read the whole issue-store projection. */
  snapshot: () => IssueSnapshot
  /** The latest published app state — resolves a caller card's project. */
  getState: () => RemoteState | null
  /** Shared with the hook sink: cards authenticate with the spine token. */
  token: string
}

const STATUSES = ['backlog', 'ready', 'claimed', 'in_progress', 'blocked', 'in_review', 'done'] as const

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

export class AgentIssueMcp {
  port = 0

  constructor(private readonly deps: AgentIssueMcpDeps) {}

  /** Bind the previous launch's port when possible — surviving tmux sessions read
   *  their mcp.json url once at launch, so the port must stay stable across app
   *  restarts (exactly like the hook sink and browser MCP). */
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
        console.error('[issue-mcp]', err)
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
      console.error('[issue-mcp] request failed', e)
      if (!res.headersSent) res.writeHead(500).end()
    }
  }

  /** Build a per-request MCP server whose tools are bound to the calling card and
   *  scoped to its canvas (project). */
  private buildServer(cardId: string): McpServer {
    const server = new McpServer({ name: 'issues', version: '0.1.0' })
    const { apply, snapshot, getState } = this.deps
    const noCard = !cardId || cardId === UNKNOWN_CARD

    /** The caller card's canvas (project) id, from the published state. */
    const projectId = (): string | undefined =>
      getState()?.cards.find((c) => c.id === cardId)?.projectId

    /** The issues belonging to the caller's canvas (issue → plan → sprint → project). */
    const projectIssues = (snap: IssueSnapshot, pid: string): Issue[] => {
      const sprintIds = new Set(snap.sprints.filter((s) => s.projectId === pid).map((s) => s.id))
      const planIds = new Set(snap.plans.filter((p) => sprintIds.has(p.sprintRef)).map((p) => p.id))
      return snap.issues.filter((i) => planIds.has(i.planRef))
    }

    /** A compact view of one issue for the agent, with its still-open deps. */
    const view = (issue: Issue, byId: Map<string, Issue>) => ({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      kind: issue.kind,
      owner: issue.owner,
      deps: issue.deps,
      openDeps: issue.deps.filter((d) => byId.get(d)?.status !== 'done'),
    })

    /** Resolve the caller's project + the issue it names, enforcing canvas scope. */
    const locate = (
      id: string,
    ): { pid: string; issue: Issue; mine: Issue[]; byId: Map<string, Issue> } | { error: string } => {
      if (noCard) return { error: 'No calling card id — cannot resolve which agent is acting.' }
      const pid = projectId()
      if (!pid) return { error: 'This card is not on a canvas — open it on a project first.' }
      const snap = snapshot()
      const mine = projectIssues(snap, pid)
      const issue = mine.find((i) => i.id === id)
      if (!issue) return { error: `No issue ${id} on this canvas.` }
      return { pid, issue, mine, byId: new Map(snap.issues.map((i) => [i.id, i])) }
    }

    server.registerTool(
      'get_vision',
      {
        description:
          "Read this canvas's vision — the product north star your work serves. Returns the current vision body, principles, and anti-vision. Read it before claiming work so your changes head toward the vision.",
        inputSchema: {},
      },
      async () => {
        if (noCard) return failResult('No calling card id.')
        const pid = projectId()
        if (!pid) return failResult('This card is not on a canvas.')
        const snap = snapshot()
        const vision = snap.visions.find((v) => v.projectId === pid)
        const cur = snap.versions.find((v) => v.id === vision?.currentVersion)
        if (!cur) return okResult({ set: false, message: 'No vision set for this canvas yet.' })
        return okResult({
          set: true,
          version: cur.n,
          body: cur.body,
          principles: cur.principles,
          antiVision: cur.antiVision,
        })
      },
    )

    server.registerTool(
      'list_issues',
      {
        description:
          "List this canvas's issues so you can find work. Each shows status, kind, owner, and openDeps (unfinished dependencies). An issue is yours to claim when it has no owner and no openDeps. Optionally filter by status.",
        inputSchema: {
          status: z.enum(STATUSES).optional().describe('Only return issues in this status'),
        },
      },
      async ({ status }) => {
        if (noCard) return failResult('No calling card id.')
        const pid = projectId()
        if (!pid) return failResult('This card is not on a canvas.')
        const snap = snapshot()
        const byId = new Map(snap.issues.map((i) => [i.id, i]))
        let mine = projectIssues(snap, pid)
        if (status) mine = mine.filter((i) => i.status === status)
        return okResult(mine.map((i) => view(i, byId)))
      },
    )

    server.registerTool(
      'get_issue',
      {
        description:
          'Get the full detail of one issue on this canvas: description (the steps), verify (acceptance criteria — what "done" is checked against), deps, comments, and any audit verdicts.',
        inputSchema: { id: z.string().describe('The issue id (from list_issues)') },
      },
      async ({ id }) => {
        const loc = locate(id)
        if ('error' in loc) return failResult(loc.error)
        const { issue, byId } = loc
        return okResult({
          ...view(issue, byId),
          description: issue.description,
          verify: issue.verify,
          phase: issue.phase,
          labels: issue.labels,
          comments: issue.comments,
          verdicts: issue.verdicts,
        })
      },
    )

    server.registerTool(
      'claim_issue',
      {
        description:
          "Claim an unowned issue so it's yours to work — atomic: if someone already owns it, this fails and you should pick another. Claim before you start; then do the work with your normal tools, and update_issue_status as you go.",
        inputSchema: { id: z.string().describe('The issue id to claim') },
      },
      async ({ id }) => {
        const loc = locate(id)
        if ('error' in loc) return failResult(loc.error)
        try {
          const r = apply({ kind: 'issue.claim', id, owner: cardId })
          return r.ok ? okResult({ claimed: id, status: 'claimed' }) : failResult(r.message ?? 'claim failed')
        } catch (e) {
          return failResult(errText(e))
        }
      },
    )

    server.registerTool(
      'update_issue_status',
      {
        description:
          "Advance an issue YOU own through its lifecycle: in_progress while working, in_review when the work is done and ready for an audit, done when accepted. You can only update an issue you've claimed.",
        inputSchema: {
          id: z.string().describe('The issue id (must be one you own)'),
          status: z.enum(STATUSES).describe('The new status'),
        },
      },
      async ({ id, status }) => {
        const loc = locate(id)
        if ('error' in loc) return failResult(loc.error)
        if (loc.issue.owner !== cardId)
          return failResult(`You don't own issue ${id} — claim it first.`)
        const r = apply({ kind: 'issue.setStatus', id, status })
        return r.ok ? okResult({ id, status }) : failResult(r.message ?? 'update failed')
      },
    )

    server.registerTool(
      'report_blocker',
      {
        description:
          "Report that an issue you own is blocked and why — sets it to blocked and records your reason as a comment so the human (or the mastermind) can unblock you. Use this instead of silently stalling.",
        inputSchema: {
          id: z.string().describe('The issue id (must be one you own)'),
          reason: z.string().describe('What is blocking you'),
        },
      },
      async ({ id, reason }) => {
        const loc = locate(id)
        if ('error' in loc) return failResult(loc.error)
        if (loc.issue.owner !== cardId)
          return failResult(`You don't own issue ${id} — claim it first.`)
        apply({ kind: 'issue.comment', id, author: cardId, body: `BLOCKED: ${reason}` })
        const r = apply({ kind: 'issue.setStatus', id, status: 'blocked' })
        return r.ok ? okResult({ id, status: 'blocked' }) : failResult(r.message ?? 'failed')
      },
    )

    server.registerTool(
      'comment_issue',
      {
        description:
          'Leave a progress note on an issue on this canvas — what you did, a finding, a question. Visible on the board.',
        inputSchema: {
          id: z.string().describe('The issue id'),
          body: z.string().describe('The comment text'),
        },
      },
      async ({ id, body }) => {
        const loc = locate(id)
        if ('error' in loc) return failResult(loc.error)
        const r = apply({ kind: 'issue.comment', id, author: cardId, body })
        return r.ok ? okResult({ id, commented: true }) : failResult(r.message ?? 'failed')
      },
    )

    server.registerTool(
      'release_issue',
      {
        description:
          "Give up an issue you claimed but can't complete, so it's free for someone else (it returns to ready).",
        inputSchema: { id: z.string().describe('The issue id (must be one you own)') },
      },
      async ({ id }) => {
        const loc = locate(id)
        if ('error' in loc) return failResult(loc.error)
        if (loc.issue.owner !== cardId)
          return failResult(`You don't own issue ${id}.`)
        const r = apply({ kind: 'issue.release', id })
        return r.ok ? okResult({ id, released: true }) : failResult(r.message ?? 'failed')
      },
    )

    return server
  }
}
