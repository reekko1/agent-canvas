import { useCallback, useEffect, useState } from 'react'
import type { CanvasNode } from './nodes'
import type { CardRecord, Project } from '@shared/types'

/// Restore-once + debounced persist for the canvas (renderer end of the
/// Workspace port). Layout is derived (master-stack, fixed viewport), so this
/// persists only the global card registry + the projects that order them and
/// name a master. Status is never persisted, so a glyph can't lie.
export function useWorkspace({
  nodes,
  setNodes,
  restoreItem,
  hydrateTodos,
  projects,
  activeProjectId,
  onRestore,
}: {
  nodes: CanvasNode[]
  setNodes: (ns: CanvasNode[]) => void
  /** Build the node for one saved card (null = unusable record — drop it). */
  restoreItem: (card: CardRecord) => CanvasNode | null
  hydrateTodos: (cardId: string, sessionId: string) => void
  projects: Project[]
  activeProjectId: string | null
  /** Hand the restored projects + active id back to the canvas on load. */
  onRestore: (projects: Project[], activeProjectId: string | null) => void
}) {
  const [hydrated, setHydrated] = useState(false)

  const [restoredOnce, setRestoredOnce] = useState(false)
  useEffect(() => {
    if (restoredOnce) return
    setRestoredOnce(true)
    void (async () => {
      const ws = await window.canvas.loadWorkspace()
      if (ws) {
        // Drop ghost cards — registry entries no project references. Mounting
        // one would respawn its tmux session for a card on no canvas (and it
        // can't be closed from the UI). Restoring only members keeps the
        // registry honest; the next save drops the ghosts from disk too.
        const onACanvas = new Set(ws.projects.flatMap((p) => p.cardIds))
        const cards = ws.cards.filter((c) => onACanvas.has(c.id))
        // setNodes BEFORE onRestore: in React 18 these async-callback updates
        // aren't batched, so projects must not reference cards not yet mounted
        // (else one render sees an empty active project).
        setNodes(cards.map(restoreItem).filter((n): n is CanvasNode => n !== null))
        onRestore(ws.projects, ws.activeProjectId)
        // Reattached sessions sit silent until their next hook event — pull
        // their plan from the CLI's task store now, not on first activity.
        for (const c of cards) {
          if (c.kind === 'agent' && c.session) hydrateTodos(c.id, c.session)
        }
      }
      setHydrated(true)
    })()
  }, [restoredOnce, restoreItem, setNodes, hydrateTodos, onRestore])

  const persist = useCallback(() => {
    if (!hydrated) return // never let a blank pre-restore canvas clobber the file
    // Only agent/shell cards are persisted — diffs are a transient side sheet.
    // Card data lives in the registry; projects order them and name a master.
    const cards: CardRecord[] = nodes.flatMap((n) =>
      n.type === 'card'
        ? [
            {
              id: n.id,
              folder: n.data.folder,
              kind: n.data.kind,
              session: n.data.meta.sessionId,
              name: n.data.name,
            },
          ]
        : [],
    )
    window.canvas.saveWorkspace({ cards, projects, activeProjectId })
  }, [hydrated, nodes, projects, activeProjectId])

  // Debounced saves (add/close/promote/move/switch all change the snapshot).
  useEffect(() => {
    const t = setTimeout(persist, 300)
    return () => clearTimeout(t)
  }, [persist])

  return { persist }
}
