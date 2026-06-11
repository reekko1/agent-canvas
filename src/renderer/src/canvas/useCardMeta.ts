import { useCallback, useEffect, useRef } from 'react'
import { applyCardEvent, type CardMeta } from '@/cards/meta'
import type { CanvasNode } from './nodes'

type SetNodes = (updater: (ns: CanvasNode[]) => CanvasNode[]) => void

/// The renderer's end of the spine: subscribes to card events, asks, and pty
/// exits, folds them into each card's meta, and keys plan re-hydration off
/// session sightings. Owns no state of its own — meta lives on the nodes.
export function useCardMeta(setNodes: SetNodes) {
  const patchMeta = useCallback(
    (cardId: string, patch: (meta: CardMeta) => CardMeta) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.type === 'card' && n.id === cardId
            ? { ...n, data: { ...n.data, meta: patch(n.data.meta) } }
            : n,
        ),
      )
    },
    [setNodes],
  )

  // First sighting of a session on a card (fresh spawn, restore, or events
  // resuming after reattach): record it and replace the plan with the CLI's
  // stored list. null = no task store (or none yet) → leave the accumulated
  // todos alone — never wipe real data with an absence.
  const knownSessions = useRef(new Map<string, string>())
  const hydrateTodos = useCallback(
    (cardId: string, sessionId: string) => {
      if (knownSessions.current.get(cardId) === sessionId) return
      knownSessions.current.set(cardId, sessionId)
      patchMeta(cardId, (m) => ({ ...m, sessionId }))
      void window.canvas.readTodos(sessionId).then((todos) => {
        if (todos) patchMeta(cardId, (m) => ({ ...m, todos }))
      })
    },
    [patchMeta],
  )

  useEffect(() => {
    const offEvent = window.canvas.onCardEvent((cardId, ev) => {
      patchMeta(cardId, (m) => applyCardEvent(m, ev))
      if (ev.sessionId) hydrateTodos(cardId, ev.sessionId)
    })
    const offAsk = window.canvas.onAsk((ask) => {
      patchMeta(ask.cardId, (m) => ({ ...m, ask }))
    })
    const offExit = window.canvas.onPtyExit((cardId) => {
      patchMeta(cardId, (m) => ({ ...m, status: 'idle', detail: 'terminal exited', ask: null }))
    })
    return () => {
      offEvent()
      offAsk()
      offExit()
    }
  }, [patchMeta, hydrateTodos])

  return { patchMeta, hydrateTodos }
}
