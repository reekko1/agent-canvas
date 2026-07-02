import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  GitActionRequest,
  GitActionResult,
  GitChange,
  GitFileStatus,
  GitSnapshot,
  RepoIdentity,
} from '../../shared/types'

/// Shared `git` runner (port of the Swift Git enum). One place that knows how
/// to invoke git. `--no-optional-locks`: the watcher polls `git status` in
/// worktrees where live agents run their own git — an opportunistic index
/// refresh must never take index.lock out from under an agent's commit.
/// Mandatory locks (add/commit/restore) are unaffected.
function git(
  args: string[],
  folder: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      { cwd: folder, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // execFile sets error.code to the exit code (number) on non-zero exit,
        // or a string errno (e.g. 'ENOENT') when git itself couldn't run.
        const code = error ? (error as { code?: number | string }).code : 0
        resolve({ code: typeof code === 'number' ? code : error ? -1 : 0, out: stdout, err: stderr })
      },
    )
  })
}

/** Repo files under `folder`, relative paths — tracked plus untracked-not-ignored
 *  (`--exclude-standard`), deduped and sorted. Feeds the composer's `@` file
 *  picker; the renderer filters this list client-side as the user types. Empty
 *  if the folder isn't a git repo. Capped defensively for a huge monorepo. */
export async function listRepoFiles(folder: string, cap = 5000): Promise<string[]> {
  const r = await git(['ls-files', '--cached', '--others', '--exclude-standard'], folder)
  if (r.code !== 0) return []
  const seen = new Set<string>()
  for (const line of r.out.split('\n')) {
    const p = line.trim()
    if (p) seen.add(p)
    if (seen.size >= cap) break
  }
  return [...seen].sort()
}

const NOT_REPO: GitSnapshot = { isRepo: false, changes: [], totalAdded: 0, totalRemoved: 0, signature: '' }
const CLEAN: GitSnapshot = { isRepo: true, changes: [], totalAdded: 0, totalRemoved: 0, signature: 'clean' }

// MARK: Read side (port of the Swift GitDiff — observe, don't orchestrate)

/** Full working-tree snapshot vs HEAD (staged + unstaged + untracked). */
export async function gitSnapshot(folder: string): Promise<GitSnapshot> {
  const head = await git(['rev-parse', '--is-inside-work-tree'], folder)
  if (head.code !== 0 || head.out.trim() !== 'true') return NOT_REPO

  const status = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], folder)).out
  const numstat = (await git(['diff', 'HEAD', '--numstat', '-z'], folder)).out
  const signature = status + '\u0001' + numstat

  const entries = parseStatus(status)
  if (!entries.length) return CLEAN
  const counts = parseNumstat(numstat)

  const changes: GitChange[] = []
  let totalAdded = 0
  let totalRemoved = 0
  for (const e of entries) {
    let added = 0
    let removed = 0
    const c = counts.get(e.path)
    if (c) [added, removed] = c
    else if (e.status === 'untracked') added = await lineCount(join(folder, e.path))
    totalAdded += added
    totalRemoved += removed
    changes.push({ ...e, added, removed })
  }
  return { isRepo: true, changes, totalAdded, totalRemoved, signature }
}

/** Cheap branch + dirty-count read for the toolbar — one `git status`. Polled
 *  for every canvas, so it stays a single porcelain call (no numstat). */
export async function gitIdentity(folder: string): Promise<RepoIdentity> {
  const r = await git(['status', '--porcelain=v2', '--branch'], folder)
  if (r.code !== 0) return { isRepo: false, dirty: 0 }
  let branch: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  let dirty = 0
  for (const line of r.out.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (!line.startsWith('#')) {
      dirty++ // a changed/untracked entry
    }
  }
  return { isRepo: true, branch, dirty, ahead, behind }
}

/** The unified diff for a single file. "" when nothing textual (e.g. binary). */
export async function gitFileDiff(folder: string, change: GitChange): Promise<string> {
  if (change.status === 'untracked') {
    // Untracked files have no HEAD blob; compare against /dev/null. Exit
    // code 1 is normal here.
    return (await git(['diff', '--no-index', '--', '/dev/null', change.path], folder)).out
  }
  return (await git(['diff', 'HEAD', '--', change.path], folder)).out
}

// MARK: Write side (port of the Swift GitActions — explicit user actions only)

export async function gitAction(folder: string, action: GitActionRequest): Promise<GitActionResult> {
  switch (action.kind) {
    case 'stage':
      return result(await git(['add', '--', action.change.path], folder))
    case 'unstage':
      return result(await git(['restore', '--staged', '--', action.change.path], folder))
    case 'discard':
      // Revert a file to its HEAD state. Tracked → restore index+worktree;
      // untracked → delete the file (it has no HEAD version). Irreversible —
      // the renderer confirms first.
      if (action.change.status === 'untracked') {
        try {
          await rm(join(folder, action.change.path))
          return { ok: true, message: '' }
        } catch (err) {
          return { ok: false, message: String(err) }
        }
      }
      return result(
        await git(['restore', '--staged', '--worktree', '--source=HEAD', '--', action.change.path], folder),
      )
    case 'stageAll':
      return result(await git(['add', '-A'], folder))
    case 'unstageAll':
      return result(await git(['restore', '--staged', '--', '.'], folder))
    case 'discardAll': {
      // Reset the whole working tree to a clean HEAD: revert tracked changes
      // AND remove untracked files/dirs. Nuclear — confirmed strongly first.
      const reset = await git(['reset', '--hard', 'HEAD'], folder)
      if (reset.code !== 0) return result(reset)
      return result(await git(['clean', '-fd'], folder))
    }
    case 'commit':
      return result(await git(['commit', '-m', action.message], folder))
  }
}

function result(r: { code: number; out: string; err: string }): GitActionResult {
  if (r.code === 0) return { ok: true, message: '' }
  const msg = r.err.trim() || r.out.trim()
  return { ok: false, message: msg || `git exited with code ${r.code}` }
}

// MARK: Parsing

interface StatusEntry {
  path: string
  oldPath?: string
  status: GitFileStatus
  hasStaged: boolean
  hasUnstaged: boolean
  stagedStatus?: GitFileStatus
  unstagedStatus?: GitFileStatus
}

/** Map a porcelain status char (one column of `XY`) to a status; undefined
 *  for a blank column (no change on that side). */
function statusFor(code: string): GitFileStatus | undefined {
  switch (code) {
    case 'A':
      return 'added'
    case 'M':
    case 'T':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
    case 'C':
      return 'renamed'
    case '?':
      return 'untracked'
    default:
      return undefined
  }
}

function classify(code: string): GitFileStatus {
  if (code.includes('?')) return 'untracked'
  if (code.includes('R') || code.includes('C')) return 'renamed'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  return 'modified'
}

/** Parse `git status --porcelain=v1 -z`: NUL-separated `XY PATH` records; a
 *  rename/copy record is followed by an extra NUL field with the old path. */
function parseStatus(data: string): StatusEntry[] {
  const fields = data.split('\0')
  const entries: StatusEntry[] = []
  let i = 0
  while (i < fields.length) {
    const field = fields[i]
    i += 1
    if (field.length < 4) continue // "XY P"
    const x = field[0]
    const y = field[1]
    const path = field.slice(3) // skip "XY "
    // X = index/staged column, Y = worktree column ('?' = untracked → unstaged).
    const hasStaged = x !== ' ' && x !== '?'
    const hasUnstaged = y !== ' '
    let oldPath: string | undefined
    if ((x === 'R' || x === 'C') && i < fields.length) {
      oldPath = fields[i] // rename/copy: next field is the old path
      i += 1
    }
    entries.push({
      path,
      oldPath,
      status: classify(x + y),
      hasStaged,
      hasUnstaged,
      stagedStatus: hasStaged ? statusFor(x) : undefined,
      unstagedStatus: hasUnstaged ? statusFor(y) : undefined,
    })
  }
  return entries
}

/** Parse `git diff HEAD --numstat -z` into path → (added, removed). Rename
 *  rows have an empty path field followed by old\0new; key on the new path. */
function parseNumstat(data: string): Map<string, [number, number]> {
  const fields = data.split('\0')
  const counts = new Map<string, [number, number]>()
  let i = 0
  while (i < fields.length) {
    const row = fields[i]
    i += 1
    const cols = row.split('\t')
    if (cols.length < 3) continue
    const added = parseInt(cols[0], 10) || 0
    const removed = parseInt(cols[1], 10) || 0
    const pathCol = cols[2]
    if (pathCol === '') {
      // rename: old\0new follow as separate fields
      if (i + 1 < fields.length) {
        counts.set(fields[i + 1], [added, removed])
        i += 2
      }
    } else {
      counts.set(pathCol, [added, removed])
    }
  }
  return counts
}

async function lineCount(path: string): Promise<number> {
  try {
    const s = await readFile(path, 'utf8')
    if (!s) return 0
    return s.endsWith('\n') ? s.split('\n').length - 1 : s.split('\n').length
  } catch {
    return 0
  }
}
