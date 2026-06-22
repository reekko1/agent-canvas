// Skill library = real SKILL.md files in a plugin dir (the SDK `plugins` loader needs
// files). create/patch via the reviewer's plan; archive-never-delete; provenance in
// frontmatter. Paths are computed at call time (not module load) because the root is
// configurable (app startup / tests).
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  renameSync,
  appendFileSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { skillsPluginDir } from './paths'
import type { SkillView, SkillsSnapshot } from '../../shared/types'

/** The plugin's name (its manifest `name` + the namespace the SDK prefixes onto each
 *  skill, e.g. `mastermind:handling-stalls`). One source of truth for both. */
export const PLUGIN_NAME = 'mastermind'

const skillsSubdir = (): string => join(skillsPluginDir(), 'skills')
const archiveDir = (): string => join(skillsPluginDir(), '.archive')
const actionsLog = (): string => join(skillsPluginDir(), 'skills-actions.jsonl')
const usagePath = (): string => join(skillsPluginDir(), 'usage.json')

export interface SkillAction {
  op: 'create' | 'patch'
  name: string
  description?: string
  body?: string
}

export function ensurePlugin(): void {
  mkdirSync(join(skillsPluginDir(), '.claude-plugin'), { recursive: true })
  mkdirSync(skillsSubdir(), { recursive: true })
  writeFileSync(
    join(skillsPluginDir(), '.claude-plugin', 'plugin.json'),
    JSON.stringify(
      { name: PLUGIN_NAME, version: '0.0.0', description: 'Mastermind self-authored orchestration skills.' },
      null,
      2,
    ),
  )
}

/** The SDK `skills` filter scoped to ONLY our self-authored skills — their plugin-namespaced
 *  ids (`mastermind:<name>`). Passing this (instead of `'all'`) hides the host's ~/.claude
 *  skills AND the built-in CLI skills: the model sees only what the mastermind has learned.
 *  Recomputed per query() (the orchestrator recycles to pick up new ones; the reactor
 *  re-reads each reaction). Empty when nothing's been authored yet — then no skills load. */
export function enabledSkillIds(): string[] {
  return listSkills().map((s) => `${PLUGIN_NAME}:${s.name}`)
}

const NAME_RE = /^[a-z0-9-]{1,64}$/
export function validateSkill(a: SkillAction): string | null {
  if (!a.name || !NAME_RE.test(a.name)) return `bad name "${a.name}" (lowercase/numbers/hyphens, <=64)`
  if (/claude|anthropic/.test(a.name)) return `reserved word in name "${a.name}"`
  if (a.description && a.description.length > 1024) return `description >1024 (${a.description.length})`
  if (a.body && a.body.split('\n').length > 500) return 'body >500 lines'
  return null
}

const skillPath = (name: string): string => join(skillsSubdir(), name, 'SKILL.md')
export const skillExists = (name: string): boolean => existsSync(skillPath(name))
export const archivedExists = (name: string): boolean => existsSync(join(archiveDir(), name, 'SKILL.md'))

function parseFrontmatter(md: string): { fm: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { fm: {}, body: md }
  const fm: Record<string, string> = {}
  // Capture every `key: value` line, INDENTED ONES INCLUDED — so the nested metadata
  // (provenance / created_at / source) flattens into fm alongside name/description (no key
  // collisions). indexOf(':') splits on the first colon, so ISO timestamps survive.
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { fm, body: m[2] }
}

export function listSkills(): { name: string; description: string }[] {
  if (!existsSync(skillsSubdir())) return []
  return readdirSync(skillsSubdir(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(skillPath(d.name)))
    .map((d) => ({ name: d.name, description: parseFrontmatter(readFileSync(skillPath(d.name), 'utf8')).fm.description || '' }))
}
export const skillBody = (name: string): string => parseFrontmatter(readFileSync(skillPath(name), 'utf8')).body.trim()

function logAction(rec: object): void {
  appendFileSync(actionsLog(), JSON.stringify({ ts: Date.now(), ...rec }) + '\n')
}

function writeSkill(name: string, description: string, body: string, source: string): void {
  mkdirSync(join(skillsSubdir(), name), { recursive: true })
  const fm =
    `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  provenance: reviewer\n` +
    `  created_at: ${new Date().toISOString()}\n  source: ${source}\n---\n`
  writeFileSync(skillPath(name), fm + body.trim() + '\n')
}

// Single-arbiter apply for one skill action: validate -> apply -> audit-log.
export function applySkill(a: SkillAction, source: string): { ok: boolean; error?: string } {
  const err = validateSkill(a)
  if (err) return { ok: false, error: err }
  if (a.op === 'create') {
    if (skillExists(a.name)) return { ok: false, error: `create collision: "${a.name}" exists (should patch)` }
    if (!a.description || !a.body) return { ok: false, error: 'create needs description+body' }
    writeSkill(a.name, a.description, a.body, source)
    logAction({ op: 'create', name: a.name, source })
  } else {
    if (!skillExists(a.name)) return { ok: false, error: `patch target missing: "${a.name}"` }
    const { fm } = parseFrontmatter(readFileSync(skillPath(a.name), 'utf8'))
    writeSkill(a.name, a.description || fm.description, a.body ?? skillBody(a.name), source)
    logAction({ op: 'patch', name: a.name, source })
  }
  return { ok: true }
}

// usage + aging (curator)
const readUsage = (): Record<string, number> => (existsSync(usagePath()) ? JSON.parse(readFileSync(usagePath(), 'utf8')) : {})
export function recordSkillUse(name: string, ts = Date.now()): void {
  const u = readUsage()
  u[name] = ts
  writeFileSync(usagePath(), JSON.stringify(u))
}
export function lastUsed(name: string): number | undefined {
  return readUsage()[name]
}
// Effective last-activity for aging: last invocation, else the file's creation/mtime.
export function skillActivity(name: string): number {
  return lastUsed(name) ?? statSync(skillPath(name)).mtimeMs
}
export function archiveSkill(name: string): void {
  mkdirSync(archiveDir(), { recursive: true })
  renameSync(join(skillsSubdir(), name), join(archiveDir(), name))
  logAction({ op: 'archive', name })
}

// --- Read-only snapshot for the UI gallery (no model call) -------------------
const skillDirNames = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
        .map((d) => d.name)
    : []

function skillView(name: string, dir: string, archived: boolean): SkillView | null {
  try {
    const { fm, body } = parseFrontmatter(readFileSync(join(dir, name, 'SKILL.md'), 'utf8'))
    return {
      name,
      description: fm.description || '',
      body: body.trim(),
      createdAt: fm.created_at || '',
      source: fm.source || '',
      lastUsed: lastUsed(name) ?? null,
      archived,
    }
  } catch {
    return null // a skill dir vanished/garbled mid-read — skip it rather than fail the lot
  }
}

/** The whole library as the UI sees it: active + archived, each newest-first. Pure file
 *  reads — safe to call on every change and hand straight to the renderer. */
export function skillsSnapshot(): SkillsSnapshot {
  const build = (dir: string, archived: boolean): SkillView[] =>
    skillDirNames(dir)
      .map((n) => skillView(n, dir, archived))
      .filter((v): v is SkillView => v !== null)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) // newest first
  return { active: build(skillsSubdir(), false), archived: build(archiveDir(), true) }
}
