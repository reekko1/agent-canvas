import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Conception,
  DistanceAssessment,
  Issue,
  IssueActionRequest,
  IssueSnapshot,
  Plan,
  Sprint,
  Vision,
  VisionEditClass,
  VisionVersion,
} from '@shared/types'

/// The renderer end of the Mastermind issue store — an **observation** projection.
/// Restore-once on mount, then live: every applied action (here, or — over MCP —
/// from an agent) re-pushes the whole projection over `onIssueUpdate`, so this
/// never mutates local state. Reads dominate: the board watches a self-running
/// fleet. The only writes left are the human's genuine touchpoints — authoring
/// the vision (`commitVisionVersion`), recording a distance assessment
/// (`assessDistance`), and answering a realignment escalation
/// (`resolveRealignment`). Everything routine (create/decompose/status/verdict) is
/// the agents' job over MCP, not the renderer's. Everything is filtered to the
/// active project — each canvas has its own vision and sprints.

const EMPTY: IssueSnapshot = {
  visions: [],
  versions: [],
  sprints: [],
  plans: [],
  issues: [],
  distance: [],
  conceptions: [],
}

/// The vision/distance writer in v1 is the human; the seam an agent identity later fills.
const ACTOR = 'human'

export interface IssueBoardApi {
  hydrated: boolean
  /** The active canvas's vision pointer (undefined before its first commit). */
  vision: Vision | undefined
  /** The active canvas's versions, newest-first (the timeline order). */
  versions: VisionVersion[]
  currentVersion: VisionVersion | undefined
  /** The active project's sprints. */
  sprints: Sprint[]
  plansBySprint: (sprintId: string) => Plan[]
  issuesByPlan: (planId: string) => Issue[]
  /** Distance assessments, newest-first. */
  distance: DistanceAssessment[]
  latestDistance: DistanceAssessment | undefined
  /** The active project's strategist deliberations (recorded tournaments), newest-first. */
  conceptions: Conception[]
  /** The deliberation running right now (a tournament in progress), if any. */
  liveConception: Conception | undefined

  // Writes — the human's three touchpoints only. Each is one issueAction; truth
  // returns over onIssueUpdate. The fleet's own writes arrive over the same
  // broadcast from main (MCP), never from here.
  commitVisionVersion(input: {
    body: string
    principles: string[]
    antiVision: string[]
    rationale: string
    class: VisionEditClass
  }): void
  assessDistance(note: string): void
  resolveRealignment(id: string, outcome: 'aligned' | 'remove', note?: string): void
}

export function useIssueBoard({
  activeProjectId,
}: {
  activeProjectId: string | null
}): IssueBoardApi {
  const [snapshot, setSnapshot] = useState<IssueSnapshot>(EMPTY)
  const [hydrated, setHydrated] = useState(false)

  // Restore-once + subscribe-once. The update callback just replaces the whole
  // snapshot, so no live-state ref is needed (unlike the command-bus hooks).
  useEffect(() => {
    let alive = true
    void window.canvas.loadIssueStore().then((s) => {
      if (!alive) return
      if (s) setSnapshot(s)
      setHydrated(true)
    })
    const off = window.canvas.onIssueUpdate((s) => setSnapshot(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  const act = useCallback((action: IssueActionRequest) => {
    void window.canvas.issueAction(action).then((r) => {
      if (!r.ok) console.warn('[issues] action rejected:', action.kind, '—', r.message)
    })
  }, [])

  const vision = useMemo(
    () => snapshot.visions.find((v) => v.projectId === activeProjectId),
    [snapshot.visions, activeProjectId],
  )
  const versions = useMemo(
    () => snapshot.versions.filter((v) => v.projectId === activeProjectId).reverse(),
    [snapshot.versions, activeProjectId],
  )
  const currentVersion = useMemo(
    () => snapshot.versions.find((v) => v.id === vision?.currentVersion),
    [snapshot.versions, vision],
  )
  const sprints = useMemo(
    () => snapshot.sprints.filter((s) => s.projectId === activeProjectId),
    [snapshot.sprints, activeProjectId],
  )
  const distance = useMemo(
    () => snapshot.distance.filter((d) => d.projectId === activeProjectId).reverse(),
    [snapshot.distance, activeProjectId],
  )
  const conceptions = useMemo(
    () => snapshot.conceptions.filter((c) => c.projectId === activeProjectId).reverse(),
    [snapshot.conceptions, activeProjectId],
  )

  const plansBySprint = useCallback(
    (sprintId: string) => snapshot.plans.filter((p) => p.sprintRef === sprintId),
    [snapshot.plans],
  )
  const issuesByPlan = useCallback(
    (planId: string) => snapshot.issues.filter((i) => i.planRef === planId),
    [snapshot.issues],
  )

  const commitVisionVersion = useCallback<IssueBoardApi['commitVisionVersion']>(
    (input) => {
      if (!activeProjectId) return
      act({ kind: 'vision.commit', projectId: activeProjectId, ...input })
    },
    [act, activeProjectId],
  )
  const assessDistance = useCallback(
    (note: string) => {
      if (!activeProjectId) return
      act({ kind: 'vision.assessDistance', projectId: activeProjectId, note, assessedBy: ACTOR })
    },
    [act, activeProjectId],
  )
  const resolveRealignment = useCallback(
    (id: string, outcome: 'aligned' | 'remove', note?: string) =>
      act({ kind: 'sprint.resolveRealignment', id, outcome, note }),
    [act],
  )

  return {
    hydrated,
    vision,
    versions,
    currentVersion,
    sprints,
    plansBySprint,
    issuesByPlan,
    distance,
    latestDistance: distance[0],
    conceptions,
    liveConception: conceptions.find((c) => c.state === 'deliberating'),
    commitVisionVersion,
    assessDistance,
    resolveRealignment,
  }
}
