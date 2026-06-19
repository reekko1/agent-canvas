import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'

/** How long the deck-restack switch animation runs before `switching` clears.
 *  A hair longer than the 300ms CSS animation so the deck-enter/leave classes
 *  outlast the keyframes and the cards never snap before they've settled. */
const DECK_MS = 340

/** The deck-restack transition in flight: the receding (`leaving`) and rising
 *  (`entering`) canvases. Non-null only for the switch animation window; null
 *  when idle or when switching from/to the empty state. Shared with
 *  `useMasterStackLayout` so the layout hook tracks the exact same shape. */
export type SwitchState = { leaving: string; entering: string } | null

export interface ProjectsApi {
  projects: Project[]
  /** The active canvas, or null when there are none (the empty state). */
  activeProjectId: string | null
  /** The active project, or undefined when there are no projects. */
  active: Project | undefined
  /** False for one frame during a project switch, so the layout snaps instead
   *  of sliding cards in from their parked offscreen position. */
  animate: boolean
  /** The deck-restack transition in flight: the receding (`leaving`) and rising
   *  (`entering`) canvases. Non-null only for the switch animation window; null
   *  when idle or when switching from/to the empty state (no board to cross-fade). */
  switching: SwitchState
  /** Add a card to the active project and make it the master. */
  attachCard: (cardId: string) => void
  /** Add a card to a specific project (by id) and make it that canvas's master. */
  attachCardTo: (projectId: string, cardId: string) => void
  /** Remove a card from whatever project owns it, fixing that project's focus. */
  detachCard: (cardId: string) => void
  /** Focus a card as master — switching to its project first if needed. */
  promote: (cardId: string) => void
  createProject: (name: string, dir: string) => void
  switchProject: (id: string) => void
  renameProject: (id: string, name: string) => void
  /** Delete a project; its cards are killed by the caller first. Switching to
   *  another project, or the empty state if it was the last. */
  deleteProject: (id: string) => void
  /** A card's owning canvas name — the remote panel tags each card with it. */
  projectNameForCard: (cardId: string) => string | undefined
  restore: (projects: Project[], activeProjectId: string | null) => void
}

/// Owns the projects (each a named canvas pinned to a dir) and which one is
/// active. Cards are global and always mounted; a project only references them
/// by id and remembers its master, so switching and deleting never touch a tmux
/// session. There is no implicit default — zero projects is a valid state.
export function useProjects(makeProjectId: () => string): ProjectsApi {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [animate, setAnimate] = useState(true)
  const [switching, setSwitching] = useState<SwitchState>(null)

  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const activeRef = useRef(activeProjectId)
  activeRef.current = activeProjectId
  const reanim = useRef(0)
  const deckTimer = useRef(0)

  // Suppress transitions for the switch frame, then re-enable two frames later
  // (after the no-transition layout has committed).
  const gate = useCallback(() => {
    setAnimate(false)
    cancelAnimationFrame(reanim.current)
    reanim.current = requestAnimationFrame(() =>
      requestAnimationFrame(() => setAnimate(true)),
    )
  }, [])

  // The one path that changes the active canvas: snap the layout (gate), then
  // arm the deck-restack cross-fade when there's both an outgoing and incoming
  // board. The window auto-clears after the animation so cards settle.
  const setActive = useCallback(
    (toId: string | null) => {
      const from = activeRef.current
      gate()
      setActiveProjectId(toId)
      clearTimeout(deckTimer.current)
      if (toId && from && from !== toId) {
        setSwitching({ leaving: from, entering: toId })
        deckTimer.current = window.setTimeout(() => setSwitching(null), DECK_MS)
      } else {
        setSwitching(null)
      }
    },
    [gate],
  )

  // Cancel a pending re-enable / deck-clear if the canvas ever unmounts.
  useEffect(
    () => () => {
      cancelAnimationFrame(reanim.current)
      clearTimeout(deckTimer.current)
    },
    [],
  )

  const active = projects.find((p) => p.id === activeProjectId)

  const attachCard = useCallback((cardId: string) => {
    setProjects((ps) =>
      ps.map((p) =>
        p.id === activeRef.current
          ? { ...p, cardIds: [...p.cardIds.filter((c) => c !== cardId), cardId], focusedCardId: cardId }
          : p,
      ),
    )
  }, [])

  const attachCardTo = useCallback((projectId: string, cardId: string) => {
    setProjects((ps) =>
      ps.map((p) =>
        p.id === projectId
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
      if (owner.id !== activeRef.current) setActive(owner.id)
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
    [setActive],
  )

  const createProject = useCallback(
    (name: string, dir: string) => {
      const id = makeProjectId()
      setProjects((ps) => [
        ...ps,
        { id, name: name.trim() || 'Canvas', cardIds: [], focusedCardId: undefined, dir },
      ])
      setActive(id)
    },
    [makeProjectId, setActive],
  )

  const switchProject = useCallback(
    (id: string) => {
      setActive(id)
    },
    [setActive],
  )

  const renameProject = useCallback((id: string, name: string) => {
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)))
  }, [])

  // Drops the project outright. Its cards' sessions are killed by the caller
  // (Canvas) first — deleting a canvas closes everything on it. If it was the
  // active one, fall to the first remaining project, or the empty state.
  const deleteProject = useCallback(
    (id: string) => {
      const next = projectsRef.current.filter((p) => p.id !== id)
      setProjects(next)
      if (activeRef.current === id) setActive(next[0]?.id ?? null)
    },
    [setActive],
  )

  const projectNameForCard = useCallback(
    (cardId: string) => projectsRef.current.find((p) => p.cardIds.includes(cardId))?.name,
    [],
  )

  const restore = useCallback((restored: Project[], restoredActive: string | null) => {
    setProjects(restored)
    setActiveProjectId(
      restored.some((p) => p.id === restoredActive) ? restoredActive : (restored[0]?.id ?? null),
    )
  }, [])

  return {
    projects,
    activeProjectId,
    active,
    animate,
    switching,
    attachCard,
    attachCardTo,
    detachCard,
    promote,
    createProject,
    switchProject,
    renameProject,
    deleteProject,
    projectNameForCard,
    restore,
  }
}
