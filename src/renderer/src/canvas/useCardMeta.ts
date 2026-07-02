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

  // First sighting of a session on a card (fresh spawn, restore, or a new
  // turn's system/init event): stamp it into the card's meta — persisted by
  // useWorkspace so a relaunched card's first send resumes the same CLI
  // session. Deduped so the per-event sessionId doesn't re-patch on every event.
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
    // Shell-only (agents never emit this — see onSessionEnded below).
    const offExit = window.canvas.onPtyExit((cardId) => {
      patchMeta(cardId, (m) => ({ ...m, status: 'idle', detail: 'terminal exited' }))
    })
    // Agent-only: the card's headless session ended (turn loop exited, the
    // process died, or was killed) — the agent-card analogue of onPtyExit.
    const offEnded = window.canvas.onSessionEnded((cardId, reason) => {
      patchMeta(cardId, (m) => ({ ...m, status: 'idle', detail: reason ?? 'session ended' }))
    })
    return () => {
      offEvent()
      offExit()
      offEnded()
    }
  }, [patchMeta, trackSession])

  return { patchMeta, trackSession }
}
