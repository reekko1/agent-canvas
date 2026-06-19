import { useState } from 'react'
import { AlertTriangle, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SprintStateBadge } from './badges'
import { InlineComposer, SectionLabel, TextInput, asIcon } from './ui'
import type { IssueBoardApi } from './useIssueBoard'

const PlusIcon = asIcon(Plus)

/// The active project's sprints — selectable rows leading with the outcome (the
/// thing you read), then a quiet meta line of state + pinned vision version. A
/// stranded sprint (a vision bump moved past it) surfaces an inline realignment
/// prompt. The footer composer pins the current vision version; writing the gap
/// rationale IS gate #0 (does this serve the vision?).
export function SprintList({
  board,
  projectId,
  selectedId,
  onSelect,
}: {
  board: IssueBoardApi
  projectId: string | null
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const [outcome, setOutcome] = useState('')
  const [gap, setGap] = useState('')
  const [adding, setAdding] = useState(false)

  const versionN = (id: string): number | undefined => board.versions.find((v) => v.id === id)?.n
  const canCreate = !!projectId && !!board.currentVersion

  const create = (): void => {
    if (!outcome.trim()) return
    board.createSprint({ outcome: outcome.trim(), gapRationale: gap.trim() })
    setOutcome('')
    setGap('')
    setAdding(false)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-1.5 pt-3">
        <SectionLabel count={board.sprints.length}>Sprints</SectionLabel>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {board.sprints.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">No sprints yet.</p>
        ) : (
          <div className="space-y-0.5">
            {board.sprints.map((s) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(s.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(s.id)}
                className={cn(
                  'cursor-pointer rounded-lg px-2.5 py-2 transition-colors',
                  s.id === selectedId ? 'bg-accent' : 'hover:bg-hover',
                )}
              >
                <div className="truncate text-[13px] font-medium text-foreground" title={s.outcome}>
                  {s.outcome || <span className="text-muted-foreground">Untitled sprint</span>}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <SprintStateBadge state={s.state} />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    v{versionN(s.visionVersionRef) ?? '?'}
                  </span>
                </div>

                {s.state === 'REALIGNMENT_PENDING' && s.realignment && (
                  <div className="mt-2 space-y-2 rounded-md border border-status-blocked/30 bg-status-blocked/10 p-2.5">
                    <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-status-blocked">
                      <AlertTriangle className="mt-px size-3 shrink-0" />
                      <span>
                        Vision moved v{versionN(s.realignment.fromVisionVersion) ?? '?'} → v
                        {versionN(s.realignment.toVisionVersion) ?? '?'}. Re-verdict this sprint.
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        onClick={(e) => {
                          e.stopPropagation()
                          board.resolveRealignment(s.id, 'aligned')
                        }}
                      >
                        Still aligned
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm('Drop this sprint and its plan + issues?'))
                            board.resolveRealignment(s.id, 'remove')
                        }}
                      >
                        Drop
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-2.5">
        {adding ? (
          <InlineComposer
            submitLabel="Create sprint"
            canSubmit={!!outcome.trim()}
            onSubmit={create}
            onCancel={() => setAdding(false)}
          >
            <TextInput
              autoFocus
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="Outcome — the definition of done"
            />
            <TextInput
              value={gap}
              onChange={(e) => setGap(e.target.value)}
              placeholder="Which vision gap does this close?"
            />
          </InlineComposer>
        ) : (
          <Button
            variant="secondary"
            leadingIcon={PlusIcon}
            disabled={!canCreate}
            className="w-full"
            title={
              !projectId
                ? 'Open a canvas first'
                : !board.currentVersion
                  ? 'Commit a vision version first'
                  : undefined
            }
            onClick={() => setAdding(true)}
          >
            New sprint
          </Button>
        )}
      </div>
    </div>
  )
}
