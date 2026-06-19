// The agent-facing ISSUE MCP server: a loopback HTTP MCP endpoint attached to
// every supervised `claude` card via `--mcp-config`, giving each agent the tools
// to act on the Mastermind issue board (MASTERMIND.md) — scoped to its canvas and
// **role-gated**. Same shape as agentBrowserMcp: a token-scoped stateless loopback
// server keyed per card by the `X-Canvas-Card` header (`$CANVAS_CARD_ID` from the
// tmux session, substituted into mcp.json by the CLI).
//
// It talks DIRECTLY to the in-process IssueStore (no command bus) — main is the
// single arbiter, so a write here is the same atomic check-then-append a human's
// click is. The card's **role** (resolved from the published RemoteState) decides
// which tools it gets AND what it can see — the org chart enforced at the tool layer:
//   - worker  → sees ONLY its own (lead-assigned) issues; advances / reports them.
//               It never self-claims — the lead assigns.
//   - planner → sees the whole canvas; create_plan / approve_plan (self-audit → deliver).
//   - lead    → sees the whole canvas; create_issue / set_deps / assign_issue /
//               set_sprint_state.
// Auditing is NOT a tool here — each role spawns its OWN adversarial subagents to
// audit its output before delivering (MASTERMIND.md). `request_workers` (lead →
// mastermind) and the mastermind loop are the next milestone.
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import {
  UNKNOWN_CARD,
  type AgentRole,
  type Issue,
  type IssueActionRequest,
  type IssueActionResult,
  type IssueSnapshot,
  type Plan,
  type RemoteState,
  type Sprint,
} from '../../shared/types'
import { failResult, okResult } from './mcpResults'

export interface AgentIssueMcpDeps {
  apply: (action: IssueActionRequest) => IssueActionResult
  snapshot: () => IssueSnapshot
  getState: () => RemoteState | null
  token: string
  /** A lead asks the mastermind to hire workers — spawns them on the lead's canvas
   *  and returns their card ids. (Wired to Orchestrator.requestWorkers.) */
  requestWorkers: (
    leadCardId: string,
    count: number,
    brief: string,
  ) => Promise<{ ok: boolean; workerIds: string[]; message?: string }>
}

const STATUSES = ['backlog', 'ready', 'claimed', 'in_progress', 'blocked', 'done'] as const
const SPRINT_STATES = [
  'DRAFT', 'PLAN_REVIEW', 'APPROVED', 'DECOMPOSED', 'EXECUTING', 'OUTCOME_REVIEW', 'DONE',
] as const
const KINDS = ['task', 'audit-gate', 'decision'] as const

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

  /** Build a per-request MCP server bound to the calling card, scoped to its
   *  canvas, with only the tools — and the visibility — its **role** grants. */
  private buildServer(cardId: string): McpServer {
    const server = new McpServer({ name: 'issues', version: '0.1.0' })
    const { apply, snapshot, getState, requestWorkers } = this.deps
    const noCard = !cardId || cardId === UNKNOWN_CARD
    const role: AgentRole = getState()?.cards.find((c) => c.id === cardId)?.role ?? 'worker'
    const isWorker = role === 'worker'

    const projectId = (): string | undefined =>
      getState()?.cards.find((c) => c.id === cardId)?.projectId

    const mySprints = (snap: IssueSnapshot, p: string): Sprint[] =>
      snap.sprints.filter((s) => s.projectId === p)

    const canvasIssues = (snap: IssueSnapshot, p: string): Issue[] => {
      const sprintIds = new Set(mySprints(snap, p).map((s) => s.id))
      const planIds = new Set(snap.plans.filter((pl) => sprintIds.has(pl.sprintRef)).map((pl) => pl.id))
      return snap.issues.filter((i) => planIds.has(i.planRef))
    }

    // A worker sees ONLY its own (lead-assigned) issues; planner/lead see the
    // whole canvas. Workers never self-claim — the lead assigns.
    const visibleIssues = (snap: IssueSnapshot, p: string): Issue[] => {
      const all = canvasIssues(snap, p)
      return isWorker ? all.filter((i) => i.owner === cardId) : all
    }

    const view = (issue: Issue, byId: Map<string, Issue>) => ({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      kind: issue.kind,
      owner: issue.owner,
      deps: issue.deps,
      openDeps: issue.deps.filter((d) => byId.get(d)?.status !== 'done'),
    })

    const pid = (): { id: string } | { error: string } => {
      if (noCard) return { error: 'No calling card id — cannot resolve which agent is acting.' }
      const id = projectId()
      if (!id) return { error: 'This card is not on a canvas — open it on a project first.' }
      return { id }
    }

    /** Resolve an issue the caller may act on (a worker: only its own). */
    const locate = (id: string): { issue: Issue; byId: Map<string, Issue> } | { error: string } => {
      const p = pid()
      if ('error' in p) return p
      const snap = snapshot()
      const issue = visibleIssues(snap, p.id).find((i) => i.id === id)
      if (!issue)
        return { error: isWorker ? `Issue ${id} isn't assigned to you.` : `No issue ${id} on this canvas.` }
      return { issue, byId: new Map(snap.issues.map((i) => [i.id, i])) }
    }

    const locateSprint = (id: string): { sprint: Sprint } | { error: string } => {
      const p = pid()
      if ('error' in p) return p
      const sprint = mySprints(snapshot(), p.id).find((s) => s.id === id)
      if (!sprint) return { error: `No sprint ${id} on this canvas.` }
      return { sprint }
    }

    const locatePlan = (id: string): { plan: Plan } | { error: string } => {
      const p = pid()
      if ('error' in p) return p
      const snap = snapshot()
      const sprintIds = new Set(mySprints(snap, p.id).map((s) => s.id))
      const plan = snap.plans.find((pl) => pl.id === id && sprintIds.has(pl.sprintRef))
      if (!plan) return { error: `No plan ${id} on this canvas.` }
      return { plan }
    }

    // ── Read tools (every role; visibility differs by role) ───────────────────
    server.registerTool(
      'get_vision',
      {
        description:
          "Read this canvas's vision — the product north star your work serves. Returns the current vision body, principles, and anti-vision. Read it before you plan, decompose, or build so your output heads toward the vision.",
        inputSchema: {},
      },
      async () => {
        const p = pid()
        if ('error' in p) return failResult(p.error)
        const snap = snapshot()
        const vision = snap.visions.find((v) => v.projectId === p.id)
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
        description: isWorker
          ? 'List the issues assigned to YOU on this canvas, with their status and openDeps (unfinished dependencies). Work them in dependency order.'
          : "List this canvas's issues — status, kind, owner, openDeps. Optionally filter by status to see the frontier or what each worker is doing.",
        inputSchema: { status: z.enum(STATUSES).optional().describe('Only return issues in this status') },
      },
      async ({ status }) => {
        const p = pid()
        if ('error' in p) return failResult(p.error)
        const snap = snapshot()
        const byId = new Map(snap.issues.map((i) => [i.id, i]))
        let mine = visibleIssues(snap, p.id)
        if (status) mine = mine.filter((i) => i.status === status)
        return okResult(mine.map((i) => view(i, byId)))
      },
    )

    server.registerTool(
      'get_issue',
      {
        description:
          'Get the full detail of one issue you can see: description (the steps), verify (acceptance criteria), deps, comments, and any recorded self-audit verdicts.',
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
      'comment_issue',
      {
        description: 'Leave a note on an issue you can see — progress, a finding, your self-audit summary. Visible on the board.',
        inputSchema: { id: z.string().describe('The issue id'), body: z.string().describe('The comment text') },
      },
      async ({ id, body }) => {
        const loc = locate(id)
        if ('error' in loc) return failResult(loc.error)
        const r = apply({ kind: 'issue.comment', id, author: cardId, body })
        return r.ok ? okResult({ id, commented: true }) : failResult(r.message ?? 'failed')
      },
    )

    // list_sprints is canvas structure — planner/lead only, not workers.
    if (!isWorker) {
      server.registerTool(
        'list_sprints',
        {
          description:
            "List this canvas's sprints with their state and plans — a planner finds the sprint to plan; a lead finds the approved plan to decompose and tracks the sprint.",
          inputSchema: {},
        },
        async () => {
          const p = pid()
          if ('error' in p) return failResult(p.error)
          const snap = snapshot()
          return okResult(
            mySprints(snap, p.id).map((s) => ({
              id: s.id,
              outcome: s.outcome,
              gapRationale: s.gapRationale,
              state: s.state,
              plans: snap.plans
                .filter((pl) => pl.sprintRef === s.id)
                .map((pl) => ({ id: pl.id, approved: pl.approved })),
            })),
          )
        },
      )

      server.registerTool(
        'get_plan',
        {
          description:
            "Read a plan's full blueprint — overview, stack, structure, dependency graph, and non-goals. Read the approved plan (its id comes from list_sprints) BEFORE you decompose it, so your issues faithfully cover what the planner actually wrote, not just the sprint outcome.",
          inputSchema: { id: z.string().describe('The plan id (from list_sprints)') },
        },
        async ({ id }) => {
          const loc = locatePlan(id)
          if ('error' in loc) return failResult(loc.error)
          const { plan } = loc
          return okResult({
            id: plan.id,
            sprintRef: plan.sprintRef,
            overview: plan.overview,
            stack: plan.stack,
            structure: plan.structure,
            deps: plan.deps,
            nonGoals: plan.nonGoals,
            approved: plan.approved,
          })
        },
      )
    }

    // ── Worker tools (advances its assigned issues; never self-claims) ────────
    if (role === 'worker') {
      server.registerTool(
        'update_issue_status',
        {
          description:
            "Advance an issue assigned to you: in_progress while working, then done once the work is finished AND you've self-audited it (spawn adversarial subagents to refute your work first).",
          inputSchema: {
            id: z.string().describe('The issue id (one assigned to you)'),
            status: z.enum(STATUSES).describe('The new status'),
          },
        },
        async ({ id, status }) => {
          const loc = locate(id)
          if ('error' in loc) return failResult(loc.error)
          const r = apply({ kind: 'issue.setStatus', id, status })
          return r.ok ? okResult({ id, status }) : failResult(r.message ?? 'update failed')
        },
      )

      server.registerTool(
        'report_blocker',
        {
          description:
            'Report that an issue assigned to you is blocked and why — sets it to blocked and records your reason as a comment so the lead can unblock or reassign. Use this instead of silently stalling.',
          inputSchema: {
            id: z.string().describe('The issue id (one assigned to you)'),
            reason: z.string().describe('What is blocking you'),
          },
        },
        async ({ id, reason }) => {
          const loc = locate(id)
          if ('error' in loc) return failResult(loc.error)
          apply({ kind: 'issue.comment', id, author: cardId, body: `BLOCKED: ${reason}` })
          const r = apply({ kind: 'issue.setStatus', id, status: 'blocked' })
          return r.ok ? okResult({ id, status: 'blocked' }) : failResult(r.message ?? 'failed')
        },
      )
    }

    // ── Planner tools ─────────────────────────────────────────────────────────
    if (role === 'planner') {
      server.registerTool(
        'create_sprint',
        {
          description:
            'Create the sprint your plan will serve — its outcome (definition of done) and which vision gap it closes. In partner mode, do this once you and the human have agreed what to build; then create_plan for it. Requires a committed vision on this canvas.',
          inputSchema: {
            outcome: z.string().describe('The outcome / definition-of-done'),
            gapRationale: z.string().describe('Which part of the vision this sprint closes'),
          },
        },
        async ({ outcome, gapRationale }) => {
          const p = pid()
          if ('error' in p) return failResult(p.error)
          const r = apply({ kind: 'sprint.create', projectId: p.id, outcome, gapRationale })
          return r.ok ? okResult({ sprintId: r.id }) : failResult(r.message ?? 'failed')
        },
      )

      server.registerTool(
        'create_plan',
        {
          description:
            "Write the plan for a sprint — the blueprint the lead will decompose. Research first (codebase + docs), then capture the approach. Self-audit it (spawn adversarial subagents to refute the stack/deps/structure) BEFORE approve_plan.",
          inputSchema: {
            sprintRef: z.string().describe('The sprint id this plan is for (from list_sprints)'),
            overview: z.string().describe('What the plan accomplishes, in prose'),
            stack: z.array(z.string()).describe('Tech/approach choices'),
            structure: z.string().describe('The structure/architecture, in prose'),
            deps: z.record(z.string(), z.array(z.string())).optional().describe('Plan-level dependency graph (node id → ids it depends on)'),
            nonGoals: z.array(z.string()).describe('What is explicitly out of scope'),
          },
        },
        async ({ sprintRef, overview, stack, structure, deps, nonGoals }) => {
          const loc = locateSprint(sprintRef)
          if ('error' in loc) return failResult(loc.error)
          const r = apply({
            kind: 'plan.create',
            sprintRef,
            overview,
            stack,
            structure,
            deps: deps ?? {},
            nonGoals,
          })
          return r.ok ? okResult({ planId: r.id }) : failResult(r.message ?? 'failed')
        },
      )

      server.registerTool(
        'approve_plan',
        {
          description:
            'Mark your plan ready AFTER it passes your self-audit — this is your delivery to the lead (advances the sprint to APPROVED). Do not call this until your adversarial subagents have signed off.',
          inputSchema: { id: z.string().describe('The plan id to deliver') },
        },
        async ({ id }) => {
          const loc = locatePlan(id)
          if ('error' in loc) return failResult(loc.error)
          const r = apply({ kind: 'plan.approve', id })
          return r.ok ? okResult({ id, approved: true }) : failResult(r.message ?? 'failed')
        },
      )
    }

    // ── Lead tools ────────────────────────────────────────────────────────────
    if (role === 'lead') {
      server.registerTool(
        'create_issue',
        {
          description:
            'Decompose the approved plan into one executable issue (title, impl steps, acceptance criteria). After decomposing, self-audit the WHOLE distribution (adversarial subagents: does it faithfully + completely cover the plan?) before assigning.',
          inputSchema: {
            planRef: z.string().describe('The plan id this issue belongs to (from list_sprints)'),
            title: z.string().describe('Issue title'),
            description: z.string().describe('The implementation steps'),
            verify: z.string().describe('Acceptance criteria — what "done" is checked against'),
            issueKind: z.enum(KINDS).describe('task | audit-gate | decision'),
            deps: z.array(z.string()).optional().describe('Issue ids this one depends on'),
            labels: z.array(z.string()).optional().describe('Optional labels'),
          },
        },
        async ({ planRef, title, description, verify, issueKind, deps, labels }) => {
          const loc = locatePlan(planRef)
          if ('error' in loc) return failResult(loc.error)
          const r = apply({ kind: 'issue.create', planRef, title, description, verify, issueKind, deps, labels })
          return r.ok ? okResult({ issueId: r.id }) : failResult(r.message ?? 'failed')
        },
      )

      server.registerTool(
        'set_deps',
        {
          description: 'Set the dependencies of an issue (the DAG edges) — issue ids it must wait on.',
          inputSchema: {
            id: z.string().describe('The issue id'),
            deps: z.array(z.string()).describe('Issue ids this one depends on'),
          },
        },
        async ({ id, deps }) => {
          const loc = locate(id)
          if ('error' in loc) return failResult(loc.error)
          const r = apply({ kind: 'issue.setDeps', id, deps })
          return r.ok ? okResult({ id, deps }) : failResult(r.message ?? 'failed')
        },
      )

      server.registerTool(
        'assign_issue',
        {
          description:
            'Assign an issue to a worker card (sets its owner) — the only way an issue gets an owner; workers never self-claim. Atomic: fails if already owned. Assign the ready frontier to the workers the mastermind spawned for you.',
          inputSchema: {
            id: z.string().describe('The issue id'),
            workerCardId: z.string().describe('The worker card id to assign it to'),
          },
        },
        async ({ id, workerCardId }) => {
          const loc = locate(id)
          if ('error' in loc) return failResult(loc.error)
          const r = apply({ kind: 'issue.claim', id, owner: workerCardId })
          return r.ok ? okResult({ id, owner: workerCardId }) : failResult(r.message ?? 'assign failed')
        },
      )

      server.registerTool(
        'set_sprint_state',
        {
          description:
            'Advance the sprint through its lifecycle (e.g. EXECUTING once issues are assigned, OUTCOME_REVIEW when the DAG drains, DONE after your closing self-audit of the assembled whole).',
          inputSchema: {
            id: z.string().describe('The sprint id'),
            state: z.enum(SPRINT_STATES).describe('The new sprint state'),
          },
        },
        async ({ id, state }) => {
          const loc = locateSprint(id)
          if ('error' in loc) return failResult(loc.error)
          const r = apply({ kind: 'sprint.setState', id, state })
          return r.ok ? okResult({ id, state }) : failResult(r.message ?? 'failed')
        },
      )

      server.registerTool(
        'request_workers',
        {
          description:
            'Ask the mastermind to hire N worker cards for this sprint — returns their card ids. Call this AFTER you have decomposed the plan into issues and self-audited the distribution; then assign_issue the ready frontier to the returned workers.',
          inputSchema: {
            count: z.number().min(1).max(8).describe('How many workers to hire'),
            brief: z.string().describe('One-line brief for the workers (what this sprint is about)'),
          },
        },
        async ({ count, brief }) => {
          if (noCard) return failResult('No calling card id.')
          const r = await requestWorkers(cardId, count, brief)
          return r.ok ? okResult({ workers: r.workerIds }) : failResult(r.message ?? 'hire failed')
        },
      )
    }

    return server
  }
}
