import { PAD, RIGHT_GUTTER, TOP_STRIP } from '../canvas/layout'
import { VisionBoard } from './VisionBoard'
import type { IssueBoardApi } from './useIssueBoard'

/// The vision board side sheet: a right-edge drawer that holds the canvas's north
/// star — its current vision, the immutable version timeline, the commit composer,
/// and the distance-to-vision assessment. Split out of the issue board so neither
/// crowds the other; it shares the same width channel (Canvas's `rightSheet`
/// discriminator makes diff / vision / issues mutually exclusive, all toggled from
/// the right `SheetRail`). Collapsing parks it off-screen but keeps it mounted (the
/// store subscription + composer survive). Keyed by the active project id so
/// switching canvases re-points the whole panel to that canvas's own vision. Inset
/// by RIGHT_GUTTER so it stops short of the rail.
export function VisionSheet(props: {
  activeProjectId: string | null
  board: IssueBoardApi
  sheetW: number
  collapsed: boolean
  onCollapse: () => void
}) {
  const { activeProjectId, board, sheetW, collapsed, onCollapse } = props
  return (
    <div
      data-vision-sheet
      className="fixed overflow-hidden rounded-2xl"
      style={{
        top: TOP_STRIP,
        bottom: PAD,
        right: RIGHT_GUTTER,
        width: sheetW,
        zIndex: 35,
        // Slide fully off-screen: its own width (100%) PLUS the gutter inset it
        // sits in, else a `RIGHT_GUTTER`-wide sliver stays visible at the edge.
        transform: collapsed ? `translateX(calc(100% + ${RIGHT_GUTTER + 24}px))` : 'translateX(0)',
        transition: 'transform .3s ease',
      }}
    >
      <VisionBoard
        key={activeProjectId ?? 'none'}
        projectId={activeProjectId}
        board={board}
        onCollapse={onCollapse}
      />
    </div>
  )
}
