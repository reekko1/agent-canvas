// On-disk home for the mastermind's learning state. Deliberately decoupled from
// spine.ts (that module pulls in node-pty + the remote server) so the deterministic
// suite can run under tsx with no native deps. The default mirrors SPINE_DIR's base
// (~/.agentcanvas-web/mastermind); the app repoints it at startup and tests redirect
// it to a tmp dir via setMastermindRoot.
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let ROOT = join(homedir(), '.agentcanvas-web', 'mastermind')

/** Repoint the mastermind's on-disk root (app startup → SPINE_DIR/mastermind; a
 *  test → its tmp dir). Call before any read/write. */
export function setMastermindRoot(dir: string): void {
  ROOT = dir
}
export const mastermindRoot = (): string => ROOT

// GLOBAL state — the operator model + the self-authored skill library (same operator
// and product-agnostic procedures across every canvas).
export const operatorMemoryPath = (): string => join(ROOT, 'operator.jsonl')
export const skillsPluginDir = (): string => join(ROOT, 'skills')
/** Reaction sessions persist under this cwd so the reviewers' getSessionMessages can
 *  read their transcripts. */
export const reactorCwd = (): string => join(ROOT, 'reactor-cwd')

// PER-PROJECT state — this product's durable facts, keyed by canvas/project id.
export const productMemoryPath = (projectId: string): string =>
  join(ROOT, 'products', projectId, 'memory.jsonl')

/** Test helper: wipe + recreate the root and its fixed subdirs. */
export function resetMastermind(): void {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  for (const d of [ROOT, skillsPluginDir(), reactorCwd()]) mkdirSync(d, { recursive: true })
}
