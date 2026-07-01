import { useCallback, useEffect, useRef } from 'react'
import { applyCardEvent, type CardMeta } from '@/cards/meta'
import type { CanvasNode } from './nodes'

type SetNodes = (updater: (ns: CanvasNode[]) => CanvasNode[]) => void

/// The renderer's end of the spine: subscribes to card events, asks, and pty
/// exits, folds them into each card's meta, and stamps the session id on first
/// sighting. Owns no state of its own — meta lives on the nodes.
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
  // resuming after reattach): stamp it into the card's meta — persisted by
  // useWorkspace so a reattached card knows its tmux session. Deduped so the
  // per-event sessionId doesn't re-patch on every card event.
  const knownSessions = useRef(new Map<string, string>())
  const trackSession = useCallback(
    (cardId: string, sessionId: string) => {
      if (knownSessions.current.get(cardId) === sessionId) return
      knownSessions.current.set(cardId, sessionId)
      patchMeta(cardId, (m) => ({ ...m, sessionId }))
    },
    [patchMeta],
  )

  useEffect(() => {
    const offEvent = window.canvas.onCardEvent((cardId, ev) => {
      patchMeta(cardId, (m) => applyCardEvent(m, ev))
      if (ev.sessionId) trackSession(cardId, ev.sessionId)
    })
    const offExit = window.canvas.onPtyExit((cardId) => {
      patchMeta(cardId, (m) => ({ ...m, status: 'idle', detail: 'terminal exited' }))
    })
    return () => {
      offEvent()
      offExit()
    }
  }, [patchMeta, trackSession])

  return { patchMeta, trackSession }
}
