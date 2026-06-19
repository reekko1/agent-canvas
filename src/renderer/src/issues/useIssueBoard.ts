import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DistanceAssessment,
  Issue,
  IssueActionRequest,
  IssueKind,
  IssueSnapshot,
  IssueStatus,
  Plan,
  Sprint,
  SprintState,
  Vision,
  VisionEditClass,
  VisionVersion,
} from '@shared/types'

/// The renderer end of the Mastermind issue store. Restore-once on mount, then
/// live: every applied action (here, or — later — from an agent over MCP)
/// re-pushes the whole projection over `onIssueUpdate`, so this never mutates
/// local state — it sends an action and re-renders on the broadcast (single
/// arbiter; the same shape as DiffNode → gitAction → watcher re-push). Everything
/// is filtered to the active project — each canvas has its own vision and sprints.

const EMPTY: IssueSnapshot = {
  visions: [],
  versions: [],
  sprints: [],
  plans: [],
  issues: [],
  distance: [],
}

/// In v1 every actor is the human; this is the seam an agent identity later fills.
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

  // Mutators — each is one issueAction; truth returns over onIssueUpdate.
  commitVisionVersion(input: {
    body: string
    principles: string[]
    antiVision: string[]
    rationale: string
    class: VisionEditClass
  }): void
  assessDistance(note: string): void
  createSprint(input: { outcome: string; gapRationale: string }): void
  setSprintState(id: string, state: SprintState): void
  resolveRealignment(id: string, outcome: 'aligned' | 'remove', note?: string): void
  removeSprint(id: string): void
  createPlan(input: {
    sprintRef: string
    overview: string
    stack: string[]
    structure: string
    deps?: Record<string, string[]>
    nonGoals: string[]
  }): void
  approvePlan(id: string): void
  createIssue(input: {
    planRef: string
    title: string
    description: string
    verify: string
    issueKind: IssueKind
    deps?: string[]
    labels?: string[]
    phase?: string
  }): void
  setIssueStatus(id: string, status: IssueStatus): void
  setIssueDeps(id: string, deps: string[]): void
  postVerdict(
    id: string,
    verdict: 'APPROVED' | 'ISSUES',
    findings: string,
    disposition?: 'clear-fix' | 'needs-decision',
  ): void
  comment(id: string, body: string): void
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
  const createSprint = useCallback<IssueBoardApi['createSprint']>(
    (input) => {
      if (!activeProjectId) return
      act({ kind: 'sprint.create', projectId: activeProjectId, ...input })
    },
    [act, activeProjectId],
  )
  const setSprintState = useCallback(
    (id: string, state: SprintState) => act({ kind: 'sprint.setState', id, state }),
    [act],
  )
  const resolveRealignment = useCallback(
    (id: string, outcome: 'aligned' | 'remove', note?: string) =>
      act({ kind: 'sprint.resolveRealignment', id, outcome, note }),
    [act],
  )
  const removeSprint = useCallback((id: string) => act({ kind: 'sprint.remove', id }), [act])
  const createPlan = useCallback<IssueBoardApi['createPlan']>(
    (input) => act({ kind: 'plan.create', deps: {}, ...input }),
    [act],
  )
  const approvePlan = useCallback((id: string) => act({ kind: 'plan.approve', id }), [act])
  const createIssue = useCallback<IssueBoardApi['createIssue']>(
    (input) => act({ kind: 'issue.create', ...input }),
    [act],
  )
  const setIssueStatus = useCallback(
    (id: string, status: IssueStatus) => act({ kind: 'issue.setStatus', id, status }),
    [act],
  )
  const setIssueDeps = useCallback(
    (id: string, deps: string[]) => act({ kind: 'issue.setDeps', id, deps }),
    [act],
  )
  const postVerdict = useCallback<IssueBoardApi['postVerdict']>(
    (id, verdict, findings, disposition) =>
      act({ kind: 'issue.postVerdict', id, verdict, findings, disposition, author: ACTOR }),
    [act],
  )
  const comment = useCallback(
    (id: string, body: string) => act({ kind: 'issue.comment', id, body, author: ACTOR }),
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
    commitVisionVersion,
    assessDistance,
    createSprint,
    setSprintState,
    resolveRealignment,
    removeSprint,
    createPlan,
    approvePlan,
    createIssue,
    setIssueStatus,
    setIssueDeps,
    postVerdict,
    comment,
  }
}
