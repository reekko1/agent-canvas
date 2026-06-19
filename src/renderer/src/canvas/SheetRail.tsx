import { Crown, GitCompare, ListTodo } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DistanceAssessment } from '@shared/types'

/// The floating right rail — the mirror of the left ActionRail. It toggles the
/// three right-edge side sheets (the git diff drawer, the Mastermind vision board,
/// and the issue board), which are mutually exclusive: each button opens its sheet
/// (collapsing the others) and closes it when clicked again, reflected by the
/// `active` press state. It lives in its own RIGHT_GUTTER channel, so an open sheet
/// stops short of it and the toggles stay reachable.
export function SheetRail(props: {
  sheet: 'diff' | 'vision' | 'issues' | null
  onToggle: (sheet: 'diff' | 'vision' | 'issues') => void
  /** The diff sheet only exists while a canvas (with a folder) is active. */
  hasDiff: boolean
  /** Latest distance-to-vision judgment — surfaced on the vision tooltip. */
  distance?: DistanceAssessment
}) {
  const { sheet, onToggle, hasDiff, distance } = props
  return (
    <div
      className="fixed right-3 top-1/2 z-40 flex -translate-y-1/2 flex-col gap-1 rounded-full border border-border/40 bg-background/55 p-1.5 shadow-lg shadow-black/10 backdrop-blur-xl"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Diff"
              active={sheet === 'diff'}
              disabled={!hasDiff}
              onClick={() => onToggle('diff')}
            >
              <GitCompare />
            </Button>
          }
        />
        <TooltipContent side="left">Diff</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Vision"
              active={sheet === 'vision'}
              onClick={() => onToggle('vision')}
            >
              <Crown />
            </Button>
          }
        />
        <TooltipContent side="left">
          {distance ? `Vision · distance: ${distance.note}` : 'Vision'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Issues"
              active={sheet === 'issues'}
              onClick={() => onToggle('issues')}
            >
              <ListTodo />
            </Button>
          }
        />
        <TooltipContent side="left">Issues</TooltipContent>
      </Tooltip>
    </div>
  )
}
