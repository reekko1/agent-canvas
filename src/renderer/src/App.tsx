import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CardNode, type CardData, type CardMeta } from './CardNode'
import { Button } from '@/components/ui/button'
import type { AskDecision } from '../../shared/types'

const nodeTypes = { card: CardNode }

// Default on-canvas card size (the Swift CanvasLayout.cardSize).
const CARD_W = 960
const CARD_H = 640

function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CardData>>([])
  const { setViewport, getViewport } = useReactFlow()
  const [hydrated, setHydrated] = useState(false)

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

  // First sighting of a session on a card (fresh spawn, restore, or events
  // resuming after reattach): record it and replace the plan with the CLI's
  // stored list. null = no task store (or none yet) → leave the accumulated
  // todos alone — never wipe real data with an absence.
  const knownSessions = useRef(new Map<string, string>())
  const hydrateTodos = useCallback(
    (cardId: string, sessionId: string) => {
      if (knownSessions.current.get(cardId) === sessionId) return
      knownSessions.current.set(cardId, sessionId)
      patchMeta(cardId, (m) => ({ ...m, sessionId }))
      void window.canvas.readTodos(sessionId).then((todos) => {
        if (todos) patchMeta(cardId, (m) => ({ ...m, todos }))
      })
    },
    [patchMeta],
  )

  useEffect(() => {
    const offEvent = window.canvas.onCardEvent((cardId, ev) => {
      patchMeta(cardId, (m) => {
        const meta = { ...m }
        if (ev.status) {
          if (ev.status !== meta.status) meta.statusSince = Date.now()
          meta.status = ev.status
          // Any non-blocked status means the ask resolved CLI-side (answered,
          // timed out, or released) — never leave a stale overlay up.
          if (ev.status !== 'blocked') meta.ask = null
        }
        if (ev.detail) meta.detail = ev.detail
        if (ev.taskLabel) meta.task = ev.taskLabel
        if (ev.clearTask) meta.task = undefined
        if (ev.summary) meta.summary = ev.summary
        if (ev.model) meta.model = ev.model
        if (ev.permissionMode) meta.permissionMode = ev.permissionMode
        if (ev.resetSubagents) meta.subagents = 0
        if (ev.subagentDelta) {
          meta.subagents = Math.max(0, (meta.subagents ?? 0) + ev.subagentDelta)
        }
        const tc = ev.todoChange
        if (tc) {
          // The card owns the accumulated plan; the adapter stays stateless.
          if (tc.kind === 'replace') meta.todos = tc.todos
          else if (tc.kind === 'clear') meta.todos = undefined
          else if (tc.kind === 'add') meta.todos = [...(meta.todos ?? []), tc.todo]
          else if (tc.kind === 'update') {
            meta.todos = (meta.todos ?? []).flatMap((t) => {
              if (t.id !== tc.id) return [t]
              if (tc.status === 'deleted') return []
              return [
                {
                  ...t,
                  status: tc.status ?? t.status,
                  content: tc.content ?? t.content,
                  activeForm: tc.activeForm ?? t.activeForm,
                },
              ]
            })
          }
        }
        return meta
      })
      if (ev.sessionId) hydrateTodos(cardId, ev.sessionId)
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
  }, [patchMeta, hydrateTodos])

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

  // Restore the saved canvas once. Layout comes from disk; each agent
  // reattaches (or respawns) via tmux when its CardNode mounts.
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
    window.canvas.saveWorkspace({
      items: nodes.map((n) => ({
        kind: 'card' as const,
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        w: n.width ?? CARD_W,
        h: n.height ?? CARD_H,
        folder: n.data.folder,
        session: n.data.meta.sessionId,
      })),
      viewport: getViewport(),
    })
  }, [hydrated, nodes, getViewport])

  // Debounced layout saves (drags stream position changes); pan/zoom ends
  // save directly via onMoveEnd below.
  useEffect(() => {
    const t = setTimeout(persist, 300)
    return () => clearTimeout(t)
  }, [persist])

  async function addCard(): Promise<void> {
    const r = await window.canvas.newCard()
    if (!r) return
    setNodes((ns) => [
      ...ns,
      makeNode(r.cardId, r.folder, {
        x: 120 + (ns.length % 4) * (CARD_W + 80),
        y: 120 + Math.floor(ns.length / 4) * (CARD_H + 80),
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

export function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  )
}
