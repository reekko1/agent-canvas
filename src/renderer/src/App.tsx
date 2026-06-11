import { useCallback, useEffect } from 'react'
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CardNode, type CardData, type CardMeta } from './CardNode'
import { Button } from '@/components/ui/button'
import type { AskDecision } from '../../shared/types'

const nodeTypes = { card: CardNode }

function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CardData>>([])

  const patchMeta = useCallback(
    (cardId: string, patch: (meta: CardMeta) => CardMeta) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === cardId ? { ...n, data: { ...n.data, meta: patch(n.data.meta) } } : n,
        ),
      )
    },
    [setNodes],
  )

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

  useEffect(() => {
    const offEvent = window.canvas.onCardEvent((cardId, ev) => {
      patchMeta(cardId, (m) => {
        const meta = { ...m }
        if (ev.status) {
          meta.status = ev.status
          // Any non-blocked status means the ask resolved CLI-side (answered,
          // timed out, or released) — never leave a stale overlay up.
          if (ev.status !== 'blocked') meta.ask = null
        }
        if (ev.detail) meta.detail = ev.detail
        if (ev.taskLabel) meta.task = ev.taskLabel
        if (ev.clearTask) meta.task = undefined
        if (ev.model) meta.model = ev.model
        if (ev.permissionMode) meta.permissionMode = ev.permissionMode
        return meta
      })
    })
    const offAsk = window.canvas.onAsk((ask) => {
      patchMeta(ask.cardId, (m) => ({ ...m, ask }))
    })
    const offExit = window.canvas.onPtyExit((cardId) => {
      patchMeta(cardId, (m) => ({ ...m, status: 'idle', detail: 'terminal exited', ask: null }))
    })
    return () => {
      offEvent()
      offAsk()
      offExit()
    }
  }, [patchMeta])

  async function addCard(): Promise<void> {
    const r = await window.canvas.newCard()
    if (!r) return
    setNodes((ns) => [
      ...ns,
      {
        id: r.cardId,
        type: 'card',
        position: { x: 120 + (ns.length % 4) * 880, y: 120 + Math.floor(ns.length / 4) * 560 },
        dragHandle: '.card-drag',
        data: { folder: r.folder, meta: { status: 'idle' }, onDecide, onClose },
      },
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

export function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  )
}
