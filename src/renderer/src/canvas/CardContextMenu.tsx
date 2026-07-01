import { useRef } from 'react'
import { useDismiss } from '@/hooks/use-dismiss'

/// Right-click menu on a card: close it. (Cards belong to the canvas they're
/// born on and don't move — project = dir.) Dismisses on click-away or Esc.
export function CardContextMenu({
  x,
  y,
  cardId,
  onClose,
  onRename,
  onDismiss,
}: {
  x: number
  y: number
  cardId: string
  onClose: (cardId: string) => void
  onRename: (cardId: string) => void
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onDismiss)

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[160px] overflow-hidden rounded-xl border border-border/40 bg-popover/95 p-1 text-sm shadow-xl backdrop-blur-xl"
      style={{ left: x, top: y }}
    >
      <button
        className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => {
          onRename(cardId)
          onDismiss()
        }}
      >
        Rename
      </button>
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
