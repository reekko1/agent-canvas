import { useCallback } from 'react'
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  useNodesState,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button } from '@/components/ui/button'
import { CardNode } from '@/cards/CardNode'
import type { CardData } from '@/cards/meta'
import type { AskDecision } from '@shared/types'
import { CARD_GAP, CARD_H, CARD_W } from './layout'
import { useCardMeta } from './useCardMeta'
import { useWorkspace } from './useWorkspace'

const nodeTypes = { card: CardNode }

/// The infinite canvas: cards on a dot grid, a toolbar, and the wiring that
/// turns spine events and disk state into nodes. Behavior lives in the hooks
/// (useCardMeta, useWorkspace); this file is composition.
export function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CardData>>([])
  const { patchMeta, hydrateTodos } = useCardMeta(setNodes)

  const onDecide = useCallback(
    (cardId: string, askId: string, decision: AskDecision) => {
      window.canvas.decide(askId, decision)
      patchMeta(cardId, (m) => ({ ...m, ask: null }))
    },
    [patchMeta],
  )

  const onClose = useCallback(
    (cardId: string) => {
      void window.canvas.killCard(cardId)
      setNodes((ns) => ns.filter((n) => n.id !== cardId))
    },
    [setNodes],
  )

  const makeNode = useCallback(
    (
      cardId: string,
      folder: string,
      position: { x: number; y: number },
      size?: { w?: number; h?: number },
    ): Node<CardData> => ({
      id: cardId,
      type: 'card',
      position,
      width: size?.w ?? CARD_W,
      height: size?.h ?? CARD_H,
      dragHandle: '.card-drag',
      data: { folder, meta: { status: 'idle' }, onDecide, onClose },
    }),
    [onDecide, onClose],
  )

  const { persist } = useWorkspace({ nodes, setNodes, makeNode, hydrateTodos })

  async function addCard(): Promise<void> {
    const r = await window.canvas.newCard()
    if (!r) return
    setNodes((ns) => [
      ...ns,
      makeNode(r.cardId, r.folder, {
        x: 120 + (ns.length % 4) * (CARD_W + CARD_GAP),
        y: 120 + Math.floor(ns.length / 4) * (CARD_H + CARD_GAP),
      }),
    ])
  }

  return (
    <div className="h-screen w-screen">
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        minZoom={0.08}
        maxZoom={1.25}
        proOptions={{ hideAttribution: true }}
        onMoveEnd={persist}
      >
        <Background variant={BackgroundVariant.Dots} color="var(--border)" gap={32} />
      </ReactFlow>

      <div className="fixed left-3.5 top-3.5 z-10 flex items-center gap-3">
        <Button onClick={() => void addCard()}>+ New Agent</Button>
        {nodes.length === 0 && (
          <span className="font-mono text-xs text-muted-foreground">
            pick a folder — a real `claude` spawns in a tmux session
          </span>
        )}
      </div>
    </div>
  )
}
