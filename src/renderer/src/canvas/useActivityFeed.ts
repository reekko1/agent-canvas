import { useEffect, useState } from 'react'
import { useRef } from 'react'
import type { CardStatus } from '@shared/types'
import type { Notification } from '@/components/ui/notification-popover'

/// In-memory log of agent status changes — the source for the activity
/// popover. Newest first; capped; never persisted (status never is — see the
/// spine). (Port of the Swift ActivityFeed + the controller's feedWorthy.)

/** A feed row: the popover's Notification plus the fly-to target. */
export interface ActivityNotification extends Notification {
  cardId: string
  status: CardStatus
}

const CAP = 40

/** Statuses that demand the user (mirrors the Swift `isLoud`) — these arrive
 *  unread, so they drive the bell badge until acknowledged. */
const LOUD: ReadonlySet<CardStatus> = new Set(['blocked', 'error'])

/** Per-status fallback copy when the event carries no detail line. */
const FALLBACK: Record<CardStatus, string> = {
  idle: 'Went idle',
  running: 'Started working',
  waiting: 'Waiting on background work',
  done: 'Finished — waiting for you',
  stalled: 'Stalled — no recent activity',
  blocked: 'Needs your permission',
  error: 'Something went wrong',
}

/** Whether a status transition earns an activity row. Arrivals into `running`
 *  and `idle` are usually echoes of the user's own actions (they typed the
 *  prompt; done decayed to idle) — noise that crowds out the rows that matter.
 *  Two exceptions are kept because they're things that happened *unwatched*:
 *  a stalled card resuming on its own, and a session dying mid-work. */
function feedWorthy(previous: CardStatus, current: CardStatus): boolean {
  switch (current) {
    case 'running':
      return previous === 'stalled' // self-recovery
    case 'idle':
      return previous === 'running' // session exited mid-work
    default:
      return true
  }
}

/// Subscribes to the spine's card events alongside useCardMeta (broadcast —
/// both listeners get every event) and keeps its own last-status shadow so
/// transition detection never races the nodes' meta updates. The card always
/// reflects every transition; the feed only gets the ones worth reading later.
export function useActivityFeed(titleFor: (cardId: string) => string) {
  const [notifications, setNotifications] = useState<ActivityNotification[]>([])
  const lastStatus = useRef(new Map<string, CardStatus>())
  const seq = useRef(1)

  // titleFor reads live canvas state through a ref at the call site — keep the
  // subscription stable across renders rather than chasing its identity.
  const titleForRef = useRef(titleFor)
  titleForRef.current = titleFor

  useEffect(() => {
    return window.canvas.onCardEvent((cardId, ev) => {
      const previous = lastStatus.current.get(cardId) ?? 'idle'
      const current = ev.status ?? previous
      const statusChanged = current !== previous
      if (ev.status) lastStatus.current.set(cardId, ev.status)

      if (!((statusChanged && feedWorthy(previous, current)) || ev.noteworthy)) return

      const row: ActivityNotification = {
        id: `act-${seq.current++}`,
        cardId,
        status: current,
        title: titleForRef.current(cardId),
        description: ev.detail ?? FALLBACK[current],
        timestamp: new Date(),
        read: !LOUD.has(current),
      }
      setNotifications((ns) => [row, ...ns].slice(0, CAP))
    })
  }, [])

  return { notifications, setNotifications }
}
