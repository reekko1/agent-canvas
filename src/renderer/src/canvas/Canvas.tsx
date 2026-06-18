import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { Bot, Globe, Smartphone, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIcon } from '@/lib/icon-context'
import { basenameOf } from '@/lib/utils'
import { NotificationPopover } from '@/components/ui/notification-popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AskToasts } from '@/cards/AskToasts'
import { QuestionToasts } from '@/cards/QuestionToasts'
import { UpdateToast } from '@/cards/UpdateToast'
import { CardNode } from '@/cards/CardNode'
import { getBrowser } from '@/cards/browserBridge'
import { OrchestratorChatBar } from '@/orchestrator/ChatBar'
import { OrchestratorTracers, TRACER_COLOR, type TracerSpec } from '@/orchestrator/Tracer'
import { TRACER_TRAVEL_MS } from '@shared/types'
import type { OrchestratorConfirm } from '@/orchestrator/OrchestratorConfirmToast'
import { DiffNode } from '@/diff/DiffNode'
import { RemoteAccessDialog } from '@/remote/RemoteAccessDialog'
import type {
  CardKind,
  CardRecord,
  OrchestratorCommand,
  OrchestratorCommandResult,
  OrchestratorTarget,
  PermissionAskInfo,
  QuestionAskInfo,
} from '@shared/types'
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

/** Distance from the window's bottom edge up to the chat-bar pill's center — the
 *  origin an action comet launches from. Must track the bar's `bottom-4` overlay
 *  inset (16px) plus the pill's half-height; keep in sync if the pill resizes. */
const CHAT_BAR_INSET = 44

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

/// How many browser <webview> guests stay live at once. The rest are evicted to
/// dormant (guest dropped, GL/process freed, snapshot face shown) and woken on
/// demand. Caps per-webview cost so a big fleet doesn't choke — kept well under
/// Chromium's ~16-WebGL-context ceiling, which browsers share with terminals.
const BROWSER_BUDGET = 6

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
  // Rename dialog (Electron has no window.prompt — we render our own input).
  const [renaming, setRenaming] = useState<{ cardId: string; value: string } | null>(null)
  // The orchestrator's pending permission gate (one at a time — the SDK awaits
  // canUseTool before the next tool, so confirms never overlap).
  const [orchConfirm, setOrchConfirm] = useState<OrchestratorConfirm | null>(null)
  // The orchestrator is speaking aloud — drives the voice-reactive edge glow.
  const [speaking, setSpeaking] = useState(false)
  // Live tracers fired when the orchestrator acts on an agent (chat bar → card).
  const [tracers, setTracers] = useState<TracerSpec[]>([])
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
  const tracerSeq = useRef(1)
  const rectForRef = useRef<(cardId: string) => Rect>(() => PARKED)
  const fireTargetRef = useRef<(t: OrchestratorTarget) => void>(() => {})
  const { w: winW, h: winH } = useWindowSize()
  const PlusIcon = useIcon('plus')

  // Browser webview budget: recency rank per browser (higher = more recent),
  // bumped on promote / spawn / wake. A monotonic counter (not a clock) gives
  // stable ordering; the lowest-ranked browsers past the budget go dormant.
  const [browserRecency, setBrowserRecency] = useState<Map<string, number>>(() => new Map())
  const recencyTick = useRef(0)
  // Keyed on the id prefix (not the node's `kind`) on purpose: this fires for a
  // freshly spawned browser before its node is in `nodesRef`, and from promote
  // where only the id is in hand. The recency map stays browser-only by skipping
  // non-`browser-` ids; the authoritative `kind` drives the session-aware paths.
  const bumpBrowser = useCallback((cardId: string) => {
    if (!cardId.startsWith('browser-')) return
    setBrowserRecency((prev) => new Map(prev).set(cardId, (recencyTick.current += 1)))
  }, [])

  /** A card is a browser by its authoritative `kind` — the discriminant the rest
   *  of the canvas keys on. Used for the session-less close path (a browser has no
   *  tmux/pty to kill, and killing one logs a missing-session error). */
  const isBrowserCard = useCallback(
    (id: string): boolean =>
      nodesRef.current.some((n) => n.id === id && n.type === 'card' && n.data.kind === 'browser'),
    [],
  )

  // Per-browser scan pulse: a nonce bumped each time a card's page is captured
  // (browser_screenshot), passed to CardNode to (re)play the one-shot scan sweep.
  const [scanPulse, setScanPulse] = useState<Map<string, number>>(() => new Map())
  const scanTick = useRef(0)

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
    (cardId: string, patch: { url?: string; title?: string; favicon?: string; snapshot?: string }) => {
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

  // The feed's subscription outlives renders; it reads canvas state through
  // this ref instead of re-subscribing every time the node list changes.
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

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

  // The live stack scroll, mirrored to a ref so the switch handler can snapshot
  // it the instant before resetting — the receding board fades from where it
  // actually sat, not from scroll 0.
  const scrollRef = useRef(0)
  const leaveScrollRef = useRef(0)

  const switchProject = useCallback(
    (id: string) => {
      leaveScrollRef.current = scrollRef.current
      setStackScroll(0)
      proj.switchProject(id)
    },
    [proj.switchProject],
  )

  // Turn a gated tool call into a plain-language gate: "Spawn an agent" / "on
  // web · fix the failing test", resolving canvas/card ids to their names.
  const describeConfirm = (
    toolName: string,
    input: Record<string, unknown>,
  ): { title: string; detail: string } => {
    const verb = toolName.replace(/^mcp__canvas__/, '')
    const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s)
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
    const canvasName = (id: unknown): string =>
      proj.projects.find((p) => p.id === String(id))?.name ?? String(id ?? '?')
    switch (verb) {
      case 'spawn_agent': {
        const where = input.canvasId ? canvasName(input.canvasId) : (proj.active?.name ?? 'the active canvas')
        const who = str(input.name)
        const task = str(input.prompt)
        return {
          title: who ? `Spawn “${who}”` : 'Spawn an agent',
          detail: `on ${where}${task ? ` · ${clip(task)}` : ''}`,
        }
      }
      case 'open_browser': {
        const where = input.canvasId ? canvasName(input.canvasId) : (proj.active?.name ?? 'the active canvas')
        const url = str(input.url)
        return { title: 'Open a browser', detail: `on ${where}${url ? ` · ${clip(url)}` : ''}` }
      }
      case 'navigate_browser':
        return { title: `Navigate ${titleFor(String(input.cardId))}`, detail: clip(str(input.url)) }
      case 'send_to_agent':
        return { title: `Message ${titleFor(String(input.cardId))}`, detail: clip(str(input.message)) }
      case 'rename_agent':
        return { title: 'Rename agent', detail: `${titleFor(String(input.cardId))} → ${str(input.name)}` }
      case 'kill_card':
        return { title: `Close ${titleFor(String(input.cardId))}`, detail: 'ends its session — cannot be undone' }
      case 'approve_ask': {
        const ask = asks.find((a) => a.askId === String(input.askId))
        const who = ask ? titleFor(ask.cardId) : 'agent'
        const action = str(input.decision) === 'deny' ? 'Deny' : 'Approve'
        return { title: `${action} ${who}’s request`, detail: ask?.detail ?? String(input.askId) }
      }
      case 'focus_canvas':
        return { title: 'Switch canvas', detail: `to ${canvasName(input.canvasId)}` }
      default:
        return { title: verb, detail: clip(JSON.stringify(input)) }
    }
  }

  // The orchestrator (main) dispatches canvas mutations and confirms here; we
  // run them against the live project state and reply by id. A ref holds the
  // latest closure so the IPC listener subscribes once, not every render.
  const orchCommandRef = useRef<(cmd: OrchestratorCommand) => void>(() => {})
  orchCommandRef.current = (cmd) => {
    const reply = (result: OrchestratorCommandResult): void =>
      window.canvas.orchestratorResult(cmd.id, result)

    if (cmd.cmd === 'confirm') {
      const { toolName, input } = cmd.payload
      // Surface the proposed action as an in-app gate toast; it replies by id.
      const { title, detail } = describeConfirm(toolName, input)
      setOrchConfirm({ id: cmd.id, title, detail })
      return
    }

    if (cmd.cmd === 'focusCanvas') {
      const { canvasId } = cmd.payload
      const target = proj.projects.find((p) => p.id === canvasId)
      if (!target) {
        reply({ ok: false, message: `no canvas with id ${canvasId}` })
        return
      }
      switchProject(canvasId)
      reply({ ok: true, message: `switched to ${target.name}` })
      return
    }

    if (cmd.cmd === 'spawnAgent') {
      const canvasId = cmd.payload.canvasId
      const target = canvasId ? proj.projects.find((p) => p.id === canvasId) : proj.active
      if (!target) {
        reply({ ok: false, message: canvasId ? `no canvas with id ${canvasId}` : 'no active canvas' })
        return
      }
      const name = cmd.payload.name?.trim() || nextAgentName()
      const prompt = cmd.payload.prompt?.trim() ?? ''
      void (async () => {
        const r = await window.canvas.newCard(target.dir)
        if (!r) {
          reply({ ok: false, message: 'card creation was cancelled' })
          return
        }
        // Queue the instruction BEFORE the card mounts, so ensure-card launches
        // the agent already working on it (no keystroke race against startup).
        if (prompt) window.canvas.setInitialPrompt(r.cardId, prompt)
        setNodes((ns) => [...ns, makeCard(r.cardId, r.folder, 'agent', name)])
        proj.attachCardTo(target.id, r.cardId)
        if (proj.activeProjectId !== target.id) switchProject(target.id)
        // Hold the new card invisible until the spawn comet lands on its slot; a
        // safety timer reveals it even if the tracer never fires (e.g. off-screen).
        setPendingReveal((s) => new Set(s).add(r.cardId))
        setTimeout(() => reveal(r.cardId), TRACER_TRAVEL_MS + 1500)
        reply({
          ok: true,
          cardId: r.cardId,
          message: `spawned ${name} on ${target.name}${prompt ? ', working on the task' : ''}`,
        })
      })()
      return
    }

    if (cmd.cmd === 'spawnBrowser') {
      const canvasId = cmd.payload.canvasId
      const target = canvasId ? proj.projects.find((p) => p.id === canvasId) : proj.active
      if (!target) {
        reply({ ok: false, message: canvasId ? `no canvas with id ${canvasId}` : 'no active canvas' })
        return
      }
      const url = cmd.payload.url?.trim() || undefined
      const name = cmd.payload.name?.trim() || undefined
      const ownerCardId = cmd.payload.ownerCardId
      const reason = cmd.payload.reason?.trim() || undefined
      void (async () => {
        const r = await window.canvas.newBrowser(target.dir, url)
        if (!r) {
          reply({ ok: false, message: 'browser creation was cancelled' })
          return
        }
        const node = makeCard(r.cardId, r.folder, 'browser', name, url)
        // An agent-requested browser carries its owner link + stated reason.
        node.data.ownerCardId = ownerCardId
        node.data.reason = reason
        setNodes((ns) => [...ns, node])
        proj.attachCardTo(target.id, r.cardId)
        bumpBrowser(r.cardId) // a freshly opened browser starts live, not evicted
        if (proj.activeProjectId !== target.id) switchProject(target.id)
        // Same reveal dance as spawnAgent — invisible until the comet lands.
        setPendingReveal((s) => new Set(s).add(r.cardId))
        setTimeout(() => reveal(r.cardId), TRACER_TRAVEL_MS + 1500)
        reply({
          ok: true,
          cardId: r.cardId,
          message: `opened a browser on ${target.name}${url ? ` at ${url}` : ''}`,
        })
      })()
      return
    }

    if (cmd.cmd === 'navigateBrowser') {
      const { cardId, url } = cmd.payload
      const node = nodesRef.current.find((n) => n.id === cardId && n.type === 'card')
      if (!node) {
        reply({ ok: false, message: `no card with id ${cardId}` })
        return
      }
      if (node.data.kind !== 'browser') {
        reply({ ok: false, message: `${titleFor(cardId)} is not a browser` })
        return
      }
      // Bump the nonce so BrowserView loads the url; surface the card so the
      // navigation is visible. Display url updates from the webview's did-navigate.
      setNodes((ns) =>
        ns.map((n) =>
          n.id === cardId && n.type === 'card'
            ? { ...n, data: { ...n.data, goto: { url, nonce: (n.data.goto?.nonce ?? 0) + 1 } } }
            : n,
        ),
      )
      promoteCard(cardId)
      reply({ ok: true, message: `navigated ${titleFor(cardId)} to ${url}` })
      return
    }

    if (cmd.cmd === 'setBrowserReason') {
      const { cardId, reason } = cmd.payload
      const node = nodesRef.current.find((n) => n.id === cardId && n.type === 'card')
      if (!node || node.data.kind !== 'browser') {
        reply({ ok: false, message: `${cardId} is not a browser` })
        return
      }
      setNodes((ns) =>
        ns.map((n) =>
          n.id === cardId && n.type === 'card' ? { ...n, data: { ...n.data, reason } } : n,
        ),
      )
      reply({ ok: true, message: `updated reason for ${titleFor(cardId)}` })
      return
    }

    if (cmd.cmd === 'readBrowser' || cmd.cmd === 'screenshotBrowser' || cmd.cmd === 'actBrowser') {
      const { cardId } = cmd.payload
      const node = nodesRef.current.find((n) => n.id === cardId && n.type === 'card')
      if (!node) {
        reply({ ok: false, message: `no card with id ${cardId}` })
        return
      }
      if (node.data.kind !== 'browser') {
        reply({ ok: false, message: `${titleFor(cardId)} is not a browser` })
        return
      }
      const handle = getBrowser(cardId)
      if (!handle) {
        reply({ ok: false, message: `${titleFor(cardId)}'s web view isn't ready yet` })
        return
      }
      // An action mutates the page — surface the card so it's visible. Reads and
      // screenshots are silent observations (no promote, no comet latency).
      if (cmd.cmd === 'actBrowser') promoteCard(cardId)
      void (async () => {
        try {
          if (cmd.cmd === 'readBrowser') {
            reply({ ok: true, message: `read ${titleFor(cardId)}`, snapshot: await handle.read() })
          } else if (cmd.cmd === 'screenshotBrowser') {
            reply({ ok: true, message: `captured ${titleFor(cardId)}`, image: await handle.screenshot() })
          } else {
            reply(await handle.act(cmd.payload.action))
          }
        } catch (e) {
          reply({ ok: false, message: e instanceof Error ? e.message : String(e) })
        }
      })()
      return
    }

    if (cmd.cmd === 'renameAgent') {
      const { cardId, name } = cmd.payload
      reply(
        renameCard(cardId, name)
          ? { ok: true, message: `renamed to ${name.trim()}` }
          : { ok: false, message: `couldn't rename ${cardId}` },
      )
      return
    }

    if (cmd.cmd === 'killCard') {
      const { cardId } = cmd.payload
      if (!nodesRef.current.some((n) => n.id === cardId && n.type === 'card')) {
        reply({ ok: false, message: `no card with id ${cardId}` })
        return
      }
      const name = titleFor(cardId) // capture before onCloseCard removes the node
      onCloseCard(cardId)
      reply({ ok: true, message: `closed ${name}` })
      return
    }

    reply({ ok: false, message: 'unknown command' })
  }
  useEffect(() => window.canvas.onOrchestratorCommand((cmd) => orchCommandRef.current(cmd)), [])
  useEffect(() => window.canvas.onOrchestratorTarget((t) => fireTargetRef.current(t)), [])
  // Main needs a dormant browser driven — bump it to most-recent so the budget
  // brings it back live (its guest remounts and reloads).
  useEffect(() => window.canvas.onBrowserWake((cardId) => bumpBrowser(cardId)), [bumpBrowser])
  // A browser's page was screenshotted — bump its pulse to play the scan sweep.
  useEffect(
    () =>
      window.canvas.onBrowserScan((cardId) =>
        setScanPulse((prev) => new Map(prev).set(cardId, (scanTick.current += 1))),
      ),
    [],
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

  // The webview budget: keep the BROWSER_BUDGET most-recent browser guests live
  // (the active master always wins), evict the rest to dormant. App-wide — every
  // browser holds resources regardless of which canvas it's parked on.
  const dormantBrowsers = useMemo(() => {
    const ids = cardNodes.flatMap((n) => (n.data.kind === 'browser' ? [n.id] : []))
    if (ids.length <= BROWSER_BUDGET) return new Set<string>()
    const ranked = [...ids].sort((a, b) => {
      const ra = a === masterCard?.id ? Infinity : (browserRecency.get(a) ?? 0)
      const rb = b === masterCard?.id ? Infinity : (browserRecency.get(b) ?? 0)
      return rb - ra
    })
    return new Set(ranked.slice(BROWSER_BUDGET))
  }, [cardNodes, masterCard?.id, browserRecency])

  // Ownership links for the UI: a browser → its owner's name (window-bar chip),
  // and an agent → the browser it owns (its poster thumbnail). First owner wins.
  const ownedBrowserByAgent = useMemo(() => {
    const m = new Map<string, CanvasNode>()
    for (const n of cardNodes) {
      const owner = n.data.kind === 'browser' ? n.data.ownerCardId : undefined
      if (owner && !m.has(owner)) m.set(owner, n)
    }
    return m
  }, [cardNodes])
  const mRect = masterRect(winW, winH, hasStack)
  // The diff side sheet overlays the right half — independent of the layout.
  const sheetW = Math.min(900, Math.max(520, Math.round(winW * 0.5)))
  // The active canvas's repo — the diff drawer watches it. Keyed by project id
  // so switching canvases re-points the watcher. Null when there's no canvas.
  const activeDir = active?.dir

  const maxScroll = Math.max(0, stackContentHeight(stackCards.length) - (winH - TOP_STRIP - PAD))
  const scroll = Math.min(stackScroll, maxScroll)
  scrollRef.current = scroll

  // During a deck-restack switch, the outgoing canvas's cards keep rendering at
  // their old master/stack slots (frozen at the scroll they had) while they
  // recede and fade — so we lay them out independently of the now-active board.
  // Null whenever no switch is in flight or the leaving canvas is gone (deleted).
  const leavingLayout = useMemo(() => {
    const leavingId = proj.switching?.leaving
    const leaving = leavingId ? proj.projects.find((p) => p.id === leavingId) : undefined
    if (!leaving) return null
    const ordered = leaving.cardIds.filter((id) => cardNodes.some((n) => n.id === id))
    const masterId = ordered.find((id) => id === leaving.focusedCardId) ?? ordered[0] ?? null
    const stack = ordered.filter((id) => id !== masterId)
    const m = masterRect(winW, winH, stack.length > 0)
    const rects = new Map<string, Rect>()
    if (masterId) rects.set(masterId, m)
    stack.forEach((id, i) => {
      const s = stackSlot(winW, i)
      rects.set(id, { ...s, y: s.y - leaveScrollRef.current })
    })
    return { rects, masterId }
  }, [proj.switching?.leaving, proj.projects, cardNodes, winW, winH])

  const rectFor = (cardId: string): Rect => {
    if (cardId === masterCard?.id) return mRect
    const i = stackIndex.get(cardId)
    if (i === undefined) return PARKED
    const s = stackSlot(winW, i)
    return { ...s, y: s.y - scroll }
  }
  rectForRef.current = rectFor

  // Fire a tracer from the chat bar to the agent the orchestrator just acted on.
  // `approve` arrives with an askId (approvals carry no card id), so resolve it to
  // the asking card. A freshly spawned card may not be laid out for a frame or two,
  // so retry briefly; a target that never becomes visible (parked on another
  // canvas) is skipped rather than shooting a beam off-screen.
  fireTargetRef.current = (t: OrchestratorTarget): void => {
    const cardId = t.cardId ?? (t.askId ? asks.find((a) => a.askId === t.askId)?.cardId : undefined)
    if (!cardId) return
    const color = TRACER_COLOR[t.kind]
    const from = { x: winW / 2, y: winH - CHAT_BAR_INSET } // the chat bar, bottom-center
    const launch = (attempts: number): void => {
      const r = rectForRef.current(cardId)
      if (r.x <= -10000) {
        if (attempts > 0) requestAnimationFrame(() => launch(attempts - 1))
        return
      }
      const to = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
      // Carry the card's frame so a grid ripple can energize it on impact, clipped
      // to its rounded corners (agents are rounded-2xl, shells/browsers rounded-lg).
      const radius = cardNodes.find((n) => n.id === cardId)?.data.kind === 'agent' ? 16 : 8
      const rect = { x: r.x, y: r.y, w: r.w, h: r.h }
      setTracers((ts) => [...ts, { id: tracerSeq.current++, from, to, color, rect, radius }])
      // A spawned card materializes when its delivering comet lands.
      if (t.kind === 'spawn') setTimeout(() => reveal(cardId), TRACER_TRAVEL_MS)
    }
    launch(6)
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

      {/* Voice glow: a cinematic cyan aura on the window edges while the
          orchestrator speaks. The on/off fade rides the `is-speaking` class; the
          inner aura's intensity tracks the live voice loudness (--voice-level). */}
      <div className={`voice-glow ${speaking ? 'is-speaking' : ''}`}>
        <div className="voice-glow__aura" />
      </div>

      {/* Tracers the orchestrator fires at an agent when it acts on one. */}
      <OrchestratorTracers
        tracers={tracers}
        onDone={(id) => setTracers((ts) => ts.filter((t) => t.id !== id))}
      />

      {/* One stable layer of every card across every project. The active
          project's cards take the master/stack slots; the rest stay mounted but
          parked off-screen and hidden — so no card's xterm ever unmounts. */}
      {cardNodes.map((n) => {
        const inActive = activeSet.has(n.id)
        const isMaster = inActive && masterCard?.id === n.id
        // The receding board: cards of the canvas being switched away from, kept
        // visible at their old slots for the deck cross-fade, then dropped.
        const leavingRect = !inActive ? leavingLayout?.rects.get(n.id) : undefined
        const isLeavingMaster = leavingRect && leavingLayout?.masterId === n.id
        const visible = inActive || !!leavingRect
        const r = inActive ? rectFor(n.id) : (leavingRect ?? PARKED)
        // The rising board fades up and forward (deck-enter); the receding board
        // sinks back and fades (deck-leave). Only while a switch is in flight.
        const deck = proj.switching ? (inActive ? ' deck-enter' : leavingRect ? ' deck-leave' : '') : ''
        return (
          <div
            key={n.id}
            className={`absolute left-0 top-0${deck}`}
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
              // Held at 0 until its spawn comet lands, then fades in on impact.
              opacity: pendingReveal.has(n.id) ? 0 : 1,
              transition: [
                proj.animate && inActive ? 'transform .25s ease, width .25s ease, height .25s ease' : '',
                'opacity .35s ease',
              ]
                .filter(Boolean)
                .join(', '),
              visibility: visible ? 'visible' : 'hidden',
              // Rising board sits above the receding one so it reads as coming
              // forward; within each, the master outranks its stack.
              zIndex: isMaster ? 10 : isLeavingMaster ? 2 : leavingRect ? 0 : 1,
            }}
          >
            <CardNode
              id={n.id}
              data={n.data}
              stacked={!isMaster}
              dormant={dormantBrowsers.has(n.id)}
              ownerName={
                n.data.kind === 'browser' &&
                n.data.ownerCardId &&
                cardNodes.some((x) => x.id === n.data.ownerCardId)
                  ? titleFor(n.data.ownerCardId)
                  : undefined
              }
              onFlyToOwner={
                n.data.ownerCardId ? () => promoteCard(n.data.ownerCardId!) : undefined
              }
              browserThumb={ownedBrowserByAgent.get(n.id)?.data.snapshot}
              scanNonce={scanPulse.get(n.id) ?? 0}
              title={shellTitles[n.id]}
            />
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
                aria-label="New browser"
                disabled={!active}
                onClick={() => void addCard('browser')}
              >
                <Globe />
              </Button>
            }
          />
          <TooltipContent side="right">New browser</TooltipContent>
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
          onRename={(cardId) => {
            const n = nodesRef.current.find((x) => x.id === cardId)
            const current = (n?.type === 'card' ? n.data.name : '') ?? ''
            setRenaming({ cardId, value: current })
          }}
          onDismiss={() => setContextMenu(null)}
        />
      )}

      {renaming && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onMouseDown={() => setRenaming(null)}
        >
          <div
            className="w-80 rounded-xl border border-border/40 bg-popover/95 p-4 shadow-2xl backdrop-blur-xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="mb-2 font-mono text-xs text-muted-foreground">Rename agent</p>
            <input
              autoFocus
              value={renaming.value}
              onChange={(e) => setRenaming({ cardId: renaming.cardId, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  renameCard(renaming.cardId, renaming.value)
                  setRenaming(null)
                } else if (e.key === 'Escape') {
                  setRenaming(null)
                }
              }}
              placeholder="Agent name"
              className="w-full rounded-lg border border-border/40 bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-border"
            />
            <div className="mt-3 flex justify-end gap-2 font-mono text-xs">
              <button
                className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-accent"
                onClick={() => setRenaming(null)}
              >
                Cancel
              </button>
              <button
                className="rounded-lg bg-foreground/10 px-3 py-1.5 text-foreground hover:bg-foreground/20"
                onClick={() => {
                  renameCard(renaming.cardId, renaming.value)
                  setRenaming(null)
                }}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
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
          onConfirmDecide={(allow) => {
            if (orchConfirm) window.canvas.orchestratorResult(orchConfirm.id, { allow })
            setOrchConfirm(null)
          }}
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
