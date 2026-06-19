import { PAD, RIGHT_GUTTER, TOP_STRIP } from '../canvas/layout'
import { IssueBoard } from './IssueBoard'
import type { IssueBoardApi } from './useIssueBoard'

/// The issue board side sheet: the second right-edge drawer (a sibling of the
/// diff sheet, sharing one width channel — Canvas's `rightSheet` discriminator
/// makes them mutually exclusive, both toggled from the right `SheetRail`).
/// Collapsing parks it off-screen but keeps it mounted (the store subscription +
/// selection survive). Keyed by the active project id so switching canvases
/// re-points the whole board to that canvas's own vision + sprint tree. Inset by
/// RIGHT_GUTTER so it stops short of the rail.
export function IssueSheet(props: {
  activeProjectId: string | null
  board: IssueBoardApi
  sheetW: number
  collapsed: boolean
  onCollapse: () => void
}) {
  const { activeProjectId, board, sheetW, collapsed, onCollapse } = props
  return (
    <div
      data-issue-sheet
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
      <IssueBoard
        key={activeProjectId ?? 'none'}
        projectId={activeProjectId}
        board={board}
        onCollapse={onCollapse}
      />
    </div>
  )
}
