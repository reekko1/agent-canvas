import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, Pencil, Plus, X } from 'lucide-react'
import { DEFAULT_PROJECT_ID, type Project } from '@shared/types'

/// Top toolbar: a dropdown that names the active canvas and switches between
/// projects, plus a "+" to make a new one. Rename/delete live per-row in the
/// dropdown (Default can't be deleted). Mirrors the left toolbar's pill style.
export function ProjectToolbar({
  projects,
  activeProjectId,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
}: {
  projects: Project[]
  activeProjectId: string
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = projects.find((p) => p.id === activeProjectId) ?? projects[0]

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const create = (): void => {
    const name = prompt('New canvas name')
    if (name && name.trim()) onCreate(name.trim())
  }

  return (
    <div
      ref={ref}
      className="fixed left-1/2 top-2.5 z-40 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-border/40 bg-background/55 p-1 shadow-lg shadow-black/10 backdrop-blur-xl"
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      <button
        className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-medium hover:bg-accent"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="max-w-[220px] truncate">{active?.name ?? 'Default'}</span>
        <ChevronDown className="size-3.5 opacity-60" />
      </button>
      <button className="rounded-xl p-1.5 hover:bg-accent" title="New canvas" onClick={create}>
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
              <button
                className="rounded p-1 opacity-0 hover:bg-secondary group-hover:opacity-100"
                title="Rename"
                onClick={() => {
                  const name = prompt('Rename canvas', p.name)
                  if (name && name.trim()) onRename(p.id, name.trim())
                }}
              >
                <Pencil className="size-3" />
              </button>
              {p.id !== DEFAULT_PROJECT_ID && (
                <button
                  className="rounded p-1 opacity-0 hover:bg-secondary group-hover:opacity-100"
                  title="Delete canvas (its cards move to Default)"
                  onClick={() => {
                    if (confirm(`Delete "${p.name}"? Its cards move to Default — no sessions are killed.`))
                      onDelete(p.id)
                  }}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          ))}
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
