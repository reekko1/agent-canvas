# git (main)

Computes the git status/diff data for each card and keeps it fresh while live agents
mutate the same working trees. Ported from the app's earlier Swift `Git`/`GitDiff`/
`GitActions`/`DiffWatcher` types: a read side that observes, a write side for explicit
user actions, and a poller that re-delivers snapshots on change.

## Files
- `git.ts` — the single `git` runner plus all read/write/parse logic: snapshots, the
  cheap toolbar identity read, per-file diffs, user actions, and porcelain/numstat parsing.
- `watchers.ts` — `DiffWatchers`, a registry of per-diff pollers that recompute a signature
  each tick and deliver a full `GitSnapshot` only when the tree actually changed.

## Architecture / data flow
All git runs go through one `git(args, folder)` helper (`execFile`, 64 MB buffer). It always
prepends `--no-optional-locks` so opportunistic reads never grab `index.lock` from an agent
mid-commit. The runner normalizes exit codes: numeric on git's non-zero exit, `-1` when git
itself couldn't launch (e.g. `ENOENT`).

Read side produces three shapes (all from `../../shared/types`):
- `gitSnapshot` — full working tree vs HEAD. Runs `status --porcelain=v1 -z --untracked-files=all`
  plus `diff HEAD --numstat -z`, merges per-file added/removed counts, and returns `changes` with
  totals. Untracked files have no numstat, so their added count is read by counting file lines.
  Returns the shared `NOT_REPO`/`CLEAN` constants for the trivial cases.
- `gitIdentity` — one `status --porcelain=v2 --branch` for the toolbar: branch, ahead/behind,
  dirty count. Deliberately no numstat — it's polled for every canvas.
- `gitFileDiff` — unified diff for one file; untracked uses `diff --no-index -- /dev/null path`.

Write side (`gitAction`) handles explicit user kinds: stage/unstage/discard (and the `*All`
variants) plus commit. `discard` on untracked files `rm`s them directly; `discardAll` is
`reset --hard` then `clean -fd`. The renderer confirms destructive actions first.

`DiffWatchers` polls each registered folder every `intervalMs` (default 1500). Each `tick`
recomputes `signature` (status text + `` + numstat) and only calls the injected `deliver`
callback when it differs from `lastSignature` — an idle repo costs one `git status` per interval.
`poke(folder)` forces an immediate refresh (used right after a git action); `watch` delivers once
on registration; `disposeAll` is the before-quit teardown.

## Conventions & gotchas
- A `running` flag per entry means a slow `git` never stacks ticks, and ticks re-check the entry
  after every `await` because `unwatch` can race the poll.
- Status parsing is NUL-record aware: rename/copy records carry an extra NUL field for the old path,
  and numstat rename rows put added/removed before an `old\0new` pair — both keyed on the new path.
- `signature` is the change-detection primitive; it must stay derived from raw porcelain output, not
  the parsed `changes`, or unchanged trees would re-deliver.
- This directory only observes and mutates git — it never reaches IPC or the renderer directly; the
  `deliver` callback and `gitAction` results are wired up by the caller in the main process.
