import { useMemo, useState } from 'react'
import { SheetShell } from '../canvas/SheetShell'
import { EmptyState } from './ui'
import { SprintList } from './SprintList'
import { PlanView } from './PlanView'
import type { IssueBoardApi } from './useIssueBoard'

/// The issue board panel: a master-detail split — the active project's sprints
/// on the left, the selected sprint's plan + issue DAG on the right. The vision
/// band lives in its own VisionSheet, so this stays a clean execution board. v1
/// is human-driven; every gate/verdict is a manual control behind the seam an
/// agent later assumes.
export function IssueBoard({
  projectId,
  board,
  onCollapse,
}: {
  projectId: string | null
  board: IssueBoardApi
  onCollapse: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = useMemo(
    () => board.sprints.find((s) => s.id === selectedId) ?? board.sprints[0] ?? null,
    [board.sprints, selectedId],
  )

  return (
    <SheetShell
      title={<span className="text-[13px] font-semibold text-foreground">Issues</span>}
      onCollapse={onCollapse}
    >
      {projectId ? (
        <div className="flex h-full">
          <div className="w-2/5 min-w-[200px] border-r border-border">
            <SprintList
              board={board}
              projectId={projectId}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {selected ? (
              <PlanView board={board} sprint={selected} />
            ) : (
              <EmptyState>Create a sprint to start planning toward the vision.</EmptyState>
            )}
          </div>
        </div>
      ) : (
        <EmptyState>Open a canvas — each one keeps its own sprints and issues.</EmptyState>
      )}
    </SheetShell>
  )
}
