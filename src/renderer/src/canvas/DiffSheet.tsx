import { DiffNode } from '@/diff/DiffNode'
import { PAD, RIGHT_GUTTER, TOP_STRIP } from './layout'

/// The diff side sheet: a right-edge drawer that slides over the canvas without
/// displacing the master-stack. The right `SheetRail` toggles it open/closed;
/// collapsing parks it off-screen but keeps DiffNode mounted (watcher + selection
/// survive), and closing (the caller dropping `activeDir`) tears it down. Keyed
/// by the active project id so switching canvases re-points the watcher. Inset by
/// RIGHT_GUTTER so it stops short of the rail.
export function DiffSheet(props: {
  activeDir: string
  activeProjectId: string | null
  sheetW: number
  collapsed: boolean
  onCollapse: () => void
}) {
  const { activeDir, activeProjectId, sheetW, collapsed, onCollapse } = props
  return (
    <div
      data-diff-sheet
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
      <DiffNode id={`diff-${activeProjectId}`} data={{ folder: activeDir, onCollapse }} />
    </div>
  )
}
