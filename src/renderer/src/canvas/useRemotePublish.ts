import { useEffect, useRef } from 'react'
import type { RemoteState } from '@shared/types'
import type { CanvasNode } from './nodes'
import type { ActivityNotification } from './useActivityFeed'
import type { PendingAsk } from './usePendingAsks'

/// Mirror the attention state to the remote panel. Riding the same renderer
/// state as the in-app surfaces (cards' meta, the toast asks, the activity
/// feed) means the phone and the canvas can never disagree. Published through
/// a content-compare so node drags (position-only changes) don't churn IPC.
export function useRemotePublish({
  nodes,
  asks,
  notifications,
  titleFor,
  projectNameFor,
}: {
  nodes: CanvasNode[]
  asks: PendingAsk[]
  notifications: ActivityNotification[]
  titleFor: (cardId: string) => string
  /** Which canvas a card belongs to — tags each remote card; the panel itself
   *  stays global across every project. */
  projectNameFor: (cardId: string) => string | undefined
}) {
  const lastJSON = useRef('')

  useEffect(() => {
    const cards: RemoteState['cards'] = nodes
      .flatMap((n) => (n.type === 'card' && n.data.kind === 'agent' ? [n] : []))
      .map((n) => ({
        id: n.id,
        name: titleFor(n.id),
        status: n.data.meta.status,
        loud: n.data.meta.status === 'blocked' || n.data.meta.status === 'error',
        since: (n.data.meta.statusSince ?? 0) / 1000,
        task: n.data.meta.task,
        model: n.data.meta.model,
        permissionMode: n.data.meta.permissionMode,
        subagents: n.data.meta.subagents ?? 0,
        projectName: projectNameFor(n.id),
      }))
    const approvals: RemoteState['approvals'] = asks.map((a) => ({
      id: a.askId,
      name: titleFor(a.cardId),
      detail: a.detail,
      created: a.created / 1000,
    }))
    const feed: RemoteState['feed'] = notifications.map((n) => ({
      name: n.title,
      status: n.status,
      loud: n.status === 'blocked' || n.status === 'error',
      message: n.description,
      date: n.timestamp.getTime() / 1000,
    }))
    const state: RemoteState = {
      cards,
      approvals,
      feed,
      needsYou: cards.filter((c) => c.loud).length + approvals.length,
    }
    const json = JSON.stringify(state)
    if (json === lastJSON.current) return
    lastJSON.current = json
    window.canvas.publishRemoteState(state)
  }, [nodes, asks, notifications, titleFor, projectNameFor])
}
