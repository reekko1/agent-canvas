import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Code, Copy, FolderOpen, Pencil, Plus, X } from 'lucide-react'
import type { Project, RepoIdentity } from '@shared/types'
import { attentionElsewhere, type AttentionLevel } from './useProjectAttention'

/// A canvas's attention glyph: amber pulse when a card is stalled on you,
/// faint hollow ring when one's done and waiting. Nothing when quiet — the
/// fixed slot keeps names aligned across rows.
function AttentionDot({ level }: { level: AttentionLevel }) {
  return (
    <span className="flex size-2 shrink-0 items-center justify-center">
      {level === 'blocking' && (
        <span className="size-2 animate-pulse rounded-full bg-status-blocked" />
      )}
      {level === 'done' && <span className="size-2 rounded-full border border-status-done/70" />}
    </span>
  )
}

/// A canvas's repo identity: branch name + an amber dirty-count badge. Renders
/// nothing for a non-repo dir, so plain folders stay clean.
function GitInfo({ id }: { id: RepoIdentity | undefined }) {
  if (!id?.isRepo) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      {id.branch && <span className="max-w-[110px] truncate">{id.branch}</span>}
      {id.dirty > 0 && (
        <span className="flex items-center gap-0.5 text-status-blocked">
          <span className="size-1.5 rounded-full bg-status-blocked" />
          {id.dirty}
        </span>
      )}
    </span>
  )
}

/// Right-click menu on a canvas: act on its folder. (A canvas IS a folder.)
function FolderMenu({
  x,
  y,
  dir,
  onDismiss,
}: {
  x: number
  y: number
  dir: string
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onDismiss])

  const Item = ({
    icon: Icon,
    label,
    onClick,
  }: {
    icon: typeof FolderOpen
    label: string
    onClick: () => void
  }) => (
    <button
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
      onClick={() => {
        onClick()
        onDismiss()
      }}
    >
      <Icon className="size-3.5 opacity-70" /> {label}
    </button>
  )

  // Portaled to <body> so `position: fixed` is viewport-relative — the toolbar's
  // -translate-x-1/2 would otherwise become the containing block for the menu.
  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 min-w-[200px] overflow-hidden rounded-xl border border-border/40 bg-popover/95 p-1 shadow-xl backdrop-blur-xl"
      style={{ left: x, top: y }}
    >
      <div className="truncate px-2 py-1 font-mono text-[10px] text-muted-foreground">{dir}</div>
      <Item icon={FolderOpen} label="Reveal in Finder" onClick={() => void window.canvas.revealFolder(dir)} />
      <Item icon={Code} label="Open in editor" onClick={() => void window.canvas.openInEditor(dir)} />
      <Item icon={Copy} label="Copy path" onClick={() => void navigator.clipboard.writeText(dir)} />
    </div>,
    document.body,
  )
}

/// Top toolbar: a dropdown that names the active canvas and switches between
/// projects, plus a "+" to make a new one. Rename/delete live per-row in the
/// dropdown. Each row carries an attention dot; the collapsed pill lights up
/// when a canvas you're NOT looking at needs you. Mirrors the left pill style.
export function ProjectToolbar({
  projects,
  activeProjectId,
  attention,
  git,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
}: {
  projects: Project[]
  activeProjectId: string | null
  attention: Record<string, AttentionLevel>
  git: Record<string, RepoIdentity>
  onSwitch: (id: string) => void
  onCreate: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const elsewhere = attentionElsewhere(attention, activeProjectId)
  const [open, setOpen] = useState(false)
  // The canvas being renamed inline (Electron disables window.prompt()), plus
  // its working draft. null = nobody's editing.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // The folder menu (right-click a canvas), anchored at the cursor.
  const [menu, setMenu] = useState<{ dir: string; x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const active = projects.find((p) => p.id === activeProjectId)

  const openMenu = (e: ReactMouseEvent, dir: string): void => {
    e.preventDefault()
    setMenu({ dir, x: e.clientX, y: e.clientY })
  }

  const startRename = (p: Project): void => {
    setEditingId(p.id)
    setDraft(p.name)
  }
  const commitRename = (): void => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Pick the folder first; the canvas takes its name from that folder. (Electron
  // disables window.prompt(), so we can't ask for a name up front anyway.)
  const create = (): void => onCreate()

  return (
    <div
      ref={ref}
      className="fixed left-1/2 top-2.5 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/40 bg-background/55 p-1 shadow-lg shadow-black/10 backdrop-blur-xl"
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      <button
        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium hover:bg-accent"
        onClick={() => setOpen((o) => !o)}
        onContextMenu={active ? (e) => openMenu(e, active.dir) : undefined}
        title={elsewhere !== 'none' ? 'Another canvas needs you' : undefined}
      >
        {elsewhere !== 'none' && <AttentionDot level={elsewhere} />}
        <span className="max-w-[220px] truncate">{active?.name ?? 'No canvas'}</span>
        {active && <GitInfo id={git[active.id]} />}
        <ChevronDown className="size-3.5 opacity-60" />
      </button>
      <button className="rounded-full p-1.5 hover:bg-accent" title="New canvas" onClick={create}>
        <Plus className="size-4" />
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] min-w-[260px] overflow-hidden rounded-xl border border-border/40 bg-popover/95 p-1 shadow-xl backdrop-blur-xl">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm ${
                p.id === activeProjectId ? 'bg-accent' : 'hover:bg-accent/60'
              }`}
              onContextMenu={(e) => openMenu(e, p.dir)}
            >
              <AttentionDot level={attention[p.id] ?? 'none'} />
              {editingId === p.id ? (
                <input
                  autoFocus
                  className="min-w-0 flex-1 rounded bg-background px-1 py-0.5 text-sm outline-none ring-1 ring-border"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    else if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <button
                  className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
                  onClick={() => {
                    onSwitch(p.id)
                    setOpen(false)
                  }}
                >
                  <span className="truncate">{p.name}</span>
                  <GitInfo id={git[p.id]} />
                </button>
              )}
              <button
                className="rounded p-1 opacity-0 hover:bg-secondary group-hover:opacity-100"
                title="Rename"
                onClick={() => startRename(p)}
              >
                <Pencil className="size-3" />
              </button>
              <button
                className="rounded p-1 opacity-0 hover:bg-secondary group-hover:opacity-100"
                title="Delete canvas (closes its cards and their sessions)"
                onClick={() => {
                  const n = p.cardIds.length
                  const tail = n ? ` Its ${n} ${n === 1 ? 'card' : 'cards'} and their sessions are closed.` : ''
                  if (confirm(`Delete "${p.name}"?${tail}`)) onDelete(p.id)
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          {projects.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No canvases yet</div>
          )}
          <button
            className="mt-0.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/60"
            onClick={() => {
              setOpen(false)
              create()
            }}
          >
            <Plus className="size-3.5" /> New canvas
          </button>
        </div>
      )}

      {menu && <FolderMenu x={menu.x} y={menu.y} dir={menu.dir} onDismiss={() => setMenu(null)} />}
    </div>
  )
}
