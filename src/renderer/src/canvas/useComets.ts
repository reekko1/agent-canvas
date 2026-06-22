import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { COMET_COLOR, type CometSpec } from '@/orchestrator/Comet'
import { COMET_TRAVEL_MS } from '@shared/types'
import type { OrchestratorTarget } from '@shared/types'
import type { Rect } from './layout'
import type { CanvasNode } from './nodes'
import type { PendingAsk } from './usePendingAsks'

/** Distance from the window's bottom edge up to the chat-bar pill's center — the
 *  origin an action comet launches from. Must track the bar's `bottom-4` overlay
 *  inset (16px) plus the pill's half-height; keep in sync if the pill resizes. */
const CHAT_BAR_INSET = 44

/// Live comets fired when the orchestrator acts on an agent (chat bar → card).
/// Main sends an `OrchestratorTarget` over `onOrchestratorTarget`; this resolves
/// it to a visible card and launches a comet from the chat bar to it. A ref holds
/// the latest closure so the IPC listener subscribes once, reading live layout
/// through `rectForRef` rather than re-subscribing every render.
export function useComets(params: {
  winW: number
  winH: number
  cardNodes: CanvasNode[]
  asks: PendingAsk[]
  reveal: (cardId: string) => void
  rectForRef: MutableRefObject<(cardId: string) => Rect>
}) {
  const { winW, winH, cardNodes, asks, reveal, rectForRef } = params
  const [comets, setComets] = useState<CometSpec[]>([])
  const cometSeq = useRef(1)
  const fireTargetRef = useRef<(t: OrchestratorTarget) => void>(() => {})

  // Fire a comet from the chat bar to the agent the orchestrator just acted on.
  // `approve` arrives with an askId (approvals carry no card id), so resolve it to
  // the asking card. A freshly spawned card may not be laid out for a frame or two,
  // so retry briefly; a target that never becomes visible (parked on another
  // canvas) is skipped rather than shooting a beam off-screen.
  fireTargetRef.current = (t: OrchestratorTarget): void => {
    const cardId = t.cardId ?? (t.askId ? asks.find((a) => a.askId === t.askId)?.cardId : undefined)
    if (!cardId) return
    const color = COMET_COLOR[t.kind]
    const from = { x: winW / 2, y: winH - CHAT_BAR_INSET } // the chat bar, bottom-center
    const launch = (attempts: number): void => {
      const r = rectForRef.current(cardId)
      if (r.x <= -10000) {
        if (attempts > 0) requestAnimationFrame(() => launch(attempts - 1))
        return
      }
      const to = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
      // Carry the card's frame so a grid ripple can energize it on impact, clipped
      // to its rounded corners (agents are rounded-2xl, shells/browsers rounded-lg).
      const radius = cardNodes.find((n) => n.id === cardId)?.data.kind === 'agent' ? 16 : 8
      const rect = { x: r.x, y: r.y, w: r.w, h: r.h }
      setComets((ts) => [...ts, { id: cometSeq.current++, from, to, color, rect, radius }])
      // A spawned card materializes when its delivering comet lands.
      if (t.kind === 'spawn') setTimeout(() => reveal(cardId), COMET_TRAVEL_MS)
    }
    launch(6)
  }

  useEffect(() => window.canvas.onOrchestratorTarget((t) => fireTargetRef.current(t)), [])

  const clearComet = useCallback(
    (id: number) => setComets((ts) => ts.filter((t) => t.id !== id)),
    [],
  )

  // fireTargetRef stays internal — it's the live closure for the once-subscribed
  // onOrchestratorTarget listener, not something a caller fires.
  return { comets, clearComet }
}
