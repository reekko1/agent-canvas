import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useIcon } from '@/lib/icon-context'
import { basenameOf } from '@/lib/utils'
import { NotificationPopover } from '@/components/ui/notification-popover'
import { AskToasts } from '@/cards/AskToasts'
import { QuestionToasts } from '@/cards/QuestionToasts'
import { UpdateToast } from '@/cards/UpdateToast'
import { OrchestratorChatBar } from '@/orchestrator/ChatBar'
import { OrchestratorTracers } from '@/orchestrator/Tracer'
import { RemoteAccessDialog } from '@/remote/RemoteAccessDialog'
import type { BrowserNavPatch } from '@/cards/meta'
import type {
  CardKind,
  CardRecord,
  PermissionAskInfo,
  QuestionAskInfo,
} from '@shared/types'
import type { CanvasNode } from './nodes'
import { ActionRail } from './ActionRail'
import { CardLayer } from './CardLayer'
import { CardContextMenu } from './CardContextMenu'
import { DiffSheet } from './DiffSheet'
import { ProjectToolbar } from './ProjectToolbar'
import { RenameDialog } from './RenameDialog'
import { useActivityFeed, type ActivityNotification } from './useActivityFeed'
import { useAutoUpdate } from './useAutoUpdate'
import { useBrowserBudget } from './useBrowserBudget'
import { useCardMeta } from './useCardMeta'
import { useMasterStackLayout } from './useMasterStackLayout'
import { useOrchestratorCommands } from './useOrchestratorCommands'
import { usePendingAsks } from './usePendingAsks'
import { usePendingQuestions } from './usePendingQuestions'
import { useProjects } from './useProjects'
import { useProjectAttention } from './useProjectAttention'
import { useCanvasGit } from './useCanvasGit'
import { useShellTitles } from './useShellTitles'
import { useRemotePublish } from './useRemotePublish'
import { useTracers } from './useTracers'
import { useWorkspace } from './useWorkspace'
import { VideoBackdrop } from './VideoBackdrop'

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
///
/// This is the composition root: it owns the node registry and the small glue
/// (card lifecycle, project plumbing) and wires the focused hooks that carry the
/// real weight — `useMasterStackLayout` (geometry), `useBrowserBudget` (webview
/// eviction), `useTracers` (action comets), and `useOrchestratorCommands` (the
/// main↔renderer command bus). UI chunks live in their own components.
export function Canvas() {
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  // The once-subscribed listeners read canvas state through this ref instead of
  // re-subscribing every time the node list changes.
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  // The diff drawer is built into every canvas that has a dir — it watches that
  // folder, re-points on canvas switch, and starts collapsed behind an edge tab.
  const [diffCollapsed, setDiffCollapsed] = useState(true)
  const [stackScroll, setStackScroll] = useState(0)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ cardId: string; x: number; y: number } | null>(
    null,
  )
  // Rename dialog (Electron has no window.prompt — we render our own input).
  const [renaming, setRenaming] = useState<{ cardId: string; value: string } | null>(null)
  // The orchestrator is speaking aloud — drives the voice-reactive edge glow.
  const [speaking, setSpeaking] = useState(false)
  // Cards spawned by the orchestrator but not yet revealed — held invisible until
  // the delivering comet lands, so a new agent materializes on impact.
  const [pendingReveal, setPendingReveal] = useState<Set<string>>(() => new Set())
  const reveal = (cardId: string): void =>
    setPendingReveal((s) => {
      if (!s.has(cardId)) return s
      const next = new Set(s)
      next.delete(cardId)
      return next
    })

  const { w: winW, h: winH } = useWindowSize()
  const PlusIcon = useIcon('plus')

  // Browser webview budget: recency-ranked eviction of guests past the cap, plus
  // the kind-aware browser predicate and the per-browser scan pulse.
  const { bumpBrowser, isBrowserCard, scanPulse, selectDormant } = useBrowserBudget(nodesRef)

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
      bumpBrowser(cardId) // a promoted browser is most-recently-used → stays live
    },
    [proj.promote, bumpBrowser],
  )

  const onCloseCard = useCallback(
    (cardId: string) => {
      // Lifecycle coupling: an agent's requested browser closes with it. Find the
      // browsers this card owns (request_browser link) and take them along.
      const owned = nodesRef.current
        .filter(
          (n) => n.type === 'card' && n.data.kind === 'browser' && n.data.ownerCardId === cardId,
        )
        .map((n) => n.id)
      const closing = [cardId, ...owned]
      // Browser cards have no tmux/pty session — there's nothing to kill, and
      // killing would log a missing-session error. Skip them by their kind.
      closing.forEach((id) => {
        if (!isBrowserCard(id)) void window.canvas.killCard(id)
      })
      setNodes((ns) => ns.filter((n) => !closing.includes(n.id)))
      closing.forEach((id) => proj.detachCard(id))
    },
    [proj.detachCard, isBrowserCard],
  )

  /** A browser card's webview reported new state (navigation, title, favicon, or
   *  a fresh blur snapshot) — fold it into the node so the chrome/face track it
   *  and persistence captures the url. Stable: the webview captures it at mount. */
  const navigateCard = useCallback(
    (cardId: string, patch: BrowserNavPatch) => {
      setNodes((ns) =>
        ns.map((n) => (n.id === cardId && n.type === 'card' ? { ...n, data: { ...n.data, ...patch } } : n)),
      )
    },
    [],
  )

  // Deleting a canvas closes every card on it — kill the sessions, drop the
  // nodes, then remove the project.
  const deleteProject = useCallback(
    (id: string) => {
      const ids = proj.projects.find((p) => p.id === id)?.cardIds ?? []
      // Browser cards have no session to kill (see onCloseCard).
      ids.forEach((cardId) => {
        if (!isBrowserCard(cardId)) void window.canvas.killCard(cardId)
      })
      setNodes((ns) => ns.filter((n) => !ids.includes(n.id)))
      proj.deleteProject(id)
    },
    [proj.projects, proj.deleteProject, isBrowserCard],
  )

  const makeCard = useCallback(
    (cardId: string, folder: string, kind: CardKind, name?: string, url?: string): CanvasNode => ({
      id: cardId,
      type: 'card',
      data: {
        folder,
        kind,
        name,
        url,
        meta: { status: 'idle', statusSince: Date.now() },
        onClose: onCloseCard,
        onEngage: engageCard,
        onPromote: promoteCard,
        onNavigate: navigateCard,
      },
    }),
    [onCloseCard, engageCard, promoteCard, navigateCard],
  )

  const restoreItem = useCallback(
    (c: CardRecord): CanvasNode | null => {
      if (!c.folder) return null
      const node = makeCard(c.id, c.folder, c.kind, c.name, c.url)
      // Restore a browser's ownership link + reason so request_browser resolves
      // the same browser after a restart (agents reattach to live tmux sessions).
      node.data.ownerCardId = c.ownerCardId
      node.data.reason = c.reason
      return node
    },
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

  const titleFor = useCallback((cardId: string) => {
    const n = nodesRef.current.find((x) => x.id === cardId)
    if (!n || n.type !== 'card') return 'agent'
    return n.data.name ?? basenameOf(n.data.folder ?? '') ?? 'agent'
  }, [])

  // Default name for a new agent: the next free "Agent N" across all cards.
  const nextAgentName = useCallback((): string => {
    let max = 0
    for (const n of nodesRef.current) {
      if (n.type !== 'card') continue
      const m = /^Agent (\d+)$/.exec(n.data.name ?? '')
      if (m) max = Math.max(max, Number(m[1]))
    }
    return `Agent ${max + 1}`
  }, [])

  /** Set a card's display name. Returns false if the card or name is invalid. */
  const renameCard = useCallback((cardId: string, name: string): boolean => {
    const clean = name.trim()
    if (!clean || !nodesRef.current.some((n) => n.id === cardId && n.type === 'card')) return false
    setNodes((ns) =>
      ns.map((n) =>
        n.id === cardId && n.type === 'card' ? { ...n, data: { ...n.data, name: clean } } : n,
      ),
    )
    return true
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
    activeProjectId: proj.activeProjectId,
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
  const flyToCard = useCallback((n: ActivityNotification) => promoteCard(n.cardId), [promoteCard])
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
    const r = await (kind === 'shell'
      ? window.canvas.newShell(dir)
      : kind === 'browser'
        ? window.canvas.newBrowser(dir)
        : window.canvas.newCard(dir))
    if (!r) return
    // Agents get an "Agent N" name; a browser opens a blank start page (the
    // address bar takes it from there); shells follow their pane folder.
    const name = kind === 'agent' ? nextAgentName() : undefined
    setNodes((ns) => [...ns, makeCard(r.cardId, r.folder, kind, name)])
    proj.attachCard(r.cardId) // joins the active canvas as its master
  }

  const createProject = useCallback(async () => {
    const dir = await window.canvas.pickFolder('Choose the folder for this canvas')
    if (!dir) return // cancelled — don't create a dirless project
    const name = basenameOf(dir) || 'Canvas'
    proj.createProject(name, dir)
  }, [proj.createProject])

  // ---- Master-stack layout (active project only; others stay parked) ----
  const {
    activeSet,
    cardNodes,
    orderedActive,
    masterCard,
    sheetW,
    rectFor,
    rectForRef,
    leavingLayout,
    beginLeave,
    onStackWheel,
  } = useMasterStackLayout({
    nodes,
    active: proj.active,
    switching: proj.switching,
    projects: proj.projects,
    winW,
    winH,
    stackScroll,
    setStackScroll,
    diffCollapsed,
  })

  const switchProject = useCallback(
    (id: string) => {
      beginLeave() // snapshot the leaving board's scroll before resetting
      setStackScroll(0)
      proj.switchProject(id)
    },
    [proj.switchProject, beginLeave],
  )

  // The webview budget: keep the most-recent browser guests live, evict the rest
  // — recomputed only when the card set or master changes.
  const dormantBrowsers = useMemo(
    () => selectDormant(cardNodes, masterCard?.id),
    [selectDormant, cardNodes, masterCard?.id],
  )

  // Ownership links for the UI: an agent → the browser it owns (its poster
  // thumbnail). First owner wins. (Browser → owner name is resolved in CardLayer.)
  const ownedBrowserByAgent = useMemo(() => {
    const m = new Map<string, CanvasNode>()
    for (const n of cardNodes) {
      const owner = n.data.kind === 'browser' ? n.data.ownerCardId : undefined
      if (owner && !m.has(owner)) m.set(owner, n)
    }
    return m
  }, [cardNodes])

  const active = proj.active
  // The active canvas's repo — the diff drawer watches it. Null when no canvas.
  const activeDir = active?.dir

  // Live tracers fired when the orchestrator acts on an agent (chat bar → card).
  const { tracers, clearTracer } = useTracers({ winW, winH, cardNodes, asks, reveal, rectForRef })

  // The renderer end of the orchestrator command bus (spawn / navigate / drive /
  // rename / kill / gate-confirm) — runs commands against live project state.
  const { orchConfirm, resolveConfirm } = useOrchestratorCommands({
    proj,
    setNodes,
    nodesRef,
    makeCard,
    switchProject,
    promoteCard,
    nextAgentName,
    bumpBrowser,
    titleFor,
    renameCard,
    onCloseCard,
    reveal,
    setPendingReveal,
  })

  return (
    <div className="relative h-screen w-screen overflow-hidden" onWheel={onStackWheel}>
      <VideoBackdrop />

      {/* Voice glow: a cinematic cyan aura on the window edges while the
          orchestrator speaks. The on/off fade rides the `is-speaking` class; the
          inner aura's intensity tracks the live voice loudness (--voice-level). */}
      <div className={`voice-glow ${speaking ? 'is-speaking' : ''}`}>
        <div className="voice-glow__aura" />
      </div>

      {/* Tracers the orchestrator fires at an agent when it acts on one. */}
      <OrchestratorTracers tracers={tracers} onDone={clearTracer} />

      {/* One stable layer of every card across every project. */}
      <CardLayer
        cardNodes={cardNodes}
        activeSet={activeSet}
        masterCardId={masterCard?.id}
        leavingLayout={leavingLayout}
        switching={!!proj.switching}
        animate={proj.animate}
        pendingReveal={pendingReveal}
        rectFor={rectFor}
        dormantBrowsers={dormantBrowsers}
        ownedBrowserByAgent={ownedBrowserByAgent}
        scanPulse={scanPulse}
        shellTitles={shellTitles}
        titleFor={titleFor}
        promoteCard={promoteCard}
        onContextMenu={(cardId, x, y) => setContextMenu({ cardId, x, y })}
      />

      {/* Diff side sheet: a right-edge drawer that slides over the canvas. */}
      {activeDir && (
        <DiffSheet
          activeDir={activeDir}
          activeProjectId={proj.activeProjectId}
          sheetW={sheetW}
          collapsed={diffCollapsed}
          onCollapse={() => setDiffCollapsed(true)}
          onExpand={() => setDiffCollapsed(false)}
        />
      )}

      {/* With titleBarStyle: hiddenInset there is no title bar — this strip is
          how the window gets dragged. The toolbars below are no-drag. */}
      <div className="fixed inset-x-0 top-0 z-30 h-12" style={{ WebkitAppRegion: 'drag' }} />

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

      <ActionRail
        active={!!active}
        onAddCard={(kind) => void addCard(kind)}
        onRemote={() => setRemoteOpen(true)}
      />

      <RemoteAccessDialog open={remoteOpen} onClose={() => setRemoteOpen(false)} />

      {/* Activity center: the spine's feed-worthy rows under a bell. */}
      <div className="fixed right-3 top-3 z-40" style={{ WebkitAppRegion: 'no-drag' }}>
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
          onRename={(cardId) => {
            const n = nodesRef.current.find((x) => x.id === cardId)
            const current = (n?.type === 'card' ? n.data.name : '') ?? ''
            setRenaming({ cardId, value: current })
          }}
          onDismiss={() => setContextMenu(null)}
        />
      )}

      {renaming && (
        <RenameDialog
          value={renaming.value}
          onChange={(v) => setRenaming({ cardId: renaming.cardId, value: v })}
          onCancel={() => setRenaming(null)}
          onSubmit={() => {
            renameCard(renaming.cardId, renaming.value)
            setRenaming(null)
          }}
        />
      )}

      {/* Shared bottom-center column: questions and permission asks stack above
          the chat bar (never behind it). Always mounted so AnimatePresence can
          play exit animations on the last item. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex flex-col items-center gap-2">
        <QuestionToasts
          questions={questions}
          contextFor={askContextFor}
          onAnswer={answerQuestion}
          onDecline={declineQuestion}
          onBodyClick={flyToQuestion}
        />
        <AskToasts asks={asks} contextFor={askContextFor} onDecide={decide} onBodyClick={flyToAsk} />
        <OrchestratorChatBar
          confirm={orchConfirm}
          onConfirmDecide={resolveConfirm}
          onSpeakingChange={setSpeaking}
        />
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
