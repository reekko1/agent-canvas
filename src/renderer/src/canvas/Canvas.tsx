import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { Bot, Smartphone, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIcon } from '@/lib/icon-context'
import { basenameOf } from '@/lib/utils'
import { NotificationPopover } from '@/components/ui/notification-popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AskToasts } from '@/cards/AskToasts'
import { QuestionToasts } from '@/cards/QuestionToasts'
import { UpdateToast } from '@/cards/UpdateToast'
import { CardNode } from '@/cards/CardNode'
import { DiffNode } from '@/diff/DiffNode'
import { RemoteAccessDialog } from '@/remote/RemoteAccessDialog'
import type { CardKind, CardRecord, PermissionAskInfo, QuestionAskInfo } from '@shared/types'
import {
  PAD,
  TOP_STRIP,
  masterRect,
  stackContentHeight,
  stackSlot,
  stackWidth,
  type Rect,
} from './layout'
import type { CanvasNode } from './nodes'
import { CardContextMenu } from './CardContextMenu'
import { ProjectToolbar } from './ProjectToolbar'
import { useActivityFeed, type ActivityNotification } from './useActivityFeed'
import { useAutoUpdate } from './useAutoUpdate'
import { useCardMeta } from './useCardMeta'
import { usePendingAsks } from './usePendingAsks'
import { usePendingQuestions } from './usePendingQuestions'
import { useProjects } from './useProjects'
import { useProjectAttention } from './useProjectAttention'
import { useCanvasGit } from './useCanvasGit'
import { useShellTitles } from './useShellTitles'
import { useRemotePublish } from './useRemotePublish'
import { useWorkspace } from './useWorkspace'
import { VideoBackdrop } from './VideoBackdrop'

/** Off-screen parking rect for cards in inactive projects — kept mounted and
 *  sized (so xterm/FitAddon stay valid) but `visibility:hidden`. */
const PARKED: Rect = { x: -100000, y: 0, w: 800, h: 560 }

/** Window size, tracked so the layout re-flows on resize. */
function useWindowSize(): { w: number; h: number } {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const on = (): void => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return size
}

/// The canvas: a fixed-viewport master-stack of agent cards, one project (a
/// named canvas, pinned to a dir) shown at a time. Every card across every
/// project stays mounted in one flat layer — switching projects only flips
/// which are visible and how they're positioned — so a card keeps its xterm and
/// scrollback alive through project switches and master↔stack promotion. Cards
/// are born into a canvas and don't move between them. The diff is a built-in
/// right-edge drawer watching the active canvas's dir.
export function Canvas() {
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  // The diff drawer is built into every canvas that has a dir — it watches that
  // folder, re-points on canvas switch, and starts collapsed behind an edge tab.
  const [diffCollapsed, setDiffCollapsed] = useState(true)
  const [stackScroll, setStackScroll] = useState(0)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ cardId: string; x: number; y: number } | null>(
    null,
  )
  const { w: winW, h: winH } = useWindowSize()
  const PlusIcon = useIcon('plus')

  const makeProjectId = useCallback(
    () => `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    [],
  )
  const proj = useProjects(makeProjectId)

  const { hydrateTodos } = useCardMeta(setNodes)
  const { asks, decide, releaseCard } = usePendingAsks()
  const {
    questions,
    answer: answerQuestion,
    decline: declineQuestion,
    releaseCard: releaseQuestionCard,
  } = usePendingQuestions()
  const { update, dismiss: dismissUpdate, restart: restartForUpdate } = useAutoUpdate()

  /** Engaging a card's terminal releases everything it holds — both permission
   *  asks and questions fall through to the CLI's own dialogs. */
  const engageCard = useCallback(
    (cardId: string) => {
      releaseCard(cardId)
      releaseQuestionCard(cardId)
    },
    [releaseCard, releaseQuestionCard],
  )

  /** Bring a card to the master slot (switching to its project if needed). The
   *  diff sheet is an independent overlay, so it stays put. */
  const promoteCard = useCallback(
    (cardId: string) => {
      setStackScroll(0)
      proj.promote(cardId)
    },
    [proj.promote],
  )

  const onCloseCard = useCallback(
    (cardId: string) => {
      void window.canvas.killCard(cardId)
      setNodes((ns) => ns.filter((n) => n.id !== cardId))
      proj.detachCard(cardId)
    },
    [proj.detachCard],
  )

  // Deleting a canvas closes every card on it — kill the sessions, drop the
  // nodes, then remove the project.
  const deleteProject = useCallback(
    (id: string) => {
      const ids = proj.projects.find((p) => p.id === id)?.cardIds ?? []
      ids.forEach((cardId) => void window.canvas.killCard(cardId))
      setNodes((ns) => ns.filter((n) => !ids.includes(n.id)))
      proj.deleteProject(id)
    },
    [proj.projects, proj.deleteProject],
  )

  const makeCard = useCallback(
    (cardId: string, folder: string, kind: CardKind): CanvasNode => ({
      id: cardId,
      type: 'card',
      data: {
        folder,
        kind,
        meta: { status: 'idle', statusSince: Date.now() },
        onClose: onCloseCard,
        onEngage: engageCard,
        onPromote: promoteCard,
      },
    }),
    [onCloseCard, engageCard, promoteCard],
  )

  const restoreItem = useCallback(
    (c: CardRecord): CanvasNode | null => (c.folder ? makeCard(c.id, c.folder, c.kind) : null),
    [makeCard],
  )

  useWorkspace({
    nodes,
    setNodes,
    restoreItem,
    hydrateTodos,
    projects: proj.projects,
    activeProjectId: proj.activeProjectId,
    onRestore: proj.restore,
  })

  // The feed's subscription outlives renders; it reads canvas state through
  // this ref instead of re-subscribing every time the node list changes.
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  const titleFor = useCallback((cardId: string) => {
    const n = nodesRef.current.find((x) => x.id === cardId)
    const folder = n && n.type === 'card' ? n.data.folder : undefined
    return basenameOf(folder ?? '') ?? 'agent'
  }, [])

  const { notifications, setNotifications } = useActivityFeed(titleFor, proj.projectNameForCard)

  // Per-canvas attention, rolled up from card meta + held asks/questions —
  // drives the toolbar dots.
  const attention = useProjectAttention({ projects: proj.projects, nodes, asks, questions })
  // Per-canvas git identity (branch + dirty) for the toolbar.
  const git = useCanvasGit(proj.projects)
  // Shell cards' live title bits (command + cwd) for the phone's list rows.
  const shellTitles = useShellTitles(nodes)

  // Mirror canvases + cards + asks/questions + feed to the phone panel.
  useRemotePublish({
    nodes,
    projects: proj.projects,
    attention,
    git,
    shellTitles,
    asks,
    questions,
    notifications,
    titleFor,
  })

  /** Toast context: who's asking, their canvas, and what they're mid-way on. */
  const askContextFor = useCallback(
    (cardId: string) => {
      const n = nodesRef.current.find((x) => x.id === cardId)
      if (!n || n.type !== 'card') return { name: 'agent' }
      return {
        name: basenameOf(n.data.folder) ?? 'agent',
        project: proj.projectNameForCard(cardId),
        task: n.data.meta.task ?? n.data.meta.detail,
      }
    },
    [proj.projectNameForCard],
  )

  /** Activity / ask / question click → promote that card to the main view
   *  (switching canvas if it lives in another one). */
  const flyToCard = useCallback(
    (n: ActivityNotification) => promoteCard(n.cardId),
    [promoteCard],
  )
  const flyToAsk = useCallback(
    (ask: PermissionAskInfo) => {
      decide(ask.askId, 'release')
      promoteCard(ask.cardId)
    },
    [decide, promoteCard],
  )
  const flyToQuestion = useCallback(
    (ask: QuestionAskInfo) => {
      releaseQuestionCard(ask.cardId)
      promoteCard(ask.cardId)
    },
    [releaseQuestionCard, promoteCard],
  )

  async function addCard(kind: CardKind): Promise<void> {
    // Cards spawn in the active canvas's dir — no canvas, nothing to add.
    const dir = proj.active?.dir
    if (!dir) return
    const r = await (kind === 'shell' ? window.canvas.newShell(dir) : window.canvas.newCard(dir))
    if (!r) return
    setNodes((ns) => [...ns, makeCard(r.cardId, r.folder, kind)])
    proj.attachCard(r.cardId) // joins the active canvas as its master
  }

  const createProject = useCallback(async () => {
    const dir = await window.canvas.pickFolder('Choose the folder for this canvas')
    if (!dir) return // cancelled — don't create a dirless project
    const name = basenameOf(dir) || 'Canvas'
    proj.createProject(name, dir)
  }, [proj.createProject])

  const switchProject = useCallback(
    (id: string) => {
      setStackScroll(0)
      proj.switchProject(id)
    },
    [proj.switchProject],
  )

  // ---- Master-stack layout (active project only; others stay parked) ----
  const active = proj.active
  // Partition the cards once per change to the node set / active order / focus —
  // not on every render (window resize, scroll, toast churn). rectFor then does
  // O(1) stack lookups via stackIndex.
  const { activeSet, cardNodes, orderedActive, masterCard, stackCards, stackIndex } = useMemo(() => {
    const activeSet = new Set(active?.cardIds ?? [])
    const cardNodes = nodes.flatMap((n) => (n.type === 'card' ? [n] : []))
    const orderedActive = (active?.cardIds ?? []).flatMap((id) => {
      const n = cardNodes.find((x) => x.id === id)
      return n ? [n] : []
    })
    const masterCard =
      orderedActive.find((n) => n.id === active?.focusedCardId) ?? orderedActive[0] ?? null
    const stackCards = orderedActive.filter((n) => n.id !== masterCard?.id)
    const stackIndex = new Map(stackCards.map((n, i) => [n.id, i] as const))
    return { activeSet, cardNodes, orderedActive, masterCard, stackCards, stackIndex }
  }, [nodes, active?.cardIds, active?.focusedCardId])
  const hasStack = stackCards.length > 0
  const mRect = masterRect(winW, winH, hasStack)
  // The diff side sheet overlays the right half — independent of the layout.
  const sheetW = Math.min(900, Math.max(520, Math.round(winW * 0.5)))
  // The active canvas's repo — the diff drawer watches it. Keyed by project id
  // so switching canvases re-points the watcher. Null when there's no canvas.
  const activeDir = active?.dir

  const maxScroll = Math.max(0, stackContentHeight(stackCards.length) - (winH - TOP_STRIP - PAD))
  const scroll = Math.min(stackScroll, maxScroll)

  const rectFor = (cardId: string): Rect => {
    if (cardId === masterCard?.id) return mRect
    const i = stackIndex.get(cardId)
    if (i === undefined) return PARKED
    const s = stackSlot(winW, i)
    return { ...s, y: s.y - scroll }
  }

  const onStackWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (!hasStack || maxScroll <= 0) return
      // The diff sheet overlays the stack column — don't scroll the hidden
      // stack behind it when the wheel is over the sheet.
      if (!diffCollapsed && (e.target as HTMLElement).closest('[data-diff-sheet]')) return
      if (e.clientX < winW - stackWidth(winW) - PAD) return // not over the stack column
      setStackScroll((s) => Math.max(0, Math.min(maxScroll, s + e.deltaY)))
    },
    [hasStack, maxScroll, winW, diffCollapsed],
  )

  return (
    <div className="relative h-screen w-screen overflow-hidden" onWheel={onStackWheel}>
      <VideoBackdrop />

      {/* One stable layer of every card across every project. The active
          project's cards take the master/stack slots; the rest stay mounted but
          parked off-screen and hidden — so no card's xterm ever unmounts. */}
      {cardNodes.map((n) => {
        const inActive = activeSet.has(n.id)
        const isMaster = inActive && masterCard?.id === n.id
        const r = inActive ? rectFor(n.id) : PARKED
        return (
          <div
            key={n.id}
            className="absolute left-0 top-0"
            onContextMenu={
              inActive
                ? (e) => {
                    e.preventDefault()
                    setContextMenu({ cardId: n.id, x: e.clientX, y: e.clientY })
                  }
                : undefined
            }
            style={{
              transform: `translate(${r.x}px, ${r.y}px)`,
              width: r.w,
              height: r.h,
              transition:
                proj.animate && inActive
                  ? 'transform .25s ease, width .25s ease, height .25s ease'
                  : 'none',
              visibility: inActive ? 'visible' : 'hidden',
              zIndex: isMaster ? 10 : 1,
            }}
          >
            <CardNode id={n.id} data={n.data} stacked={!isMaster} title={shellTitles[n.id]} />
          </div>
        )
      })}

      {/* Diff side sheet: a right-edge drawer that slides over the canvas
          without displacing the master-stack. Collapsing parks it off-screen
          but keeps DiffNode mounted (watcher + selection survive), with an edge
          tab to bring it back; closing tears it down. */}
      {activeDir && (
        <>
          <div
            data-diff-sheet
            className="fixed overflow-hidden rounded-2xl"
            style={{
              top: TOP_STRIP,
              bottom: PAD,
              right: PAD,
              width: sheetW,
              zIndex: 35,
              transform: diffCollapsed ? 'translateX(calc(100% + 24px))' : 'translateX(0)',
              transition: 'transform .3s ease',
            }}
          >
            <DiffNode
              id={`diff-${proj.activeProjectId}`}
              data={{ folder: activeDir, onCollapse: () => setDiffCollapsed(true) }}
            />
          </div>
          {diffCollapsed && (
            <button
              className="fixed right-0 top-1/2 -translate-y-1/2 rounded-l-xl border border-r-0 border-border/40 bg-background/80 px-2 py-3 font-mono text-xs text-muted-foreground shadow-lg backdrop-blur-xl hover:text-foreground"
              style={{ zIndex: 36, writingMode: 'vertical-rl' } as CSSProperties}
              onClick={() => setDiffCollapsed(false)}
              title="Show diff"
            >
              diff
            </button>
          )}
        </>
      )}

      {/* With titleBarStyle: hiddenInset there is no title bar — this strip is
          how the window gets dragged. The toolbars below are no-drag. */}
      <div
        className="fixed inset-x-0 top-0 z-30 h-12"
        style={{ WebkitAppRegion: 'drag' }}
      />

      <ProjectToolbar
        projects={proj.projects}
        activeProjectId={proj.activeProjectId}
        attention={attention}
        git={git}
        onSwitch={switchProject}
        onCreate={createProject}
        onRename={proj.renameProject}
        onDelete={deleteProject}
      />

      <div
        className="fixed left-3 top-1/2 z-40 flex -translate-y-1/2 flex-col gap-1 rounded-full border border-border/40 bg-background/55 p-1.5 shadow-lg shadow-black/10 backdrop-blur-xl"
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="New agent"
                disabled={!active}
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
                disabled={!active}
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
                aria-label="Remote access"
                onClick={() => setRemoteOpen(true)}
              >
                <Smartphone />
              </Button>
            }
          />
          <TooltipContent side="right">Remote access</TooltipContent>
        </Tooltip>
      </div>

      <RemoteAccessDialog open={remoteOpen} onClose={() => setRemoteOpen(false)} />

      {/* Activity center: the spine's feed-worthy rows under a bell. */}
      <div
        className="fixed right-3 top-3 z-40"
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        <NotificationPopover<ActivityNotification>
          notifications={notifications}
          onNotificationsChange={(ns) => setNotifications(ns)}
          onNotificationClick={flyToCard}
        />
      </div>

      {contextMenu && (
        <CardContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          cardId={contextMenu.cardId}
          onClose={onCloseCard}
          onDismiss={() => setContextMenu(null)}
        />
      )}

      {/* Shared bottom overlay: questions ride above permission asks. Always
          mounted so AnimatePresence can play exit animations on the last item. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex flex-col items-center gap-2">
        <QuestionToasts
          questions={questions}
          contextFor={askContextFor}
          onAnswer={answerQuestion}
          onDecline={declineQuestion}
          onBodyClick={flyToQuestion}
        />
        <AskToasts asks={asks} contextFor={askContextFor} onDecide={decide} onBodyClick={flyToAsk} />
      </div>

      <UpdateToast update={update} onRestart={restartForUpdate} onDismiss={dismissUpdate} />

      {!active ? (
        <div className="fixed inset-0 z-30 flex flex-col items-center justify-center gap-4">
          <div className="text-center">
            <p className="font-mono text-sm text-foreground/80">No canvas yet</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              A canvas is a folder — every agent and terminal on it spawns there.
            </p>
          </div>
          <Button leadingIcon={PlusIcon} onClick={() => void createProject()}>
            New canvas
          </Button>
        </div>
      ) : (
        orderedActive.length === 0 && (
          <div className="pointer-events-none fixed inset-x-0 top-16 z-30 flex justify-center">
            <span className="rounded-full border border-border/40 bg-background/55 px-3 py-1 font-mono text-xs text-muted-foreground backdrop-blur-xl">
              empty canvas — add an agent or terminal, it spawns in{' '}
              {basenameOf(active.dir)}
            </span>
          </div>
        )
      )}
    </div>
  )
}
