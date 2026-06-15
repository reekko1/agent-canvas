import { useMemo } from 'react'
import type { Project } from '@shared/types'
import type { CanvasNode } from './nodes'
import type { PendingAsk } from './usePendingAsks'
import type { PendingQuestion } from './usePendingQuestions'

/// How loudly a canvas wants the user, rolled up from its cards:
/// - `blocking` — a card is stalled ON YOU (pending ask/question, or
///   blocked/error status). The agent can't proceed without you.
/// - `done` — a card finished and is waiting for a look. Not urgent.
/// - `none` — quiet.
export type AttentionLevel = 'none' | 'done' | 'blocking'

const RANK: Record<AttentionLevel, number> = { none: 0, done: 1, blocking: 2 }
const louder = (a: AttentionLevel, b: AttentionLevel): AttentionLevel =>
  RANK[a] >= RANK[b] ? a : b

/// Derives a per-project attention level from the live card meta + the held
/// asks/questions. Keyed by project id. Cheap (sets + one pass per project) and
/// memoized on its inputs, so it recomputes only when something actually moves.
export function useProjectAttention({
  projects,
  nodes,
  asks,
  questions,
}: {
  projects: Project[]
  nodes: CanvasNode[]
  asks: PendingAsk[]
  questions: PendingQuestion[]
}): Record<string, AttentionLevel> {
  return useMemo(() => {
    // Per-card level: a held ask/question or a blocked/error status is blocking;
    // a done status is a soft "review me".
    const blocking = new Set<string>()
    const done = new Set<string>()
    for (const n of nodes) {
      if (n.type !== 'card') continue
      const s = n.data.meta.status
      if (s === 'blocked' || s === 'error') blocking.add(n.id)
      else if (s === 'done') done.add(n.id)
    }
    for (const a of asks) blocking.add(a.cardId)
    for (const q of questions) blocking.add(q.cardId)

    const out: Record<string, AttentionLevel> = {}
    for (const p of projects) {
      let level: AttentionLevel = 'none'
      for (const id of p.cardIds) {
        if (blocking.has(id)) {
          level = 'blocking'
          break // can't get louder
        }
        if (done.has(id)) level = louder(level, 'done')
      }
      out[p.id] = level
    }
    return out
  }, [projects, nodes, asks, questions])
}

/// The loudest level among canvases other than `activeId` — drives the "look
/// elsewhere" dot on the collapsed toolbar pill.
export function attentionElsewhere(
  attention: Record<string, AttentionLevel>,
  activeId: string | null,
): AttentionLevel {
  let level: AttentionLevel = 'none'
  for (const [id, l] of Object.entries(attention)) {
    if (id !== activeId) level = louder(level, l)
  }
  return level
}
