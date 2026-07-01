import { useEffect, useRef, type RefObject } from 'react'

/** Dismiss a floating surface (menu / popover / context menu) on outside
 *  mousedown or Escape. `ref` bounds the inside region; `active` gates the
 *  listeners for surfaces that stay mounted while closed (default on, for
 *  surfaces that mount only while open). `onDismiss` rides a live ref — house
 *  ref-for-stable-subscription style — so an inline arrow doesn't resubscribe
 *  the document listeners every render. */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  active = true,
): void {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    if (!active) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) dismissRef.current()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissRef.current()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [active, ref])
}
