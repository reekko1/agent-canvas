import { useCallback, useEffect, useRef, useState } from 'react'
import type { AskDecision, PermissionAskInfo } from '@shared/types'

/** A held ask plus its arrival time — the remote panel shows ask age. */
export interface PendingAsk extends PermissionAskInfo {
  created: number
}

/// Held permission asks, projected for the toast stack and the remote panel.
/// The main process owns the actual held HTTP responses; this is the
/// renderer's view of them plus the decision wiring. (Port of the Swift
/// controller's pendingAsks.)
export function usePendingAsks() {
  const [asks, setAsks] = useState<PendingAsk[]>([])
  // Mirror for the event handler — checking "does this card hold an ask?"
  // must not re-subscribe or read stale closure state.
  const asksRef = useRef(asks)
  asksRef.current = asks

  /** Release a card's asks with no decision — the dialog falls through to its
   *  terminal. Called on terminal engagement, forward progress, and pty death;
   *  releasing an already-answered ask is a harmless no-op. */
  const releaseCard = useCallback((cardId: string) => {
    if (!asksRef.current.some((a) => a.cardId === cardId)) return
    window.canvas.releaseAsks(cardId)
    setAsks((as) => as.filter((a) => a.cardId !== cardId))
  }, [])

  useEffect(() => {
    const offAsk = window.canvas.onAsk((ask) =>
      setAsks((as) => [...as, { ...ask, created: Date.now() }]),
    )
    const offEvent = window.canvas.onCardEvent((cardId, ev) => {
      // Any forward progress resolves the card's held asks: answered in the
      // terminal, hook timed out, or the turn moved on.
      if (ev.status && ev.status !== 'blocked') releaseCard(cardId)
    })
    const offExit = window.canvas.onPtyExit(releaseCard)
    // Answered from the remote panel — the spine already responded; only the
    // toast needs to go.
    const offDecided = window.canvas.onAskDecided((askId) =>
      setAsks((as) => as.filter((a) => a.askId !== askId)),
    )
    return () => {
      offAsk()
      offEvent()
      offExit()
      offDecided()
    }
  }, [releaseCard])

  /** Answer one ask (allow/deny from the toast, release on fly-to-card). */
  const decide = useCallback((askId: string, decision: AskDecision) => {
    window.canvas.decide(askId, decision)
    setAsks((as) => as.filter((a) => a.askId !== askId))
  }, [])

  return { asks, decide, releaseCard }
}
