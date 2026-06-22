import { useEffect, useState } from 'react'
import type { SkillsSnapshot, SkillView } from '@shared/types'

const EMPTY: SkillsSnapshot = { active: [], archived: [] }

export interface SkillsPanelApi {
  hydrated: boolean
  active: SkillView[]
  archived: SkillView[]
}

/// Read-only projection of the mastermind's self-authored skill library. Restore-once +
/// subscribe-once (the whole snapshot is re-pushed on every change, like useIssueBoard);
/// the update callback just replaces it, so no live-state ref is needed. The library is
/// GLOBAL (not per-canvas), so this hook takes no projectId.
export function useSkillsPanel(): SkillsPanelApi {
  const [snapshot, setSnapshot] = useState<SkillsSnapshot>(EMPTY)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let alive = true
    void window.canvas.loadMastermindSkills().then((s) => {
      if (!alive) return
      if (s) setSnapshot(s)
      setHydrated(true)
    })
    const off = window.canvas.onSkillsUpdate((s) => setSnapshot(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  return { hydrated, active: snapshot.active, archived: snapshot.archived }
}
