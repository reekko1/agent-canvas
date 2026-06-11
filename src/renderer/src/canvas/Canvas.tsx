import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Bot, GitCompareArrows, SquareDashed, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NotificationPopover, type Notification } from '@/components/ui/notification-popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AskToasts } from '@/cards/AskToasts'
import { CardNode } from '@/cards/CardNode'
import { DiffNode } from '@/diff/DiffNode'
import { FrameNode } from '@/frames/FrameNode'
import { FrameChips } from '@/frames/FrameChips'
import { FrameDrawOverlay } from '@/frames/FrameDrawOverlay'
import { frameMembers, nodeRect, type Rect } from '@/frames/geometry'
import type { CardKind, PermissionAskInfo, WorkspaceItem } from '@shared/types'
import { CARD_GAP, CARD_H, CARD_W, DIFF_H, DIFF_W, MIN_FRAME_H, MIN_FRAME_W } from './layout'
import type { CanvasNode } from './nodes'
import { useActivityFeed, type ActivityNotification } from './useActivityFeed'
import { useCardMeta } from './useCardMeta'
import { usePendingAsks } from './usePendingAsks'
import { useWorkspace } from './useWorkspace'

const nodeTypes = { card: CardNode, diff: DiffNode, frame: FrameNode }

/// The infinite canvas: cards, diff objects, and frames on a dot grid, a
/// toolbar, and the wiring that turns spine events and disk state into nodes.
/// Behavior lives in the hooks (useCardMeta, useWorkspace); this file is
/// composition.
export function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const { hydrateTodos } = useCardMeta(setNodes)
  const { asks, decide, releaseCard } = usePendingAsks()
  const { getViewport, screenToFlowPosition, fitBounds, fitView } = useReactFlow()
  const [drawingFrame, setDrawingFrame] = useState(false)

  const onCloseCard = useCallback(
    (cardId: string) => {
      void window.canvas.killCard(cardId)
      setNodes((ns) => ns.filter((n) => n.id !== cardId))
    },
    [setNodes],
  )

  const onCloseDiff = useCallback(
    (diffId: string) => {
      // The watcher stops on unmount; the repo itself is untouched.
      setNodes((ns) => ns.filter((n) => n.id !== diffId))
    },
    [setNodes],
  )

  const makeCard = useCallback(
    (
      cardId: string,
      folder: string,
      position: { x: number; y: number },
      size?: { w?: number; h?: number },
      kind: CardKind = 'agent',
    ): CanvasNode => ({
      id: cardId,
      type: 'card',
      position,
      width: size?.w ?? CARD_W,
      height: size?.h ?? CARD_H,
      dragHandle: '.card-drag',
      data: { folder, kind, meta: { status: 'idle' }, onClose: onCloseCard, onEngage: releaseCard },
    }),
    [onCloseCard, releaseCard],
  )

  const makeDiff = useCallback(
    (
      diffId: string,
      folder: string,
      position: { x: number; y: number },
      size?: { w?: number; h?: number },
    ): CanvasNode => ({
      id: diffId,
      type: 'diff',
      position,
      width: size?.w ?? DIFF_W,
      height: size?.h ?? DIFF_H,
      dragHandle: '.card-drag',
      data: { folder, onClose: onCloseDiff },
    }),
    [onCloseDiff],
  )

  const makeFrame = useCallback(
    (
      frameId: string,
      name: string,
      position: { x: number; y: number },
      size?: { w?: number; h?: number },
    ): CanvasNode => ({
      id: frameId,
      type: 'frame',
      position,
      width: Math.max(size?.w ?? MIN_FRAME_W, MIN_FRAME_W),
      height: Math.max(size?.h ?? MIN_FRAME_H, MIN_FRAME_H),
      zIndex: -1, // a backdrop behind the cards, never above them
      draggable: false, // only the label chip moves a frame
      selectable: false,
      style: { pointerEvents: 'none' }, // the body passes pans through
      data: { name, highlighted: false },
    }),
    [],
  )

  const restoreItem = useCallback(
    (i: WorkspaceItem): CanvasNode | null => {
      const pos = { x: i.x, y: i.y }
      const size = { w: i.w, h: i.h }
      if (i.kind === 'card' && i.folder) return makeCard(i.id, i.folder, pos, size, 'agent')
      if (i.kind === 'shell' && i.folder) return makeCard(i.id, i.folder, pos, size, 'shell')
      if (i.kind === 'diff' && i.folder) return makeDiff(i.id, i.folder, pos, size)
      if (i.kind === 'frame') return makeFrame(i.id, i.title ?? 'Frame', pos, size)
      return null // unknown kind from a future version — drop, don't crash
    },
    [makeCard, makeDiff, makeFrame],
  )

  const { persist } = useWorkspace({ nodes, setNodes, restoreItem, hydrateTodos })

  // The feed's subscription outlives renders; it reads canvas state through
  // this ref instead of re-subscribing every time a node moves.
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  const titleFor = useCallback((cardId: string) => {
    const n = nodesRef.current.find((x) => x.id === cardId)
    const folder = n && n.type === 'card' ? n.data.folder : undefined
    return folder?.split('/').filter(Boolean).pop() ?? 'agent'
  }, [])

  const { notifications, setNotifications } = useActivityFeed(titleFor)

  const flyTo = useCallback(
    (cardId: string) => {
      const node = nodesRef.current.find((x) => x.id === cardId)
      if (!node) return // card closed since the row was written
      const r = nodeRect(node)
      void fitBounds({ x: r.x, y: r.y, width: r.w, height: r.h }, { duration: 600, padding: 0.12 })
    },
    [fitBounds],
  )

  /** Activity row click → fly to the card that spoke (the row's whole point). */
  const flyToCard = useCallback(
    (n: Notification) => flyTo((n as ActivityNotification).cardId),
    [flyTo],
  )

  /** Toast context: who's asking, and what they're in the middle of. */
  const askContextFor = useCallback((cardId: string) => {
    const n = nodesRef.current.find((x) => x.id === cardId)
    if (!n || n.type !== 'card') return { name: 'agent' }
    return {
      name: n.data.folder.split('/').filter(Boolean).pop() ?? 'agent',
      task: n.data.meta.task ?? n.data.meta.detail,
    }
  }, [])

  /** Toast body click: release the ask (the dialog falls through to the
   *  card's terminal) and fly there to answer it natively. */
  const flyToAsk = useCallback(
    (ask: PermissionAskInfo) => {
      decide(ask.askId, 'release')
      flyTo(ask.cardId)
    },
    [decide, flyTo],
  )

  /** Spawn point centered in the current view, cascading down-right while
   *  another item already sits exactly there so repeat spawns stay distinct. */
  const spawnPosition = useCallback(
    (w: number, h: number, ns: CanvasNode[]) => {
      const c = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      const pos = { x: c.x - w / 2, y: c.y - h / 2 }
      const taken = () =>
        ns.some((n) => Math.abs(n.position.x - pos.x) < 1 && Math.abs(n.position.y - pos.y) < 1)
      while (taken()) {
        pos.x += CARD_GAP
        pos.y += CARD_GAP
      }
      return pos
    },
    [screenToFlowPosition],
  )

  async function addCard(kind: CardKind): Promise<void> {
    const r = await (kind === 'shell' ? window.canvas.newShell() : window.canvas.newCard())
    if (!r) return
    setNodes((ns) => [
      ...ns,
      makeCard(r.cardId, r.folder, spawnPosition(CARD_W, CARD_H, ns), undefined, kind),
    ])
  }

  async function addDiff(): Promise<void> {
    const r = await window.canvas.newDiff()
    if (!r) return
    setNodes((ns) => [...ns, makeDiff(r.diffId, r.folder, spawnPosition(DIFF_W, DIFF_H, ns))])
  }

  /** The draw gesture committed (screen coords) — convert to document space
   *  and birth the frame behind whatever it encloses. */
  const finishFrameDraw = useCallback(
    (rect: Rect | null) => {
      setDrawingFrame(false)
      if (!rect) return
      const { x: vx, y: vy, zoom } = getViewport()
      const doc = {
        x: (rect.x - vx) / zoom,
        y: (rect.y - vy) / zoom,
        w: rect.w / zoom,
        h: rect.h / zoom,
      }
      const frameId = `frame-${Date.now().toString(36)}`
      setNodes((ns) => {
        const count = ns.filter((n) => n.type === 'frame').length
        return [
          ...ns,
          makeFrame(frameId, `Frame ${count + 1}`, { x: doc.x, y: doc.y }, { w: doc.w, h: doc.h }),
        ]
      })
    },
    [getViewport, makeFrame, setNodes],
  )

  // Esc disarms the frame tool.
  useEffect(() => {
    if (!drawingFrame) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawingFrame(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawingFrame])

  // Light up frames while an item is dragged over them — the "drop here to
  // join" cue. Membership itself is geometric, so the drop needs no handling.
  const highlightFrames = useCallback(
    (dragged: CanvasNode | null) => {
      setNodes((ns) =>
        ns.map((n) => {
          if (n.type !== 'frame') return n
          const over = !!dragged && frameMembers(n, dragged ? [dragged] : []).length > 0
          return n.data.highlighted === over ? n : { ...n, data: { ...n.data, highlighted: over } }
        }),
      )
    },
    [setNodes],
  )

  const renameFrame = useCallback(
    (frameId: string, name: string) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.type === 'frame' && n.id === frameId ? { ...n, data: { ...n.data, name } } : n,
        ),
      )
    },
    [setNodes],
  )

  const deleteFrame = useCallback(
    (frameId: string) => setNodes((ns) => ns.filter((n) => n.id !== frameId)),
    [setNodes],
  )

  /** Double-click fits the camera to what's under the pointer — same move as
   *  clicking a frame's chip. Cards/diffs fit from their chrome only (drag
   *  header or far-zoom poster face): the terminal owns double-click for word
   *  selection, and buttons/overlays keep their own behavior. Frames are
   *  pointer-transparent, so the pane catches the event and we hit-test by
   *  geometry. Capture phase, because stopping propagation here is what keeps
   *  d3's double-click zoom from also firing. Empty canvas (no frame under
   *  the pointer) fits everything — the zoomed-out overview. */
  const onDoubleClickCapture = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      const fitTo = (n: CanvasNode) => {
        e.stopPropagation()
        const r = nodeRect(n)
        void fitBounds(
          { x: r.x, y: r.y, width: r.w, height: r.h },
          { duration: 600, padding: 0.12 },
        )
      }

      const nodeEl = target.closest<HTMLElement>('.react-flow__node')
      if (nodeEl) {
        if (target.closest('button') || !target.closest('.card-drag, .poster-face')) return
        const node = nodes.find((n) => n.id === nodeEl.dataset.id)
        if (node) fitTo(node)
        return
      }

      if (!target.closest('.react-flow__pane')) return
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const hit = nodes
        .filter((n) => n.type === 'frame')
        .map((n) => ({ n, r: nodeRect(n) }))
        .filter(({ r }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h)
        .sort((a, b) => a.r.w * a.r.h - b.r.w * b.r.h)[0] // overlapping frames: most specific wins
      if (hit) {
        fitTo(hit.n)
        return
      }

      // Truly empty canvas → fit everything (replaces d3's double-click zoom).
      if (nodes.length === 0) return
      e.stopPropagation()
      void fitView({ duration: 600, padding: 0.12 })
    },
    [nodes, screenToFlowPosition, fitBounds, fitView],
  )

  return (
    <div className="relative h-screen w-screen" onDoubleClickCapture={onDoubleClickCapture}>
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        minZoom={0.08}
        maxZoom={1.25}
        proOptions={{ hideAttribution: true }}
        onMoveEnd={persist}
        onNodeDrag={(_e, node) => {
          if (node.type !== 'frame') highlightFrames(node as CanvasNode)
        }}
        onNodeDragStop={() => highlightFrames(null)}
      >
        <Background variant={BackgroundVariant.Dots} color="var(--border)" gap={32} />
      </ReactFlow>

      <FrameChips
        nodes={nodes}
        setNodes={setNodes}
        onRename={renameFrame}
        onDelete={deleteFrame}
      />

      {drawingFrame && <FrameDrawOverlay onCommit={finishFrameDraw} />}

      {/* With titleBarStyle: hiddenInset there is no title bar — this strip is
          how the window gets dragged. The toolbar below is no-drag, so its
          buttons carve themselves out of the region. */}
      <div
        className="fixed inset-x-0 top-0 z-20 h-12"
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      />

      <div
        className="fixed left-3 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-2xl border border-border/40 bg-background/55 p-1.5 shadow-lg shadow-black/10 backdrop-blur-xl"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="New agent"
                onClick={() => void addCard('agent')}
              >
                <Bot />
              </Button>
            }
          />
          <TooltipContent side="right">New agent</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="New terminal"
                onClick={() => void addCard('shell')}
              >
                <SquareTerminal />
              </Button>
            }
          />
          <TooltipContent side="right">New terminal</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="New diff"
                onClick={() => void addDiff()}
              >
                <GitCompareArrows />
              </Button>
            }
          />
          <TooltipContent side="right">New diff</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={drawingFrame ? 'default' : 'ghost'}
                size="icon"
                aria-label="New frame"
                onClick={() => setDrawingFrame((v) => !v)}
              >
                <SquareDashed />
              </Button>
            }
          />
          <TooltipContent side="right">New frame</TooltipContent>
        </Tooltip>
      </div>

      {/* Activity center: the spine's feed-worthy rows under a bell. Sits in
          the drag strip, so it carves itself out of the region. */}
      <div
        className="fixed right-3 top-3 z-30"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <NotificationPopover
          notifications={notifications}
          onNotificationsChange={(ns) => setNotifications(ns as ActivityNotification[])}
          onNotificationClick={flyToCard}
        />
      </div>

      <AskToasts asks={asks} contextFor={askContextFor} onDecide={decide} onBodyClick={flyToAsk} />

      {(drawingFrame || nodes.length === 0) && (
        <div className="pointer-events-none fixed inset-x-0 top-4 z-30 flex justify-center">
          <span className="rounded-full border border-border/40 bg-background/55 px-3 py-1 font-mono text-xs text-muted-foreground backdrop-blur-xl">
            {drawingFrame
              ? 'drag to draw — esc to cancel'
              : 'pick a folder — a real `claude` spawns in a tmux session'}
          </span>
        </div>
      )}
    </div>
  )
}
