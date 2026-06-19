import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SheetShell } from '@/canvas/SheetShell'
import { diffLines, type DiffLine } from './diffText'
import type { GitActionRequest, GitChange, GitFileStatus, GitSnapshot } from '@shared/types'

export interface DiffData extends Record<string, unknown> {
  folder: string
  /** Tears the diff down entirely. Omitted for the built-in per-canvas drawer,
   *  which is never "closed" — only collapsed. */
  onClose?: (diffId: string) => void
  /** Collapse the sheet off-screen without tearing down the watcher, so
   *  reopening is instant and keeps the selected file. */
  onCollapse?: () => void
}

// Swift GitFileStatus parity: untracked dots read as added; letters match
// VS Code (untracked = U).
const FILE_COLORS: Record<GitFileStatus, string> = {
  added: 'var(--file-added)',
  modified: 'var(--file-modified)',
  deleted: 'var(--file-deleted)',
  renamed: 'var(--file-renamed)',
  untracked: 'var(--file-added)',
}
const LETTERS: Record<GitFileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}
const LINE_CLASS: Record<DiffLine['kind'], string> = {
  add: 'text-diff-add',
  del: 'text-diff-del',
  hunk: 'text-diff-hunk',
  meta: 'text-diff-meta',
  ctx: 'text-diff-ctx',
}

/// A diff object (PRD §4.2): the git diff + changed-file list for a folder as
/// its own floating canvas item — deliberately not bolted to a card. Observes
/// via the main-process watcher; mutates only on explicit user actions, the
/// one scoped exception to "observe, don't orchestrate".
export function DiffNode({ id, data }: { id: string; data: DiffData }) {
  const { folder } = data
  const folderName = folder.split('/').filter(Boolean).pop() ?? folder

  const [snap, setSnap] = useState<GitSnapshot | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [lines, setLines] = useState<DiffLine[]>([])
  const [message, setMessage] = useState('')

  // Live immediately (no lazy spawn): rendering git output is cheap.
  useEffect(() => {
    const off = window.canvas.onDiffSnapshot((diffId, s) => {
      if (diffId === id) setSnap(s)
    })
    void window.canvas.watchDiff(id, folder)
    return () => {
      off()
      window.canvas.unwatchDiff(id)
    }
  }, [id, folder])

  const staged = useMemo(() => snap?.changes.filter((c) => c.hasStaged) ?? [], [snap])
  const unstaged = useMemo(() => snap?.changes.filter((c) => c.hasUnstaged) ?? [], [snap])

  // Keep the current selection if its file still exists, else the first file
  // (staged group first — the Swift apply() rule).
  const selected = useMemo(() => {
    const all = [...staged, ...unstaged]
    return all.find((c) => c.path === selectedPath) ?? all[0] ?? null
  }, [staged, unstaged, selectedPath])

  // Render the selected file's diff lazily; stale responses are dropped.
  useEffect(() => {
    if (!selected) {
      setLines([])
      return
    }
    let stale = false
    void window.canvas.readFileDiff(folder, selected).then((raw) => {
      if (!stale) setLines(diffLines(raw))
    })
    return () => {
      stale = true
    }
  }, [folder, selected, snap?.signature])

  const act = (action: GitActionRequest) => {
    void window.canvas.gitAction(folder, action).then((r) => {
      if (!r.ok) alert(r.message)
      else if (action.kind === 'commit') setMessage('')
    })
  }

  const discard = (change: GitChange) => {
    const what =
      change.status === 'untracked'
        ? `delete the untracked file ${change.path}`
        : `discard changes to ${change.path}`
    if (confirm(`This will ${what}. This cannot be undone.`)) act({ kind: 'discard', change })
  }

  const discardAll = () => {
    if (
      confirm(
        `Reset ${folderName} to a clean HEAD? This reverts every tracked change AND deletes untracked files. This cannot be undone.`,
      )
    )
      act({ kind: 'discardAll' })
  }

  const commitEnabled = staged.length > 0 && message.trim().length > 0
  const hint = commitEnabled
    ? `+${snap?.totalAdded ?? 0} −${snap?.totalRemoved ?? 0} ready to commit`
    : staged.length === 0
      ? 'Stage a change to commit'
      : 'Enter a message to commit'

  const paneMessage = !snap
    ? 'Reading working tree…'
    : !snap.isRepo
      ? 'Not a git repository.'
      : snap.changes.length === 0
        ? 'No changes — clean working tree.'
        : null

  return (
    <SheetShell
      title={<span className="font-mono text-xs font-semibold text-foreground">{folderName}</span>}
      trailing={
        <span className="font-mono text-xs text-foreground/80">
          {snap && !snap.isRepo && <span className="text-muted-foreground">not a repo</span>}
          {snap?.isRepo && snap.changes.length === 0 && (
            <span className="text-file-added">✓ clean</span>
          )}
          {snap?.isRepo && snap.changes.length > 0 && (
            <span>
              <span className="text-diff-add">+{snap.totalAdded}</span>{' '}
              <span className="text-diff-del">−{snap.totalRemoved}</span>
            </span>
          )}
        </span>
      }
      onCollapse={data.onCollapse}
      onClose={data.onClose ? () => data.onClose?.(id) : undefined}
    >
      {/* Status colors belong to agent cards, not diffs — the body stays neutral. */}
      <div className="flex h-full font-mono text-xs">
        {/* Left column: commit box + grouped file list (VS Code shape). */}
        <div className="flex w-[34%] min-w-[200px] flex-col border-r">
          <div className="flex flex-col gap-1.5 border-b p-2">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              className="rounded-md border border-input bg-transparent px-2 py-1 font-sans text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            <Button
              size="sm"
              disabled={!commitEnabled}
              onClick={() => act({ kind: 'commit', message: message.trim() })}
            >
              {commitEnabled
                ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}`
                : 'Commit'}
            </Button>
            <span className="font-sans text-[10px] text-muted-foreground">{hint}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {staged.length > 0 && (
              <FileGroup
                title="Staged Changes"
                files={staged}
                selectedPath={selected?.path ?? null}
                onSelect={(c) => setSelectedPath(c.path)}
                rowActions={(c) => [
                  { label: '−', title: 'Unstage', run: () => act({ kind: 'unstage', change: c }) },
                ]}
                bulkActions={[
                  { label: '− all', title: 'Unstage all', run: () => act({ kind: 'unstageAll' }) },
                ]}
              />
            )}
            {unstaged.length > 0 && (
              <FileGroup
                title="Changes"
                files={unstaged}
                selectedPath={selected?.path ?? null}
                onSelect={(c) => setSelectedPath(c.path)}
                rowActions={(c) => [
                  { label: '＋', title: 'Stage', run: () => act({ kind: 'stage', change: c }) },
                  { label: '⟲', title: 'Discard…', run: () => discard(c) },
                ]}
                bulkActions={[
                  { label: '＋ all', title: 'Stage all', run: () => act({ kind: 'stageAll' }) },
                  { label: '⟲ all', title: 'Discard all…', run: discardAll },
                ]}
              />
            )}
          </div>
        </div>

        {/* Right pane: diff header strip + the colored unified diff. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selected && !paneMessage && (
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <span className="font-bold" style={{ color: FILE_COLORS[selected.status] }}>
                {LETTERS[selected.status]}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">{dirOf(selected.path)}</span>
                {nameOf(selected.path)}
              </span>
              {selected.added > 0 && <span className="text-diff-add">+{selected.added}</span>}
              {selected.removed > 0 && <span className="text-diff-del">−{selected.removed}</span>}
              <span className="rounded-full bg-secondary px-2 py-0.5 font-sans text-[10px] text-muted-foreground">
                {selected.status}
              </span>
            </div>
          )}
          {paneMessage ? (
            <div className="flex flex-1 items-center justify-center font-sans text-sm text-muted-foreground">
              {paneMessage}
            </div>
          ) : (
            <pre className="min-h-0 flex-1 overflow-auto p-3 text-[11px] leading-[1.6]">
              {lines.map((l, i) => (
                <div key={i} className="whitespace-pre">
                  <span className="select-none text-diff-meta">{l.gutter} │ </span>
                  <span className={LINE_CLASS[l.kind]}>{l.text}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </SheetShell>
  )
}

interface RowAction {
  label: string
  title: string
  run: () => void
}

function FileGroup({
  title,
  files,
  selectedPath,
  onSelect,
  rowActions,
  bulkActions,
}: {
  title: string
  files: GitChange[]
  selectedPath: string | null
  onSelect: (c: GitChange) => void
  rowActions: (c: GitChange) => RowAction[]
  bulkActions: RowAction[]
}) {
  return (
    <div className="group/section">
      <div className="flex items-center gap-2 px-2 py-1 font-sans text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>
          {title} ({files.length})
        </span>
        <span className="hidden gap-1 group-hover/section:flex">
          {bulkActions.map((a) => (
            <ActionButton key={a.title} action={a} />
          ))}
        </span>
      </div>
      {files.map((c) => (
        <div
          key={c.path}
          className={`group/row flex cursor-pointer items-center gap-2 px-2 py-1 ${
            c.path === selectedPath ? 'bg-accent' : 'hover:bg-accent/60'
          }`}
          onClick={() => onSelect(c)}
        >
          <span className="w-3 text-center font-bold" style={{ color: FILE_COLORS[c.status] }}>
            {LETTERS[c.status]}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {nameOf(c.path)}
            <span className="text-muted-foreground"> {dirOf(c.path)}</span>
          </span>
          <span className="hidden gap-1 group-hover/row:flex">
            {rowActions(c).map((a) => (
              <ActionButton key={a.title} action={a} />
            ))}
          </span>
          <span className="text-[10px]">
            {c.added > 0 && <span className="text-diff-add">+{c.added}</span>}{' '}
            {c.removed > 0 && <span className="text-diff-del">−{c.removed}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

function ActionButton({ action }: { action: RowAction }) {
  return (
    <button
      className="rounded border-none bg-transparent px-1 leading-none text-muted-foreground hover:bg-secondary hover:text-foreground"
      title={action.title}
      onClick={(e) => {
        e.stopPropagation() // don't change the selection
        action.run()
      }}
    >
      {action.label}
    </button>
  )
}

const nameOf = (p: string) => p.split('/').pop() ?? p
const dirOf = (p: string) => {
  const parts = p.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : ''
}
