import {
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import type { Project } from '@shared/types'
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
import type { SwitchState } from './useProjects'

/** Off-screen parking rect for cards in inactive projects — kept mounted and
 *  sized (so xterm/FitAddon stay valid) but `visibility:hidden`. `rectFor`
 *  treats any `x <= -10000` as "not laid out". */
export const PARKED: Rect = { x: -100000, y: 0, w: 800, h: 560 }

/// Derives the master-stack geometry for the active canvas — the partition
/// (which card is master vs. stack), every card's rect, the receding board's
/// frozen slots during a switch, and the stack-column wheel handler. Pure
/// derivation over the node set + active order + window size; nothing here is
/// persisted. The partition is memoized so `rectFor` does O(1) lookups via a
/// `stackIndex` map rather than re-partitioning on every render (resize/scroll).
export function useMasterStackLayout(params: {
  nodes: CanvasNode[]
  active: Project | undefined
  switching: SwitchState
  projects: Project[]
  winW: number
  winH: number
  stackScroll: number
  setStackScroll: Dispatch<SetStateAction<number>>
  diffCollapsed: boolean
}) {
  const { nodes, active, switching, projects, winW, winH, stackScroll, setStackScroll, diffCollapsed } =
    params

  // The live stack scroll, mirrored to a ref so the switch handler can snapshot
  // it the instant before resetting — the receding board fades from where it
  // actually sat, not from scroll 0.
  const scrollRef = useRef(0)
  const leaveScrollRef = useRef(0)
  const rectForRef = useRef<(cardId: string) => Rect>(() => PARKED)

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

  const maxScroll = Math.max(0, stackContentHeight(stackCards.length) - (winH - TOP_STRIP - PAD))
  const scroll = Math.min(stackScroll, maxScroll)
  scrollRef.current = scroll

  // During a deck-restack switch, the outgoing canvas's cards keep rendering at
  // their old master/stack slots (frozen at the scroll they had) while they
  // recede and fade — so we lay them out independently of the now-active board.
  // Null whenever no switch is in flight or the leaving canvas is gone (deleted).
  const leavingLayout = useMemo(() => {
    const leavingId = switching?.leaving
    const leaving = leavingId ? projects.find((p) => p.id === leavingId) : undefined
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
  }, [switching?.leaving, projects, cardNodes, winW, winH])

  const rectFor = useCallback(
    (cardId: string): Rect => {
      if (cardId === masterCard?.id) return mRect
      const i = stackIndex.get(cardId)
      if (i === undefined) return PARKED
      const s = stackSlot(winW, i)
      return { ...s, y: s.y - scroll }
    },
    [masterCard?.id, mRect, stackIndex, winW, scroll],
  )
  rectForRef.current = rectFor

  /** Snapshot the current scroll as the receding board's frozen offset — called
   *  by the project switch the instant before `setStackScroll(0)`. */
  const beginLeave = useCallback(() => {
    leaveScrollRef.current = scrollRef.current
  }, [])

  const onStackWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (!hasStack || maxScroll <= 0) return
      // The diff sheet overlays the stack column — don't scroll the hidden
      // stack behind it when the wheel is over the sheet.
      if (!diffCollapsed && (e.target as HTMLElement).closest('[data-diff-sheet]')) return
      if (e.clientX < winW - stackWidth(winW) - PAD) return // not over the stack column
      setStackScroll((s) => Math.max(0, Math.min(maxScroll, s + e.deltaY)))
    },
    [hasStack, maxScroll, winW, diffCollapsed, setStackScroll],
  )

  // Only the fields Canvas composes with are returned; the partition pieces
  // (stackCards/stackIndex/hasStack/mRect/scroll/maxScroll) stay internal —
  // they're inputs to rectFor / onStackWheel, not part of the hook's contract.
  return {
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
  }
}
