import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentTodo, CardEvent, Question, QuestionAnswers } from '../../shared/types'
import * as events from './claudeEvents'
import { CANVAS_SKILLS, PLUGIN_NAME, PLUGIN_VERSION } from './skills'

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/// Claude Code adapter — the transport/config seam. Installs scoped HTTP hooks
/// (via --settings, leaving user config untouched), launches `claude` with them,
/// and reads the CLI's task store off disk. The pure event mapping lives in
/// ./claudeEvents; this class delegates to it so the I/O seam stays separate
/// from the (testable) mapping.
export class ClaudeAdapter {
  readonly name = 'claude-code'
  private settingsFile: string | null = null
  /** The materialized curated-skills plugin dir, attached to every card via
   *  `--plugin-dir`. Set by stageSkills() at startup; null until then. */
  private pluginDir: string | null = null
  /** The materialized agent-browser MCP config, attached to every card via
   *  `--mcp-config`. Set by stageBrowserMcp() once the server binds; null until
   *  then (a card launched before it simply has no browser tools). */
  private mcpConfigFile: string | null = null

  /** Events acked instantly (status/feed material). PermissionRequest is
   *  configured separately as the held interactive channel. */
  private readonly telemetryEvents = [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'Notification', 'Elicitation',
    'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
    'Stop', 'StopFailure', 'SessionEnd',
  ]

  installConfig(dir: string, port: number, token: string): void {
    const url = `http://127.0.0.1:${port}/hook`
    const entry = (timeout: number, statusMessage?: string): Record<string, unknown> => ({
      type: 'http',
      url,
      timeout,
      headers: { 'X-Canvas-Card': '$CANVAS_CARD_ID', 'X-Canvas-Token': token },
      allowedEnvVars: ['CANVAS_CARD_ID'],
      ...(statusMessage ? { statusMessage } : {}),
    })
    const hooks: Record<string, unknown> = {}
    for (const e of this.telemetryEvents) hooks[e] = [{ hooks: [entry(5)] }]
    hooks['PermissionRequest'] = [{ hooks: [entry(600, 'Asking Agent Canvas…')] }]

    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'hooks.json')
    writeFileSync(file, JSON.stringify({ hooks }, null, 2))
    chmodSync(file, 0o600) // carries the sink token — owner-readable only
    this.settingsFile = file
    console.log(`[adapter] wrote HTTP hooks (port ${port}) → ${file}`)
  }

  /** Materialize the curated skill library (./skills) into a Claude Code plugin
   *  under SPINE_DIR — `<dir>/<PLUGIN_NAME>/` with a `.claude-plugin/plugin.json`
   *  manifest and one `skills/<name>/SKILL.md` per skill — attached to every
   *  agent card via `--plugin-dir` in launchCommand. Equips skills WITHOUT
   *  touching the user's `~/.claude/skills`, mirroring how installConfig keeps
   *  hooks out of user config. The dir is rebuilt from scratch each call so a
   *  removed/renamed skill never lingers; staged at startup, independent of the
   *  sink, so even a pre-bind launch is equipped. */
  stageSkills(dir: string): void {
    const pluginDir = join(dir, PLUGIN_NAME)
    rmSync(pluginDir, { recursive: true, force: true })
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify(
        {
          name: PLUGIN_NAME,
          version: PLUGIN_VERSION,
          description: 'Agent Canvas curated skills, equipped into every supervised agent card.',
        },
        null,
        2,
      ),
    )
    for (const s of CANVAS_SKILLS) {
      const skillDir = join(pluginDir, 'skills', s.name)
      mkdirSync(skillDir, { recursive: true })
      // name is constrained to [a-z0-9-] so it's YAML-safe bare; description is
      // free text (may contain ':'), so emit it as a double-quoted scalar —
      // JSON string escaping is valid YAML flow-scalar syntax.
      const md = `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}\n`
      writeFileSync(join(skillDir, 'SKILL.md'), md)
    }
    this.pluginDir = pluginDir
    console.log(`[adapter] staged ${CANVAS_SKILLS.length} skill(s) → ${pluginDir}`)
  }

  /** Materialize the agent-browser MCP config — `<dir>/browser-mcp.json`, an HTTP
   *  MCP server pointed at the loopback AgentBrowserMcp — attached to every card
   *  via `--mcp-config`. The card identifies itself with the same `$CANVAS_CARD_ID`
   *  (tmux session env) the hooks use, substituted into the header by the CLI's
   *  `${VAR:-default}` expansion; the spine token authenticates. Written once the
   *  server's port is known (mirrors installConfig), rebuilt each call. We do NOT
   *  pass --strict-mcp-config, so an agent keeps any MCP servers the user already
   *  configured globally — this only ADDS the browser tools. */
  stageBrowserMcp(dir: string, port: number, token: string): void {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'browser-mcp.json')
    const config = {
      mcpServers: {
        browser: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: {
            'X-Canvas-Card': '${CANVAS_CARD_ID:-unknown}',
            'X-Canvas-Token': token,
          },
        },
      },
    }
    writeFileSync(file, JSON.stringify(config, null, 2))
    chmodSync(file, 0o600) // carries the sink token — owner-readable only
    this.mcpConfigFile = file
    console.log(`[adapter] wrote browser MCP config (port ${port}) → ${file}`)
  }

  launchCommand(initialPrompt?: string): string {
    const flags: string[] = []
    // Sink-not-ready (no settings) shouldn't happen, but degrade to bare claude.
    if (this.settingsFile) flags.push(`--settings ${shellQuote(this.settingsFile)}`)
    // Every agent card is equipped with the curated skill plugin.
    if (this.pluginDir) flags.push(`--plugin-dir ${shellQuote(this.pluginDir)}`)
    // …and with the browser MCP server (see-and-control its own browser card).
    if (this.mcpConfigFile) flags.push(`--mcp-config ${shellQuote(this.mcpConfigFile)}`)
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

  isPermissionAsk(name: string): boolean {
    return events.isPermissionAsk(name)
  }

  isQuestionAsk(name: string, payload: Record<string, any>): boolean {
    return events.isQuestionAsk(name, payload)
  }

  parseQuestions(payload: Record<string, any>): Question[] {
    return events.parseQuestions(payload)
  }

  questionAnswerBody(input: Record<string, unknown> | undefined, answers: QuestionAnswers): string {
    return events.questionAnswerBody(input, answers)
  }

  /** Read the session's plan from the CLI's own task store:
   *  `~/.claude/tasks/<session-id>/<taskId>.json`, one file per task with
   *  `{id, subject, activeForm, status, …}` (empirically verified in the
   *  Swift adapter). This is the ground truth that outlives both the app and
   *  the hook stream — used to re-hydrate a reattached session's checklist. */
  async currentTodos(sessionId: string): Promise<AgentTodo[] | null> {
    if (!/^[\w.-]+$/.test(sessionId)) return null // ids are uuids; never a path
    let files: string[]
    try {
      files = await readdir(join(homedir(), '.claude/tasks', sessionId))
    } catch {
      return null // no store for this session (or none yet)
    }
    const todos: AgentTodo[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const obj = JSON.parse(
          await readFile(join(homedir(), '.claude/tasks', sessionId, f), 'utf8'),
        )
        if (typeof obj?.id !== 'string' || typeof obj?.subject !== 'string') continue
        const status = typeof obj.status === 'string' ? obj.status : 'pending'
        if (status === 'deleted') continue
        todos.push({
          id: obj.id,
          content: obj.subject,
          status,
          activeForm: typeof obj.activeForm === 'string' ? obj.activeForm : undefined,
        })
      } catch {
        // unreadable task file — skip it, keep the rest of the plan
      }
    }
    // An existing-but-empty dir reads as "no data", not "empty plan": the CLI
    // creates the dir before the first task file lands, so a read in that
    // window must not wipe todos already accumulated from deltas.
    if (!todos.length) return null
    // Task ids are a numeric sequence — creation order is the plan's order.
    return todos.sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0))
  }

  permissionAllowBody(): string {
    return events.permissionAllowBody()
  }

  permissionDenyBody(): string {
    return events.permissionDenyBody()
  }

  event(name: string, p: Record<string, any>): CardEvent | null {
    return events.mapEvent(name, p)
  }
}
