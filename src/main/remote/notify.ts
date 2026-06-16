import type { RemoteState } from '../../shared/types'

/** One actionable item that newly needs the user — an approval or a question. */
export interface FreshAsk {
  id: string
  name: string
  kind: 'approval' | 'question'
}

const trunc = (s: string, n = 140): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/// Pure: compose the push title/body for the items that newly need you. Title =
/// which canvas + what it wants; body = the actual ask (the tool call to
/// approve, or the question text). The card title equals the canvas name under
/// project=dir, so we lean on the canvas name and never repeat it. Null when
/// nothing is fresh. Lifted out of RemoteServer so transport and message
/// composition stay separate.
export function composeAskNotification(
  state: RemoteState,
  fresh: FreshAsk[],
): { title: string; body: string } | null {
  if (!fresh.length) return null
  const names = new Map(state.canvases.map((c) => [c.id, c.name]))
  const canvasOf = (it: FreshAsk): string => {
    const pid =
      it.kind === 'approval'
        ? state.approvals.find((a) => a.id === it.id)?.projectId
        : state.questions.find((q) => q.id === it.id)?.projectId
    return names.get(pid ?? '') ?? it.name
  }

  if (fresh.length > 1) {
    const canvases = [...new Set(fresh.map(canvasOf))]
    return { title: `${fresh.length} agents need you`, body: canvases.join(', ') }
  }
  if (fresh[0].kind === 'approval') {
    const a = state.approvals.find((x) => x.id === fresh[0].id)
    return { title: `${canvasOf(fresh[0])} needs approval`, body: trunc(a?.detail || 'A tool call is waiting') }
  }
  const q = state.questions.find((x) => x.id === fresh[0].id)
  const first = q?.questions[0]
  return {
    title: `${canvasOf(fresh[0])} asks`,
    body: trunc(first?.header || first?.question || 'Waiting on your choice'),
  }
}
