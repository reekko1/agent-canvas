import { useCallback, useEffect, useRef, useState } from 'react'

/// Shared lifecycle for held asks projected to the renderer — the bookkeeping
/// behind both usePendingAsks (permission gates, dormant now that agent cards
/// run headless and unattended — kept wired for a legacy hook-era ask, never
/// fires otherwise) and usePendingQuestions (AskUserQuestion choosers, the
/// live one — canvas MCP `ask_user`). The main process owns the actual held
/// tool call; this is the renderer's mirror plus the release wiring: append on
/// arrival, release a card's holds on forward progress / session end, and drop
/// a toast when its ask is decided elsewhere (the phone).
///
/// The two flows stay deliberately separate (a question is NOT a permission
/// gate, and they answer differently) — only their identical bookkeeping is
/// shared here. `T` carries the ask shape (PermissionAskInfo / QuestionAskInfo);
/// pass STABLE bridge fns (e.g. window.canvas.onAsk) so the effect runs once.
export function useHeldAsks<T extends { askId: string; cardId: string }>({
  subscribeArrival,
  subscribeDecided,
}: {
  subscribeArrival: (cb: (item: T) => void) => () => void
  subscribeDecided: (cb: (askId: string) => void) => () => void
}) {
  const [items, setItems] = useState<(T & { created: number })[]>([])
  // Mirror for the event handler — checking "does this card hold an ask?" must
  // not re-subscribe or read stale closure state.
  const itemsRef = useRef(items)
  itemsRef.current = items

  /** Release a card's holds with no decision. Called on forward progress and
   *  session end (or, for a shell card, pty death); releasing an
   *  already-answered ask is a harmless no-op. */
  const releaseCard = useCallback((cardId: string) => {
    if (!itemsRef.current.some((a) => a.cardId === cardId)) return
    window.canvas.releaseAsks(cardId)
    setItems((as) => as.filter((a) => a.cardId !== cardId))
  }, [])

  useEffect(() => {
    const offArrival = subscribeArrival((item) =>
      setItems((as) => [...as, { ...item, created: Date.now() }]),
    )
    const offEvent = window.canvas.onCardEvent((cardId, ev) => {
      // Any forward progress resolves the card's holds: answered in the
      // terminal, hook timed out, or the turn moved on.
      if (ev.status && ev.status !== 'blocked') releaseCard(cardId)
    })
    // Shell-only (agents never emit pty-exit) and agent-only (shells never
    // emit session-ended) — together they cover every card kind's teardown.
    const offExit = window.canvas.onPtyExit(releaseCard)
    const offEnded = window.canvas.onSessionEnded(releaseCard)
    // Decided from the remote panel — the spine already responded; only the
    // toast needs to go.
    const offDecided = subscribeDecided((askId) =>
      setItems((as) => as.filter((a) => a.askId !== askId)),
    )
    return () => {
      offArrival()
      offEvent()
      offExit()
      offEnded()
      offDecided()
    }
  }, [subscribeArrival, subscribeDecided, releaseCard])

  return { items, setItems, releaseCard }
}
