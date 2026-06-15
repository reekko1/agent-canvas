import { useEffect, useRef } from 'react'

/// Right-click menu on a card: close it. (Cards belong to the canvas they're
/// born on and don't move — project = dir.) Dismisses on click-away or Esc.
export function CardContextMenu({
  x,
  y,
  cardId,
  onClose,
  onDismiss,
}: {
  x: number
  y: number
  cardId: string
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

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[160px] overflow-hidden rounded-xl border border-border/40 bg-popover/95 p-1 text-sm shadow-xl backdrop-blur-xl"
      style={{ left: x, top: y }}
    >
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
