import { PAD, RIGHT_GUTTER, TOP_STRIP } from './layout'
import { SkillsPanel } from './SkillsPanel'
import type { SkillsPanelApi } from './useSkillsPanel'

/// The Skills side sheet: a right-edge drawer (the 4th sibling of diff / vision / issues)
/// holding the mastermind's learned skill library, read-only. The library is GLOBAL, so —
/// unlike the vision / issue sheets — it is NOT keyed by canvas (the same set shows on every
/// canvas). Toggled from the right `SheetRail`; collapsing parks it off-screen but keeps it
/// mounted (the snapshot subscription survives). Inset by RIGHT_GUTTER so it stops short of
/// the rail, matching DiffSheet / VisionSheet exactly.
export function SkillsSheet(props: {
  panel: SkillsPanelApi
  canvasName?: (id: string) => string | undefined
  sheetW: number
  collapsed: boolean
  onCollapse: () => void
}): React.JSX.Element {
  const { panel, canvasName, sheetW, collapsed, onCollapse } = props
  return (
    <div
      data-skills-sheet
      className="fixed overflow-hidden rounded-2xl"
      style={{
        top: TOP_STRIP,
        bottom: PAD,
        right: RIGHT_GUTTER,
        width: sheetW,
        zIndex: 35,
        transform: collapsed ? `translateX(calc(100% + ${RIGHT_GUTTER + 24}px))` : 'translateX(0)',
        transition: 'transform .3s ease',
      }}
    >
      <SkillsPanel panel={panel} canvasName={canvasName} onCollapse={onCollapse} />
    </div>
  )
}
