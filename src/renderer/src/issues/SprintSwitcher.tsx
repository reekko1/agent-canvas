import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProgressMeter, SPRINT_STATE_META, StatusDot } from './badges'
import type { IssueBoardApi } from './useIssueBoard'
import type { Sprint } from '@shared/types'

/// Count an entire sprint's issues (across its plan) — the one honest number for
/// its progress meter.
function sprintProgress(board: IssueBoardApi, sprintId: string): { done: number; total: number } {
  const issues = board.plansBySprint(sprintId).flatMap((p) => board.issuesByPlan(p.id))
  return { done: issues.filter((i) => i.status === 'done').length, total: issues.length }
}

/// The sprint switcher — pure navigation, the human's "which outcome am I
/// watching" control. It creates nothing (the strategist conceives sprints; the
/// mastermind staffs them): the active sprint reads prominently (state dot ·
/// outcome · progress · pinned vision version), a chevron opens a portaled
/// popover of every sprint, each with its own meter and an amber pulse if it
/// needs realignment. Selecting just changes what's observed.
export function SprintSwitcher({
  board,
  selected,
  onSelect,
}: {
  board: IssueBoardApi
  selected: Sprint | null
  onSelect: (id: string) => void
}) {
  const versionN = (id: string): number | undefined => board.versions.find((v) => v.id === id)?.n
  const selProgress = selected ? sprintProgress(board, selected.id) : null
  const selMeta = selected ? SPRINT_STATE_META[selected.state] : null

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        disabled={board.sprints.length === 0}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:border-ring',
          board.sprints.length === 0 && 'cursor-default opacity-70 hover:bg-card',
        )}
      >
        {selected ? (
          <>
            <StatusDot
              color={selMeta?.color ?? 'var(--status-idle)'}
              className={selected.state === 'REALIGNMENT_PENDING' ? 'node-blocked' : undefined}
            />
            <span
              className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground"
              title={selected.outcome}
            >
              {selected.outcome || 'Untitled sprint'}
            </span>
            {selProgress && selProgress.total > 0 && (
              <ProgressMeter done={selProgress.done} total={selProgress.total} />
            )}
            <span className="font-mono text-[11px] text-muted-foreground/80">
              v{versionN(selected.visionVersionRef) ?? '?'}
            </span>
            {board.sprints.length > 1 && (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </>
        ) : (
          <span className="flex-1 text-[13px] text-muted-foreground">
            No sprint in flight — awaiting the strategist.
          </span>
        )}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <PopoverPrimitive.Popup className="max-h-[var(--available-height)] w-[var(--anchor-width)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none">
            {board.sprints.map((s) => {
              const p = sprintProgress(board, s.id)
              const m = SPRINT_STATE_META[s.state]
              return (
                <PopoverPrimitive.Close
                  key={s.id}
                  onClick={() => onSelect(s.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent',
                    s.id === selected?.id && 'bg-accent/60',
                  )}
                >
                  <StatusDot
                    color={m?.color ?? 'var(--status-idle)'}
                    className={s.state === 'REALIGNMENT_PENDING' ? 'node-blocked' : undefined}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {s.outcome || 'Untitled sprint'}
                  </span>
                  {p.total > 0 && <ProgressMeter done={p.done} total={p.total} />}
                  <span className="font-mono text-[11px] text-muted-foreground/70">
                    v{versionN(s.visionVersionRef) ?? '?'}
                  </span>
                </PopoverPrimitive.Close>
              )
            })}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
