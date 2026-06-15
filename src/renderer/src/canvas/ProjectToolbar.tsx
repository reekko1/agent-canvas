import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, Pencil, Plus, X } from 'lucide-react'
import type { Project } from '@shared/types'

/// Top toolbar: a dropdown that names the active canvas and switches between
/// projects, plus a "+" to make a new one. Rename/delete live per-row in the
/// dropdown. Mirrors the left toolbar's pill style.
export function ProjectToolbar({
  projects,
  activeProjectId,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
}: {
  projects: Project[]
  activeProjectId: string | null
  onSwitch: (id: string) => void
  onCreate: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  // The canvas being renamed inline (Electron disables window.prompt()), plus
  // its working draft. null = nobody's editing.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const active = projects.find((p) => p.id === activeProjectId)

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
      >
        <span className="max-w-[220px] truncate">{active?.name ?? 'No canvas'}</span>
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
              className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm ${
                p.id === activeProjectId ? 'bg-accent' : 'hover:bg-accent/60'
              }`}
            >
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
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => {
                    onSwitch(p.id)
                    setOpen(false)
                  }}
                >
                  {p.name}
                  {p.cardIds.length > 0 && (
                    <span className="ml-1.5 text-xs text-muted-foreground">{p.cardIds.length}</span>
                  )}
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
    </div>
  )
}
