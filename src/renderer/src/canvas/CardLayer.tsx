import { CardNode } from '@/cards/CardNode'
import type { Rect } from './layout'
import type { CanvasNode } from './nodes'
import type { ShellTitle } from './useShellTitles'
import { PARKED } from './useMasterStackLayout'

/// One stable layer of every card across every project. The active project's
/// cards take the master/stack slots; the rest stay mounted but parked
/// off-screen and hidden — so no card's xterm/webview ever unmounts. During a
/// canvas switch the receding board's cards keep rendering at their old slots
/// (`leavingLayout`) for the deck cross-fade, then drop back to parked.
export function CardLayer(props: {
  cardNodes: CanvasNode[]
  activeSet: Set<string>
  masterCardId: string | undefined
  leavingLayout: { rects: Map<string, Rect>; masterId: string | null } | null
  switching: boolean
  animate: boolean
  pendingReveal: Set<string>
  rectFor: (cardId: string) => Rect
  dormantBrowsers: Set<string>
  ownedBrowserByAgent: Map<string, CanvasNode>
  scanPulse: Map<string, number>
  shellTitles: Record<string, ShellTitle>
  titleFor: (cardId: string) => string
  promoteCard: (cardId: string) => void
  onContextMenu: (cardId: string, x: number, y: number) => void
}) {
  const {
    cardNodes,
    activeSet,
    masterCardId,
    leavingLayout,
    switching,
    animate,
    pendingReveal,
    rectFor,
    dormantBrowsers,
    ownedBrowserByAgent,
    scanPulse,
    shellTitles,
    titleFor,
    promoteCard,
    onContextMenu,
  } = props

  return (
    <>
      {cardNodes.map((n) => {
        const inActive = activeSet.has(n.id)
        const isMaster = inActive && masterCardId === n.id
        // The receding board: cards of the canvas being switched away from, kept
        // visible at their old slots for the deck cross-fade, then dropped.
        const leavingRect = !inActive ? leavingLayout?.rects.get(n.id) : undefined
        const isLeavingMaster = leavingRect && leavingLayout?.masterId === n.id
        const visible = inActive || !!leavingRect
        const r = inActive ? rectFor(n.id) : (leavingRect ?? PARKED)
        // The rising board fades up and forward (deck-enter); the receding board
        // sinks back and fades (deck-leave). Only while a switch is in flight.
        const deck = switching ? (inActive ? ' deck-enter' : leavingRect ? ' deck-leave' : '') : ''
        return (
          <div
            key={n.id}
            className={`absolute left-0 top-0${deck}`}
            onContextMenu={
              inActive
                ? (e) => {
                    e.preventDefault()
                    onContextMenu(n.id, e.clientX, e.clientY)
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
                animate && inActive ? 'transform .25s ease, width .25s ease, height .25s ease' : '',
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
              onFlyToOwner={n.data.ownerCardId ? () => promoteCard(n.data.ownerCardId!) : undefined}
              browserThumb={ownedBrowserByAgent.get(n.id)?.data.snapshot}
              scanNonce={scanPulse.get(n.id) ?? 0}
              title={shellTitles[n.id]}
            />
          </div>
        )
      })}
    </>
  )
}
