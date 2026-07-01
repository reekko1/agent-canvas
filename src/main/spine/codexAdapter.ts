import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shellQuote, type CliAdapter, type Interpretation, type McpStageOpts } from './cliAdapter'
import * as events from './hookEvents'
import { CANVAS_SKILLS } from '../mastermind/roleSkills'
import { BASELINE_SUPERVISION, materializeSkill } from './instructions'

/// The codex plugin + local-marketplace identifiers (see stageInstructions). One plugin
/// bundles the shipped role skills; the marketplace is a thin local wrapper codex
/// requires to install it.
const CODEX_MARKET = 'canvas'
const CODEX_PLUGIN = 'canvas-skills'

/// Remove every `[mcp_servers.*]` table from an existing config.toml, leaving
/// foreign tables (the plugin CLI's `[marketplaces]`/`[plugins]`) untouched — so
/// writeMcpConfig can rewrite its servers without clobbering the CLI's sections.
/// This config.toml lives in OUR private CODEX_HOME, so every mcp_servers table
/// in it is ours to own. Line-based: once a managed header is seen, drop lines
/// until the next top-level table header (`[`) or EOF. Our inline tables
/// (`http_headers = { … }`) are single-line, so they never start with `[` and
/// stay inside the dropped region.
function stripMcpTables(toml: string): string {
  const out: string[] = []
  let skipping = false
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) skipping = /^\s*\[mcp_servers\./.test(line)
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

/// Codex CLI adapter. Codex has hooks with a near-identical schema to Claude
/// Code — same PascalCase event names, same snake_case payload fields
/// (`hook_event_name`, `session_id`, `last_assistant_message`, `tool_name`) — so
/// the canonical hook-schema mapping in ./hookEvents applies wholesale. Two
/// things differ and are owned here:
///
///  1. Hook injection. Codex has no `--settings`-equivalent flag; it only
///     discovers hooks from `$CODEX_HOME`. So we redirect CODEX_HOME to a private
///     dir under SPINE_DIR (baked into the launch string), write our hooks.json
///     there, and symlink `auth.json` back to the real ~/.codex so the user's
///     `codex login` still authenticates. User config is left untouched — the
///     same invariant ClaudeAdapter holds via `--settings`.
///  2. Transport. Codex runs only `type:"command"` hooks, so each hook is a curl
///     that pipes the event JSON (stdin) to the loopback sink and relays the
///     sink's response (stdout) back as the hook's decision — the same
///     bidirectional channel Claude gets for free over `type:"http"`.
///
/// What transfers to Codex and what doesn't (all via the redirected CODEX_HOME):
///  - Baseline supervision briefing → `$CODEX_HOME/AGENTS.md` (read as global
///    guidance). So every codex card boots knowing it's a supervised card.
///  - Agent-browser MCP → `$CODEX_HOME/config.toml` `[mcp_servers.browser]`
///    (streamable-HTTP transport, same loopback server Claude cards use).
///  - The agent-facing MCP servers ARE staged: browser + issue both ride
///    `$CODEX_HOME/config.toml` (`[mcp_servers.*]`, streamable-HTTP, same loopback
///    servers Claude uses). So a codex card is MCP-complete — including the issue
///    board tools, the mechanical half of a Mastermind role.
///  - The role *skills* that drive those tools ARE shipped: stageInstructions
///    materializes a plugin under CODEX_HOME (`.codex-plugin/plugin.json` +
///    `skills/<n>/SKILL.md`) listed by a local marketplace
///    (`.agents/plugins/marketplace.json`), and installSkills runs
///    `codex plugin marketplace add` + `codex plugin add` lazily on the first codex launch
///    (idempotent; coexists with our `[mcp_servers.*]` via a table-scoped RMW). The whole
///    CANVAS_SKILLS library ships as-is — the bodies are CLI-neutral (they name only the
///    CLI-agnostic canvas tools `update_plan`/`ask_user`, and "spawn adversarial subagents"
///    works on codex too, which has its own subagents), so there is nothing to exclude.
///    (`[[skills.config]]` is toggle-only and `$CODEX_HOME/.agents/skills` isn't a root —
///    both dead ends; the plugin path is the one that works.)
export class CodexAdapter implements CliAdapter {
  readonly name = 'codex'
  readonly binary = 'codex'
  private readonly home: string
  private hooksReady = false
  // Agent-facing MCP servers accumulate here (each binds independently) so the
  // second to stage doesn't drop the first from the shared config.toml.
  private mcpServers = new Map<string, { port: number; toolTimeoutSec?: number }>()
  /** The local marketplace dir codex installs the role-skill plugin from. */
  private readonly marketDir: string
  /** Whether the role-skill plugin has been installed this process (lazy, on first
   *  codex launch) — so non-codex users never shell out to `codex plugin`. */
  private skillsInstalled = false

  constructor(
    spineDir: string,
    private readonly token: string,
  ) {
    this.home = join(spineDir, 'codex-home')
    this.marketDir = join(this.home, 'market')
  }

  /** Write hooks.json into the private CODEX_HOME and symlink `auth.json` to the
   *  real ~/.codex so a card inherits the user's `codex login`. Each event is a
   *  command hook that curls the sink; held asks (PermissionRequest) keep the
   *  connection open until the user decides. */
  stageHooks(port: number): void {
    // curl stdin (the event JSON) → sink; relay the sink's response body to
    // stdout as the hook decision. Empty response (telemetry) → `{}`, an inert
    // no-op that satisfies Codex's "Stop/PermissionRequest expect JSON" rule and
    // falls a permission ask through to the normal approval flow.
    // ponytail: depends on curl on PATH (always on macOS); a bundled forwarder if that ever breaks.
    const forward = (t: number): string =>
      `o=$(curl -s -m ${t} -X POST -H "X-Canvas-Card: $CANVAS_CARD_ID" -H "X-Canvas-Token: ${this.token}" ` +
      `--data-binary @- http://127.0.0.1:${port}/hook); [ -n "$o" ] && printf %s "$o" || printf '{}'`

    const cmd = (t: number): Record<string, unknown> => ({
      hooks: [{ type: 'command', command: forward(t), timeout: t }],
    })
    const hooks: Record<string, unknown> = {}
    for (const e of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop']) {
      hooks[e] = [cmd(10)]
    }
    hooks['PermissionRequest'] = [cmd(600)] // held decision channel — long timeout

    mkdirSync(this.home, { recursive: true })
    const file = join(this.home, 'hooks.json')
    writeFileSync(file, JSON.stringify({ hooks }, null, 2))

    // Reuse the user's login: symlink our CODEX_HOME/auth.json → ~/.codex/auth.json.
    // Absent (never ran `codex login`) → no link; the card's TUI prompts login.
    const realAuth = join(homedir(), '.codex', 'auth.json')
    const linkAuth = join(this.home, 'auth.json')
    try {
      rmSync(linkAuth, { force: true })
      if (existsSync(realAuth)) symlinkSync(realAuth, linkAuth)
    } catch {
      // symlink unsupported/permission — card falls back to its own login prompt
    }
    this.hooksReady = true
    console.log(`[codex] wrote command hooks (port ${port}) → ${file}`)
  }

  /** Deliver the shared always-on baseline (`BASELINE_SUPERVISION`) via
   *  `$CODEX_HOME/AGENTS.md` (read as global guidance; our CODEX_HOME is private) —
   *  codex's always-on channel, parity with Claude's `--append-system-prompt-file`.
   *  Runs at startup, sink-independent, like Claude's stageInstructions.
   *  Also materializes the role-skill plugin + its local marketplace under CODEX_HOME
   *  (rebuilt from scratch each startup so instructions.ts edits ship). The actual
   *  `codex plugin` install is deferred to the first codex launch (installSkills) so
   *  non-codex users never pay for it. Ships the whole CLI-neutral CANVAS_SKILLS
   *  library; the always-on baseline rides AGENTS.md instead (above), so it's not
   *  among them. */
  stageInstructions(): void {
    mkdirSync(this.home, { recursive: true })
    writeFileSync(join(this.home, 'AGENTS.md'), BASELINE_SUPERVISION)

    // Rebuild the marketplace from scratch so a removed/edited skill never lingers.
    rmSync(this.marketDir, { recursive: true, force: true })
    const pluginRoot = join(this.marketDir, 'plugins', CODEX_PLUGIN)
    mkdirSync(join(this.marketDir, '.agents', 'plugins'), { recursive: true })
    mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true })
    const shipped = CANVAS_SKILLS
    for (const s of shipped) materializeSkill(join(pluginRoot, 'skills'), s)
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
    console.log(`[codex] staged AGENTS.md + ${shipped.length} role skill(s) → ${this.marketDir}`)
  }

  /** Install the materialized role-skill plugin into CODEX_HOME via the `codex plugin`
   *  CLI (the only way that actually registers a plugin — a hand-written config.toml
   *  doesn't). Lazy + once-per-process: runs on the first codex launch, so users who
   *  never spawn a codex card never shell out. Idempotent across restarts (verified).
   *  Best-effort — if codex is missing or install fails, cards still run, just without
   *  the role skills (the issue MCP tools are still there; only the how-to is absent). */
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

  /** Attach one agent-facing MCP server via `$CODEX_HOME/config.toml` — Codex's
   *  streamable-HTTP transport, pointed at the same loopback server Claude cards
   *  use. The spine token rides a static header; the per-card id comes from
   *  `env_http_headers` reading `CANVAS_CARD_ID` out of the session env (set via
   *  tmux `-e`, the same var the hooks use). Each server binds independently, so
   *  they accumulate on the instance and config.toml is rewritten with everything
   *  known so far — whichever binds later doesn't drop the earlier ones. Codex
   *  auto-reads config.toml from CODEX_HOME — no launch flag needed.
   *  ponytail: our config.toml also means a codex card doesn't inherit the user's
   *  ~/.codex model/approval prefs (a pre-existing cost of the CODEX_HOME redirect). */
  stageMcp(id: string, port: number, opts?: McpStageOpts): void {
    this.mcpServers.set(id, { port, toolTimeoutSec: opts?.toolTimeoutSec })
    this.writeMcpConfig()
  }

  private writeMcpConfig(): void {
    // ponytail: token is hex/uuid — JSON.stringify yields a valid TOML basic string.
    // toolTimeoutSec: a server whose tools block on a human (canvas's ask_user)
    // declares it via stageMcp opts (Codex defaults to 60s); the rest are quick.
    const block = (name: string, s: { port: number; toolTimeoutSec?: number }): string =>
      [
        `[mcp_servers.${name}]`,
        `url = "http://127.0.0.1:${s.port}/mcp"`,
        'startup_timeout_sec = 20',
        ...(s.toolTimeoutSec ? [`tool_timeout_sec = ${s.toolTimeoutSec}`] : []),
        `http_headers = { "X-Canvas-Token" = ${JSON.stringify(this.token)} }`,
        'env_http_headers = { "X-Canvas-Card" = "CANVAS_CARD_ID" }',
        '',
      ].join('\n')
    mkdirSync(this.home, { recursive: true })
    const file = join(this.home, 'config.toml')
    // Read-modify-write: keep whatever the `codex plugin` CLI wrote ([marketplaces]/
    // [plugins]), strip our own server tables, append them fresh. So the skills-plugin
    // install and our MCP config share config.toml without clobbering each other.
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

  launchCommand(initialPrompt?: string): string {
    this.installSkills() // lazy, once-per-process — first codex card pays for it
    // Redirect CODEX_HOME so Codex reads our hooks (and the symlinked auth), never
    // the user's ~/.codex. `--dangerously-bypass-hook-trust` runs our provisioned
    // hooks without a manual trust step. `--ask-for-approval never` = auto-accept:
    // the model never pauses for human approval (failures just return to it), still
    // contained by the workspace-write sandbox. So a codex card runs unattended —
    // supervision is via the telemetry hooks (status/reply) and the ✕, NOT held
    // PermissionRequest asks (which never fire under `never`).
    const flags = this.hooksReady
      ? `--dangerously-bypass-hook-trust --sandbox workspace-write --ask-for-approval never`
      : `--sandbox workspace-write --ask-for-approval never`
    const home = this.hooksReady ? `CODEX_HOME=${shellQuote(this.home)} ` : ''
    const base = `${home}exec codex ${flags}`
    return initialPrompt ? `${base} ${shellQuote(initialPrompt)}` : base
  }

  /** Codex invokes a plugin skill as `$plugin:skill` — a literal `$` (the initial
   *  prompt is single-quoted by launchCommand, so the shell can't expand it). */
  skillRef(name: string): string {
    return `$${CODEX_PLUGIN}:${name}`
  }

  /** Codex adopted the canonical hook schema wholesale (same event names, same
   *  payload fields, same PermissionRequest decision bodies) — delegate to
   *  ./hookEvents; any future schema drift belongs here. NB the permission-ask
   *  branch is currently inert anyway: launchCommand passes
   *  `--ask-for-approval never`, so codex never emits a held PermissionRequest. */
  interpret(name: string, p: Record<string, any>): Interpretation {
    return events.interpret(name, p)
  }
}
