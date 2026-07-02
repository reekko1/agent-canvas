import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { query, type McpHttpServerConfig, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { CANVAS_SKILLS } from '../mastermind/roleSkills'
import { BASELINE_SUPERVISION, PLUGIN_NAME, PLUGIN_VERSION, materializeSkill } from './instructions'
import { ClaudeEventMapper } from './claudeEvents'
import type {
  AgentSession,
  CliDriver,
  McpStageOpts,
  SendOutcome,
  SessionCallbacks,
  SessionSpec,
} from './driver'

// Subscription auth: dropped once at module load (mirrors orchestrator.ts) —
// a stray ANTHROPIC_API_KEY would outrank CLAUDE_CODE_OAUTH_TOKEN and silently
// bill pay-as-you-go. Every card session then authenticates the same way the
// orchestrator does: CLAUDE_CODE_OAUTH_TOKEN if exported, else the host's
// stored `claude login` session.
delete process.env.ANTHROPIC_API_KEY

/// Claude Code driver — one long-lived Agent SDK `query()` per card, in
/// STREAMING INPUT mode (the SDK's recommended mode, the same pattern the
/// orchestrator uses): an async generator yields the initial prompt (turn 0)
/// then idles on a queue+wake pair until `send()` pushes the next message —
/// which the SDK accepts mid-turn, so `send` is always 'sent' for claude.
/// No hooks, no tmux, no pty: MCP servers are passed as a typed `mcpServers`
/// option (the per-card `X-Canvas-Card` header is the real cardId, baked in
/// directly — no more `${CANVAS_CARD_ID}` env-substitution hack), and the
/// role-skill library is a `plugins` entry loaded at construction.
export class ClaudeDriver implements CliDriver {
  readonly binary = 'claude'
  private pluginDir: string | null = null
  private mcpServers = new Map<string, { port: number; opts?: McpStageOpts }>()

  constructor(
    private readonly dir: string,
    private readonly token: string,
  ) {}

  /** Rebuild the role-skill plugin dir from scratch (a removed/renamed skill
   *  never lingers) — the same `.claude-plugin/plugin.json` + `skills/<n>/
   *  SKILL.md` shape the interactive-TUI adapter used, still valid as an SDK
   *  `plugins: [{ type: 'local', path }]` entry. The always-on baseline no
   *  longer needs a file — it rides `systemPrompt.append` directly. */
  stageInstructions(): void {
    const pluginDir = join(this.dir, PLUGIN_NAME)
    rmSync(pluginDir, { recursive: true, force: true })
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify(
        {
          name: PLUGIN_NAME,
          version: PLUGIN_VERSION,
          description: 'Agent Canvas Mastermind role skills, equipped into every supervised agent card.',
        },
        null,
        2,
      ),
    )
    for (const s of CANVAS_SKILLS) materializeSkill(join(pluginDir, 'skills'), s)
    this.pluginDir = pluginDir
    console.log(`[claude] staged ${CANVAS_SKILLS.length} role skill(s) → ${pluginDir}`)
  }

  /** No file to write — a headless session takes MCP servers as a typed
   *  option, built fresh in `start()` from whatever's been staged so far. */
  stageMcp(id: string, port: number, opts?: McpStageOpts): void {
    this.mcpServers.set(id, { port, opts })
  }

  skillRef(name: string): string {
    return `/${PLUGIN_NAME}:${name}`
  }

  start(spec: SessionSpec, cb: SessionCallbacks): AgentSession {
    const mapper = new ClaudeEventMapper()
    const queue: SDKUserMessage[] = []
    let wake: (() => void) | null = null
    let disposed = false
    let killedByUs = false
    let interruptedFlag = false
    let sessionId = spec.resume

    if (spec.initialPrompt) {
      queue.push({ type: 'user', message: { role: 'user', content: spec.initialPrompt }, parent_tool_use_id: null })
    }

    // The live input stream: yield everything queued, then idle until the
    // next send() wakes us. Returns only once `disposed` (kill()) — never
    // throws (a throwing generator aborts the SDK session opaquely).
    async function* input(): AsyncGenerator<SDKUserMessage> {
      while (!disposed) {
        while (queue.length) yield queue.shift() as SDKUserMessage
        if (disposed) break
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    }

    const mcpServersOpt: Record<string, McpHttpServerConfig> = {}
    for (const [id, { port, opts }] of this.mcpServers) {
      mcpServersOpt[id] = {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { 'X-Canvas-Card': spec.cardId, 'X-Canvas-Token': this.token },
        // McpHttpServerConfig.timeout is milliseconds; McpStageOpts carries
        // seconds (parity with codex's tool_timeout_sec) — the canvas
        // server's ask_user blocks on a human, so it declares a long one.
        ...(opts?.toolTimeoutSec ? { timeout: opts.toolTimeoutSec * 1000 } : {}),
      }
    }

    const q = query({
      prompt: input(),
      options: {
        cwd: spec.folder,
        ...(spec.resume ? { resume: spec.resume } : {}),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // The always-on supervision briefing, appended to Claude Code's own
        // system prompt (parity with the old --append-system-prompt-file).
        systemPrompt: { type: 'preset', preset: 'claude_code', append: BASELINE_SUPERVISION },
        // Parity with what the interactive-TUI card read (project/user/local
        // settings + CLAUDE.md) — an SDK session defaults to loading nothing.
        settingSources: ['user', 'project', 'local'],
        ...(this.pluginDir ? { plugins: [{ type: 'local' as const, path: this.pluginDir }] } : {}),
        // Disable the native checklist + question tools so the CLI-agnostic
        // canvas tools (mcp__canvas__update_plan / ask_user) are the ONLY
        // plan/question path — parity with codex, where those built-ins are
        // absent in normal mode.
        disallowedTools: ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion'],
        ...(Object.keys(mcpServersOpt).length ? { mcpServers: mcpServersOpt } : {}),
        // Stream assistant text deltas so the transcript fills in live.
        includePartialMessages: true,
      },
    })

    void (async () => {
      try {
        for await (const m of q) {
          const sid = (m as { session_id?: string }).session_id
          if (typeof sid === 'string') sessionId = sid
          // The turn we just interrupted closes with a non-success `result`
          // (the SDK reports an aborted turn as `error_during_execution`) —
          // that's expected, not a real failure; swallow it as a plain
          // system note instead of letting the mapper report it as `error`.
          if (m.type === 'result' && interruptedFlag) {
            interruptedFlag = false
            cb.onEvent({
              card: { status: 'idle', detail: 'Interrupted' },
              item: { id: randomUUID(), ts: Date.now(), kind: 'system', text: 'Interrupted' },
            })
            continue
          }
          for (const ev of mapper.map(m)) cb.onEvent(ev)
        }
        cb.onExit(killedByUs ? 'killed' : 'ended')
      } catch (err) {
        cb.onExit('error', err instanceof Error ? err.message : String(err))
      }
    })()

    return {
      cardId: spec.cardId,
      get sessionId(): string | undefined {
        return sessionId
      },
      send(text: string): SendOutcome {
        queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
        // Instant "I asked → working" feedback (codex shows running from its
        // turn.started wire event; the mapper also flips running on message_start,
        // but that's a beat later). No init race here: init fires once at mount.
        cb.onEvent({ card: { status: 'running' } })
        const w = wake
        wake = null
        w?.()
        return 'sent'
      },
      async interrupt(): Promise<void> {
        interruptedFlag = true
        await q.interrupt()
      },
      kill(): void {
        if (disposed) return
        disposed = true
        killedByUs = true
        void q.interrupt()
        const w = wake
        wake = null
        w?.()
      },
    }
  }
}
