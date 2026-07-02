import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { CANVAS_SKILLS } from '../mastermind/roleSkills'
import { BASELINE_SUPERVISION, materializeSkill } from './instructions'
import { CodexEventMapper } from './codexEvents'
import type {
  AgentSession,
  CliDriver,
  McpStageOpts,
  SendOutcome,
  SessionCallbacks,
  SessionSpec,
} from './driver'

/// The codex plugin + local-marketplace identifiers (see stageInstructions). One plugin
/// bundles the shipped role skills; the marketplace is a thin local wrapper codex
/// requires to install it. Ported from the retired codexAdapter.
const CODEX_MARKET = 'canvas'
const CODEX_PLUGIN = 'canvas-skills'

/// Remove every `[mcp_servers.*]` table from an existing config.toml, leaving
/// foreign tables (the plugin CLI's `[marketplaces]`/`[plugins]`) untouched —
/// so writeMcpConfig can rewrite its servers without clobbering the CLI's
/// sections. Line-based: once a managed header is seen, drop lines until the
/// next top-level table header (`[`) or EOF.
function stripMcpTables(toml: string): string {
  const out: string[] = []
  let skipping = false
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) skipping = /^\s*\[mcp_servers\./.test(line)
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

/// Codex driver — turn-batched: `codex exec --json` is spawned fresh per turn
/// (no live process between turns), so a card's "session" is really a thread
/// id plus a small state machine (idle/running + a FIFO queue for messages
/// that arrive mid-turn — codex has no mid-turn input channel). Verified
/// empirically: a SIGKILLed turn resumes with zero redone work (codex
/// persists its transcript incrementally), so `interrupt()` is a plain kill.
///
/// Everything the old CODEX_HOME staging did for the interactive TUI still
/// applies unchanged — AGENTS.md baseline, the role-skill plugin marketplace,
/// config.toml MCP blocks — because `codex exec` reads the same CODEX_HOME.
/// What's gone is the hook staging (curl command-hooks, `hooks.json`,
/// `--dangerously-bypass-hook-trust`): `--json` emits the event stream
/// natively, so there's nothing left to reverse-engineer from hooks.
export class CodexDriver implements CliDriver {
  readonly binary = 'codex'
  private readonly home: string
  private readonly marketDir: string
  // Agent-facing MCP servers accumulate here (each binds independently) so the
  // second to stage doesn't drop the first from the shared config.toml.
  private mcpServers = new Map<string, { port: number; toolTimeoutSec?: number }>()
  /** Whether the role-skill plugin has been installed this process (lazy, on
   *  first codex launch) — so non-codex users never shell out to `codex plugin`. */
  private skillsInstalled = false

  constructor(
    spineDir: string,
    private readonly token: string,
  ) {
    this.home = join(spineDir, 'codex-home')
    this.marketDir = join(this.home, 'market')
  }

  /** Deliver the shared always-on baseline via `$CODEX_HOME/AGENTS.md`, reuse
   *  the user's `codex login` via a symlinked `auth.json` (CODEX_HOME is
   *  private, so there's nothing else to inherit from `~/.codex`), and
   *  materialize the role-skill plugin + its local marketplace. Rebuilt from
   *  scratch each call so an edit/removal ships on the next spine start. */
  stageInstructions(): void {
    mkdirSync(this.home, { recursive: true })
    writeFileSync(join(this.home, 'AGENTS.md'), BASELINE_SUPERVISION)

    const realAuth = join(homedir(), '.codex', 'auth.json')
    const linkAuth = join(this.home, 'auth.json')
    try {
      rmSync(linkAuth, { force: true })
      if (existsSync(realAuth)) symlinkSync(realAuth, linkAuth)
    } catch {
      // symlink unsupported/permission — card falls back to its own login prompt
    }

    rmSync(this.marketDir, { recursive: true, force: true })
    const pluginRoot = join(this.marketDir, 'plugins', CODEX_PLUGIN)
    mkdirSync(join(this.marketDir, '.agents', 'plugins'), { recursive: true })
    mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true })
    for (const s of CANVAS_SKILLS) materializeSkill(join(pluginRoot, 'skills'), s)
    writeFileSync(
      join(pluginRoot, '.codex-plugin', 'plugin.json'),
      JSON.stringify(
        {
          name: CODEX_PLUGIN,
          version: '0.1.0',
          description: 'Agent Canvas Mastermind role skills for supervised codex cards.',
          skills: './skills/',
        },
        null,
        2,
      ),
    )
    writeFileSync(
      join(this.marketDir, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify(
        {
          name: CODEX_MARKET,
          interface: { displayName: 'Agent Canvas' },
          plugins: [
            {
              name: CODEX_PLUGIN,
              source: { source: 'local', path: `./plugins/${CODEX_PLUGIN}` },
              policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
            },
          ],
        },
        null,
        2,
      ),
    )
    this.skillsInstalled = false // fresh materialization — reinstall on next launch
    console.log(`[codex] staged AGENTS.md + ${CANVAS_SKILLS.length} role skill(s) → ${this.marketDir}`)
  }

  /** Install the materialized role-skill plugin into CODEX_HOME via the `codex
   *  plugin` CLI (the only way that actually registers a plugin). Lazy +
   *  once-per-process: runs on the first codex card, so users who never spawn
   *  one never shell out. Best-effort — a failure just leaves cards without
   *  the role skills (the issue MCP tools still work). */
  private installSkills(): void {
    if (this.skillsInstalled) return
    this.skillsInstalled = true // one attempt per process — never retry-loop on failure
    if (!existsSync(join(this.marketDir, '.agents', 'plugins', 'marketplace.json'))) return
    const env = { ...process.env, CODEX_HOME: this.home }
    try {
      execFileSync('codex', ['plugin', 'marketplace', 'add', this.marketDir], { env, stdio: 'ignore' })
      execFileSync('codex', ['plugin', 'add', `${CODEX_PLUGIN}@${CODEX_MARKET}`], { env, stdio: 'ignore' })
      console.log(`[codex] installed ${CODEX_PLUGIN} role skills`)
    } catch (e) {
      console.log(`[codex] role-skill install skipped: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Attach one agent-facing MCP server via `$CODEX_HOME/config.toml` —
   *  Codex's streamable-HTTP transport, pointed at the same loopback server
   *  claude cards use. Each server binds independently, so they accumulate on
   *  the instance and config.toml is rewritten with everything known so far. */
  stageMcp(id: string, port: number, opts?: McpStageOpts): void {
    this.mcpServers.set(id, { port, toolTimeoutSec: opts?.toolTimeoutSec })
    this.writeMcpConfig()
  }

  private writeMcpConfig(): void {
    const block = (name: string, s: { port: number; toolTimeoutSec?: number }): string =>
      [
        `[mcp_servers.${name}]`,
        `url = "http://127.0.0.1:${s.port}/mcp"`,
        'startup_timeout_sec = 20',
        ...(s.toolTimeoutSec ? [`tool_timeout_sec = ${s.toolTimeoutSec}`] : []),
        // MCP tool approval is a SEPARATE subsystem from `--ask-for-approval
        // never` — un-annotated MCP tools prompt regardless (verified against
        // codex source). `approve` short-circuits it: these are our own
        // loopback tools on an unattended card — never prompt.
        'default_tools_approval_mode = "approve"',
        `http_headers = { "X-Canvas-Token" = ${JSON.stringify(this.token)} }`,
        'env_http_headers = { "X-Canvas-Card" = "CANVAS_CARD_ID" }',
        '',
      ].join('\n')
    mkdirSync(this.home, { recursive: true })
    const file = join(this.home, 'config.toml')
    // Read-modify-write: keep whatever the `codex plugin` CLI wrote
    // ([marketplaces]/[plugins]), strip our own server tables, append fresh.
    let foreign = ''
    try {
      foreign = stripMcpTables(readFileSync(file, 'utf8')).replace(/\s+$/, '')
    } catch {
      // no config.toml yet (first write, before any plugin install) — start clean
    }
    const ours = [...this.mcpServers.entries()].map(([name, s]) => block(name, s))
    const combined =
      [foreign || '# Agent Canvas — generated. Redirected CODEX_HOME.', ours.join('\n')]
        .filter(Boolean)
        .join('\n\n') + '\n'
    writeFileSync(file, combined)
    chmodSync(file, 0o600) // carries the sink token — owner-readable only
    const staged = [...this.mcpServers.entries()].map(([n, s]) => `${n}=${s.port}`).join(' ')
    console.log(`[codex] wrote MCP config (${staged}) → ${file}`)
  }

  /** Codex invokes a plugin skill as `$plugin:skill` — a literal `$` (the
   *  prompt travels over stdin, never shell-expanded). */
  skillRef(name: string): string {
    return `$${CODEX_PLUGIN}:${name}`
  }

  start(spec: SessionSpec, cb: SessionCallbacks): AgentSession {
    this.installSkills() // lazy, once-per-process — first codex card pays for it
    const mapper = new CodexEventMapper()
    const env = { ...process.env, CODEX_HOME: this.home, CANVAS_CARD_ID: spec.cardId }
    const shell = process.env.SHELL ?? '/bin/zsh'

    let sessionId = spec.resume
    let running = false
    let disposed = false
    let interruptedByUs = false
    let killedByUs = false
    const queue: string[] = []
    let child: ChildProcessWithoutNullStreams | null = null

    const runTurn = (text: string): void => {
      running = true
      interruptedByUs = false
      // `codex exec` dropped the `--ask-for-approval` flag (0.136.0); the config
      // override is the exec-mode equivalent. ponytail: -c over flag because the flag is gone.
      const args = ['exec', '--json', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"']
      if (sessionId) args.push('resume', sessionId)
      // The prompt travels over stdin (`-`), never interpolated into the
      // shell command — no quoting concern for model/user-authored text.
      args.push('-')
      const inner = `exec codex ${args.join(' ')}`
      const c = spawn(shell, ['-lc', inner], { cwd: spec.folder, env })
      child = c
      c.stdin.end(text)

      let stderrTail = ''
      c.stderr.on('data', (d: Buffer) => {
        stderrTail = (stderrTail + d.toString()).slice(-2000)
      })

      const rl = createInterface({ input: c.stdout })
      rl.on('line', (line) => {
        if (!line.trim()) return
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(line)
        } catch {
          return // non-JSON noise on stdout — ignore
        }
        if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') {
          sessionId = parsed.thread_id
        }
        for (const ev of mapper.map(parsed)) cb.onEvent(ev)
      })

      c.on('close', (code) => {
        running = false
        child = null
        if (interruptedByUs) {
          interruptedByUs = false
          cb.onEvent({
            card: { status: 'idle', detail: 'Interrupted' },
            item: { id: randomUUID(), ts: Date.now(), kind: 'system', text: 'Interrupted' },
          })
        } else if (code !== 0 && code !== null) {
          cb.onEvent({
            card: { status: 'error', detail: `codex exited (${code})`, noteworthy: true },
            item: {
              id: randomUUID(),
              ts: Date.now(),
              kind: 'error',
              text: stderrTail || `codex exited with code ${code}`,
            },
          })
        }
        if (disposed) {
          cb.onExit(killedByUs ? 'killed' : 'ended')
          return
        }
        if (queue.length) {
          // Coalesce everything queued while the turn was in flight into one
          // resume turn — codex has no mid-turn input channel.
          const next = queue.splice(0).join('\n\n')
          runTurn(next)
        }
      })

      c.on('error', (err) => {
        running = false
        child = null
        cb.onEvent({
          card: { status: 'error', detail: `codex failed to start: ${err.message}`, noteworthy: true },
          item: { id: randomUUID(), ts: Date.now(), kind: 'error', text: err.message },
        })
        if (disposed) cb.onExit('error', err.message)
      })
    }

    if (spec.initialPrompt) runTurn(spec.initialPrompt)

    return {
      cardId: spec.cardId,
      get sessionId(): string | undefined {
        return sessionId
      },
      send(text: string): SendOutcome {
        if (running) {
          queue.push(text)
          return 'queued'
        }
        runTurn(text)
        return 'sent'
      },
      async interrupt(): Promise<void> {
        if (!running || !child) return
        interruptedByUs = true
        child.kill('SIGKILL')
      },
      kill(): void {
        disposed = true
        queue.length = 0
        if (running && child) {
          killedByUs = true
          child.kill('SIGKILL')
        } else {
          cb.onExit('killed')
        }
      },
    }
  }
}
