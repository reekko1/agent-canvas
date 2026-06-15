import { useEffect, useRef } from 'react'
import type { Project } from '@shared/types'

/// Right-click menu on a card: move it to another canvas (membership only — the
/// tmux session never moves), or close it. Dismisses on click-away or Esc.
export function CardContextMenu({
  x,
  y,
  cardId,
  currentProjectId,
  projects,
  onMove,
  onClose,
  onDismiss,
}: {
  x: number
  y: number
  cardId: string
  currentProjectId: string | undefined
  projects: Project[]
  onMove: (cardId: string, projectId: string) => void
  onClose: (cardId: string) => void
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

  const targets = projects.filter((p) => p.id !== currentProjectId)

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[200px] overflow-hidden rounded-xl border border-border/40 bg-popover/95 p-1 text-sm shadow-xl backdrop-blur-xl"
      style={{ left: x, top: y }}
    >
      <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Move to canvas
      </div>
      {targets.length === 0 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">No other canvas yet</div>
      ) : (
        targets.map((p) => (
          <button
            key={p.id}
            className="block w-full truncate rounded-lg px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => {
              onMove(cardId, p.id)
              onDismiss()
            }}
          >
            {p.name}
          </button>
        ))
      )}
      <div className="my-1 h-px bg-border/60" />
      <button
        className="block w-full rounded-lg px-2 py-1.5 text-left text-status-error hover:bg-accent"
        onClick={() => {
          onClose(cardId)
          onDismiss()
        }}
      >
        Close card
      </button>
    </div>
  )
}
