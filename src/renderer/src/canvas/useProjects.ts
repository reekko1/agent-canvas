import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, type Project } from '@shared/types'

const defaultProject = (): Project => ({
  id: DEFAULT_PROJECT_ID,
  name: DEFAULT_PROJECT_NAME,
  cardIds: [],
  focusedCardId: undefined,
})

export interface ProjectsApi {
  projects: Project[]
  activeProjectId: string
  active: Project
  /** False for one frame during a project switch, so the layout snaps instead
   *  of sliding cards in from their parked offscreen position. */
  animate: boolean
  /** Add a card to the active project and make it the master. */
  attachCard: (cardId: string) => void
  /** Remove a card from whatever project owns it, fixing that project's focus. */
  detachCard: (cardId: string) => void
  /** Focus a card as master — switching to its project first if needed. */
  promote: (cardId: string) => void
  createProject: (name: string) => void
  switchProject: (id: string) => void
  renameProject: (id: string, name: string) => void
  /** Delete a project; its cards orphan into Default. Default is undeletable. */
  deleteProject: (id: string) => void
  moveCard: (cardId: string, projectId: string) => void
  projectIdForCard: (cardId: string) => string | undefined
  projectNameForCard: (cardId: string) => string | undefined
  restore: (projects: Project[], activeProjectId: string) => void
}

/// Owns the projects (each a named canvas of cards) and which one is active.
/// Cards are global and always mounted; a project only references them by id
/// and remembers its master, so switching, moving, and deleting never touch a
/// tmux session. Single source of truth for membership, order, and focus.
export function useProjects(makeProjectId: () => string): ProjectsApi {
  const [projects, setProjects] = useState<Project[]>(() => [defaultProject()])
  const [activeProjectId, setActiveProjectId] = useState(DEFAULT_PROJECT_ID)
  const [animate, setAnimate] = useState(true)

  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const activeRef = useRef(activeProjectId)
  activeRef.current = activeProjectId
  const reanim = useRef(0)

  // Suppress transitions for the switch frame, then re-enable two frames later
  // (after the no-transition layout has committed).
  const gate = useCallback(() => {
    setAnimate(false)
    cancelAnimationFrame(reanim.current)
    reanim.current = requestAnimationFrame(() =>
      requestAnimationFrame(() => setAnimate(true)),
    )
  }, [])

  // Cancel a pending re-enable if the canvas ever unmounts.
  useEffect(() => () => cancelAnimationFrame(reanim.current), [])

  const active = projects.find((p) => p.id === activeProjectId) ?? projects[0]

  const attachCard = useCallback((cardId: string) => {
    setProjects((ps) =>
      ps.map((p) =>
        p.id === activeRef.current
          ? { ...p, cardIds: [...p.cardIds.filter((c) => c !== cardId), cardId], focusedCardId: cardId }
          : p,
      ),
    )
  }, [])

  const detachCard = useCallback((cardId: string) => {
    setProjects((ps) =>
      ps.map((p) => {
        if (!p.cardIds.includes(cardId)) return p
        const cardIds = p.cardIds.filter((c) => c !== cardId)
        return { ...p, cardIds, focusedCardId: p.focusedCardId === cardId ? cardIds[0] : p.focusedCardId }
      }),
    )
  }, [])

  const promote = useCallback(
    (cardId: string) => {
      const owner = projectsRef.current.find((p) => p.cardIds.includes(cardId))
      if (!owner) return
      if (owner.id !== activeRef.current) {
        gate()
        setActiveProjectId(owner.id)
      }
      setProjects((ps) =>
        ps.map((p) => {
          if (p.id !== owner.id) return p
          // Demote the outgoing master to the top of the stack.
          let cardIds = p.cardIds
          const prev = p.focusedCardId
          if (prev && prev !== cardId) {
            const i = cardIds.indexOf(prev)
            if (i > 0) cardIds = [prev, ...cardIds.slice(0, i), ...cardIds.slice(i + 1)]
          }
          return { ...p, cardIds, focusedCardId: cardId }
        }),
      )
    },
    [gate],
  )

  const createProject = useCallback(
    (name: string) => {
      const id = makeProjectId()
      setProjects((ps) => [...ps, { id, name: name.trim() || 'Canvas', cardIds: [], focusedCardId: undefined }])
      gate()
      setActiveProjectId(id)
    },
    [makeProjectId, gate],
  )

  const switchProject = useCallback(
    (id: string) => {
      gate()
      setActiveProjectId(id)
    },
    [gate],
  )

  const renameProject = useCallback((id: string, name: string) => {
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)))
  }, [])

  const deleteProject = useCallback(
    (id: string) => {
      if (id === DEFAULT_PROJECT_ID) return
      setProjects((ps) => {
        const victim = ps.find((p) => p.id === id)
        if (!victim) return ps
        return ps
          .filter((p) => p.id !== id)
          .map((p) =>
            p.id === DEFAULT_PROJECT_ID ? { ...p, cardIds: [...p.cardIds, ...victim.cardIds] } : p,
          )
      })
      if (activeRef.current === id) {
        gate()
        setActiveProjectId(DEFAULT_PROJECT_ID)
      }
    },
    [gate],
  )

  const moveCard = useCallback((cardId: string, projectId: string) => {
    setProjects((ps) =>
      ps.map((p) => {
        if (p.id === projectId) return { ...p, cardIds: [...p.cardIds.filter((c) => c !== cardId), cardId] }
        if (p.cardIds.includes(cardId)) {
          const cardIds = p.cardIds.filter((c) => c !== cardId)
          return { ...p, cardIds, focusedCardId: p.focusedCardId === cardId ? cardIds[0] : p.focusedCardId }
        }
        return p
      }),
    )
  }, [])

  const projectIdForCard = useCallback(
    (cardId: string) => projectsRef.current.find((p) => p.cardIds.includes(cardId))?.id,
    [],
  )
  const projectNameForCard = useCallback(
    (cardId: string) => projectsRef.current.find((p) => p.cardIds.includes(cardId))?.name,
    [],
  )

  const restore = useCallback((restored: Project[], restoredActive: string) => {
    const withDefault = restored.some((p) => p.id === DEFAULT_PROJECT_ID)
      ? restored
      : [defaultProject(), ...restored]
    setProjects(withDefault)
    setActiveProjectId(withDefault.some((p) => p.id === restoredActive) ? restoredActive : DEFAULT_PROJECT_ID)
  }, [])

  return {
    projects,
    activeProjectId,
    active,
    animate,
    attachCard,
    detachCard,
    promote,
    createProject,
    switchProject,
    renameProject,
    deleteProject,
    moveCard,
    projectIdForCard,
    projectNameForCard,
    restore,
  }
}
