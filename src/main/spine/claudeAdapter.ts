import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UNKNOWN_CARD } from '../../shared/types'
import { shellQuote, type CliAdapter, type Interpretation, type McpStageOpts } from './cliAdapter'
import * as events from './hookEvents'
import { BASELINE_SUPERVISION, CANVAS_SKILLS, PLUGIN_NAME, PLUGIN_VERSION, materializeSkill } from './instructions'

/// Claude Code adapter — the transport/config seam and the REFERENCE CliAdapter.
/// Installs scoped HTTP hooks (via --settings, leaving user config untouched) and
/// launches `claude` with them. The pure event interpretation lives in
/// ./hookEvents; this class delegates to it so the I/O seam stays separate from
/// the (testable) mapping.
export class ClaudeAdapter implements CliAdapter {
  readonly name = 'claude-code'
  readonly binary = 'claude'

  /** `dir` is the staging home (SPINE_DIR); `token` authenticates every staged
   *  channel (hooks + MCP) to the loopback servers. Both are constants of the
   *  spine's lifetime, so they're injected once instead of threaded per call. */
  constructor(
    private readonly dir: string,
    private readonly token: string,
  ) {}

  private settingsFile: string | null = null
  /** The materialized curated-skills plugin dir, attached to every card via
   *  `--plugin-dir`. Set by stageInstructions() at startup; null until then. */
  private pluginDir: string | null = null
  /** The materialized agent-MCP configs (server id → file path), all attached to
   *  every card via one variadic `--mcp-config`. Each entry is set by stageMcp()
   *  as its loopback server binds; a card launched before a server binds simply
   *  lacks that server's tools. */
  private mcpConfigFiles = new Map<string, string>()
  /** The always-on supervision briefing, written to disk by stageInstructions() and
   *  folded into launchCommand as `--append-system-prompt-file` — so every card boots
   *  with it guaranteed in context (not a soft auto-invoked skill). */
  private baselineFile: string | null = null

  /** Events acked instantly (status/feed material). PermissionRequest is
   *  configured separately as the held interactive channel. */
  private readonly telemetryEvents = [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'Notification', 'Elicitation',
    'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
    'Stop', 'StopFailure', 'SessionEnd',
  ]

  stageHooks(port: number): void {
    const url = `http://127.0.0.1:${port}/hook`
    const entry = (timeout: number, statusMessage?: string): Record<string, unknown> => ({
      type: 'http',
      url,
      timeout,
      headers: { 'X-Canvas-Card': '$CANVAS_CARD_ID', 'X-Canvas-Token': this.token },
      allowedEnvVars: ['CANVAS_CARD_ID'],
      ...(statusMessage ? { statusMessage } : {}),
    })
    const hooks: Record<string, unknown> = {}
    for (const e of this.telemetryEvents) hooks[e] = [{ hooks: [entry(5)] }]
    hooks['PermissionRequest'] = [{ hooks: [entry(600, 'Asking Agent Canvas…')] }]

    mkdirSync(this.dir, { recursive: true })
    const file = join(this.dir, 'hooks.json')
    writeFileSync(file, JSON.stringify({ hooks }, null, 2))
    chmodSync(file, 0o600) // carries the sink token — owner-readable only
    this.settingsFile = file
    console.log(`[adapter] wrote HTTP hooks (port ${port}) → ${file}`)
  }

  /** Materialize the two instruction channels — WITHOUT touching the user's
   *  `~/.claude`, mirroring how stageHooks keeps hooks out of user config. Both are
   *  rebuilt from scratch each call (so a removed/renamed skill never lingers) and
   *  staged at startup independent of the sink, so even a pre-bind launch is equipped.
   *   1. The always-on baseline briefing → `<dir>/baseline.md`, folded into the launch
   *      as `--append-system-prompt-file` (guaranteed in context, not auto-discovered).
   *   2. The on-demand role library (./instructions) → a Claude Code plugin under
   *      `<dir>/<PLUGIN_NAME>/` (a `.claude-plugin/plugin.json` manifest + one
   *      `skills/<name>/SKILL.md` per skill), attached via `--plugin-dir`. */
  stageInstructions(): void {
    mkdirSync(this.dir, { recursive: true })
    const baselineFile = join(this.dir, 'baseline.md')
    writeFileSync(baselineFile, BASELINE_SUPERVISION)
    this.baselineFile = baselineFile

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
    console.log(`[adapter] staged baseline + ${CANVAS_SKILLS.length} role skill(s) → ${this.dir}`)
  }

  /** Materialize one agent-MCP server's config — `<dir>/<id>-mcp.json`, an HTTP
   *  MCP server pointed at its loopback port — attached to every card via
   *  `--mcp-config`. The card identifies itself with the same `$CANVAS_CARD_ID`
   *  (tmux session env) the hooks use, substituted into the header by the CLI's
   *  `${VAR:-default}` expansion; the spine token authenticates. Written once the
   *  server's port is known (mirrors stageHooks), rebuilt each call. We do NOT
   *  pass --strict-mcp-config, so an agent keeps any MCP servers the user already
   *  configured globally — this only ADDS tools. (No per-tool timeout knob here:
   *  the CLI's MCP defaults already tolerate a held ask_user.) */
  stageMcp(id: string, port: number, _opts?: McpStageOpts): void {
    mkdirSync(this.dir, { recursive: true })
    const file = join(this.dir, `${id}-mcp.json`)
    const config = {
      mcpServers: {
        [id]: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: {
            'X-Canvas-Card': `\${CANVAS_CARD_ID:-${UNKNOWN_CARD}}`,
            'X-Canvas-Token': this.token,
          },
        },
      },
    }
    writeFileSync(file, JSON.stringify(config, null, 2))
    chmodSync(file, 0o600) // carries the sink token — owner-readable only
    this.mcpConfigFiles.set(id, file)
    console.log(`[adapter] wrote ${id} MCP config (port ${port}) → ${file}`)
  }

  launchCommand(initialPrompt?: string): string {
    const flags: string[] = []
    // Sink-not-ready (no settings) shouldn't happen, but degrade to bare claude.
    if (this.settingsFile) flags.push(`--settings ${shellQuote(this.settingsFile)}`)
    // The always-on supervision briefing, appended to the system prompt so it's
    // guaranteed in context on turn 0 (parity with codex's AGENTS.md) — the file
    // form avoids shell-quoting a multi-KB body. Takes one arg, so it's safe among
    // the flags (unlike the variadic --mcp-config below).
    if (this.baselineFile) flags.push(`--append-system-prompt-file ${shellQuote(this.baselineFile)}`)
    // Every agent card is equipped with the role-skill plugin.
    if (this.pluginDir) flags.push(`--plugin-dir ${shellQuote(this.pluginDir)}`)
    // Disable the native checklist + question tools so the CLI-agnostic canvas tools
    // (mcp__canvas__update_plan / ask_user) are the ONLY plan/question path — parity
    // with codex, where those built-ins are absent in normal mode. The variadic list
    // stops at the next `--flag` (the `--mcp-config` below), so ordering is load-bearing.
    flags.push('--disallowed-tools TodoWrite TaskCreate TaskUpdate AskUserQuestion')
    // …and with the per-card MCP servers (browser control, the issue board, the
    // canvas-core tools). `--mcp-config` is variadic (`<configs...>`), so every
    // staged file rides one flag — and the trailing `--` (below) still ends options.
    const mcpConfigs = [...this.mcpConfigFiles.values()]
    if (mcpConfigs.length) flags.push(`--mcp-config ${mcpConfigs.map(shellQuote).join(' ')}`)
    const base = flags.length ? `exec claude ${flags.join(' ')}` : 'exec claude'
    // An initial prompt makes the interactive session boot already working on
    // the task (`claude [prompt]`) — race-free vs. typing it in after launch.
    // The `--` is load-bearing: `--mcp-config` is variadic (`<configs...>`), so
    // without an explicit end-of-options marker it swallows the trailing prompt
    // as another MCP config and claude dies at startup (unknown-option / bad
    // config) — leaving the card "terminal exited". `--` ends option parsing so
    // the prompt is unambiguously the positional arg, whatever flags precede it.
    return initialPrompt ? `${base} -- ${shellQuote(initialPrompt)}` : base
  }

  /** Claude invokes a plugin skill as a slash command: `/plugin:skill`. */
  skillRef(name: string): string {
    return `/${PLUGIN_NAME}:${name}`
  }

  /** Claude Code IS the canonical hook schema — delegate wholesale. */
  interpret(name: string, payload: Record<string, any>): Interpretation {
    return events.interpret(name, payload)
  }
}
