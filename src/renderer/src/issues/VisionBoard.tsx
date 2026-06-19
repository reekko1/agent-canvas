import { SheetShell } from '../canvas/SheetShell'
import { EmptyState } from './ui'
import { VisionPanel } from './VisionPanel'
import { DistancePanel } from './DistancePanel'
import type { IssueBoardApi } from './useIssueBoard'

/// The vision board (the north-star sheet, sibling of the issues constellation):
/// the
/// distance-to-vision assessment up top, then the full vision — current version,
/// the immutable "git for intent" timeline, and the commit composer — given room
/// to breathe in its own sheet. v1 is human-driven; committing is the sole
/// writer's act (agents may propose later).
export function VisionBoard({
  projectId,
  board,
  onCollapse,
}: {
  projectId: string | null
  board: IssueBoardApi
  onCollapse: () => void
}) {
  return (
    <SheetShell
      title={<span className="text-[13px] font-semibold text-foreground">Vision</span>}
      subtitle="the north star"
      onCollapse={onCollapse}
    >
      {projectId ? (
        <div className="frontier-field relative flex h-full flex-col">
          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            <DistancePanel board={board} />
            <VisionPanel board={board} />
          </div>
        </div>
      ) : (
        <EmptyState>Open a canvas — each one keeps its own vision.</EmptyState>
      )}
    </SheetShell>
  )
}
