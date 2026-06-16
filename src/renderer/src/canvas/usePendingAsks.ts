import { useCallback } from 'react'
import type { AskDecision, PermissionAskInfo } from '@shared/types'
import { useHeldAsks } from './useHeldAsks'

/** A held ask plus its arrival time — the remote panel shows ask age. */
export interface PendingAsk extends PermissionAskInfo {
  created: number
}

/// Held permission asks, projected for the toast stack and the remote panel.
/// The held-ask lifecycle (arrival/release/decided) lives in useHeldAsks; this
/// wraps it with the permission channels and the allow/deny/release decision.
/// (Port of the Swift controller's pendingAsks.)
export function usePendingAsks() {
  const { items, setItems, releaseCard } = useHeldAsks<PermissionAskInfo>({
    subscribeArrival: window.canvas.onAsk,
    subscribeDecided: window.canvas.onAskDecided,
  })
  const asks: PendingAsk[] = items

  /** Answer one ask (allow/deny from the toast, release on fly-to-card). */
  const decide = useCallback(
    (askId: string, decision: AskDecision) => {
      window.canvas.decide(askId, decision)
      setItems((as) => as.filter((a) => a.askId !== askId))
    },
    [setItems],
  )

  return { asks, decide, releaseCard }
}
