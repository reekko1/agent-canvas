import { useCallback, useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { CARD_H, CARD_W, MAX_ZOOM } from './layout'
import type { CanvasNode } from './nodes'
import type { WorkspaceItem } from '@shared/types'

/// Restore-once + debounced persist for the canvas (renderer end of the
/// Workspace port). Layout only: agents reattach via tmux and diff watchers
/// restart when their nodes mount; status is never persisted, so a glyph
/// can't lie.
export function useWorkspace({
  nodes,
  setNodes,
  restoreItem,
  hydrateTodos,
}: {
  nodes: CanvasNode[]
  setNodes: (ns: CanvasNode[]) => void
  /** Build the node for one saved item (null = unknown kind — drop it). */
  restoreItem: (item: WorkspaceItem) => CanvasNode | null
  hydrateTodos: (cardId: string, sessionId: string) => void
}) {
  const { setViewport, getViewport } = useReactFlow()
  const [hydrated, setHydrated] = useState(false)

  const restoredOnce = useRef(false)
  useEffect(() => {
    if (restoredOnce.current) return
    restoredOnce.current = true
    void (async () => {
      const ws = await window.canvas.loadWorkspace()
      if (ws) {
        // Clamp the saved zoom into today's ceiling (older workspaces could
        // save up to 1.25); the dynamic floor re-clamps once nodes land.
        if (ws.viewport) {
          void setViewport({ ...ws.viewport, zoom: Math.min(ws.viewport.zoom, MAX_ZOOM) })
        }
        const items = ws.items.filter((i) => i.kind === 'frame' || i.folder)
        setNodes(items.map(restoreItem).filter((n): n is CanvasNode => n !== null))
        // Reattached sessions sit silent until their next hook event — pull
        // their plan from the CLI's task store now, not on first activity.
        for (const i of items) {
          if (i.kind === 'card' && i.session) hydrateTodos(i.id, i.session)
        }
      }
      setHydrated(true)
    })()
  }, [restoreItem, setNodes, setViewport, hydrateTodos])

  const persist = useCallback(() => {
    if (!hydrated) return // never let a blank pre-restore canvas clobber the file
    const items: WorkspaceItem[] = nodes.map((n) => {
      const base = {
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        w: n.width ?? CARD_W,
        h: n.height ?? CARD_H,
      }
      if (n.type === 'frame') return { kind: 'frame' as const, title: n.data.name, ...base }
      if (n.type === 'diff') return { kind: 'diff' as const, folder: n.data.folder, ...base }
      return {
        kind: n.data.kind === 'shell' ? ('shell' as const) : ('card' as const),
        folder: n.data.folder,
        session: n.data.meta.sessionId,
        ...base,
      }
    })
    window.canvas.saveWorkspace({ items, viewport: getViewport() })
  }, [hydrated, nodes, getViewport])

  // Debounced layout saves (drags stream position changes); pan/zoom ends
  // save directly via the canvas's onMoveEnd → persist.
  useEffect(() => {
    const t = setTimeout(persist, 300)
    return () => clearTimeout(t)
  }, [persist])

  return { persist }
}
