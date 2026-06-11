import { useCallback, useEffect, useRef, useState } from 'react'
import { useReactFlow, type Node } from '@xyflow/react'
import { CARD_H, CARD_W } from './layout'
import type { CardData } from '@/cards/meta'
import type { WorkspaceItem } from '@shared/types'

/// Restore-once + debounced persist for the canvas (renderer end of the
/// Workspace port). Layout only: agents reattach via tmux when their
/// CardNode mounts; status is never persisted, so a glyph can't lie.
export function useWorkspace({
  nodes,
  setNodes,
  makeNode,
  hydrateTodos,
}: {
  nodes: Node<CardData>[]
  setNodes: (ns: Node<CardData>[]) => void
  makeNode: (
    cardId: string,
    folder: string,
    position: { x: number; y: number },
    size?: { w?: number; h?: number },
  ) => Node<CardData>
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
        if (ws.viewport) void setViewport(ws.viewport)
        const items = ws.items.filter((i) => i.kind === 'card' && i.folder)
        setNodes(items.map((i) => makeNode(i.id, i.folder, { x: i.x, y: i.y }, { w: i.w, h: i.h })))
        // Reattached sessions sit silent until their next hook event — pull
        // their plan from the CLI's task store now, not on first activity.
        for (const i of items) if (i.session) hydrateTodos(i.id, i.session)
      }
      setHydrated(true)
    })()
  }, [makeNode, setNodes, setViewport, hydrateTodos])

  const persist = useCallback(() => {
    if (!hydrated) return // never let a blank pre-restore canvas clobber the file
    const items: WorkspaceItem[] = nodes.map((n) => ({
      kind: 'card' as const,
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      w: n.width ?? CARD_W,
      h: n.height ?? CARD_H,
      folder: n.data.folder,
      session: n.data.meta.sessionId,
    }))
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
