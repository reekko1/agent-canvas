import { Crown, GitCompare, ListTodo, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DistanceAssessment } from '@shared/types'

/// The floating right rail — the mirror of the left ActionRail. It toggles four
/// mutually-exclusive right views: the git diff drawer, the Mastermind vision board,
/// and the skills gallery are right-edge sheets (they reserve master width); the issues
/// constellation is a full-viewport takeover (it reserves none). Each button opens its
/// view (collapsing the others) and closes it when clicked again, reflected by the
/// `active` press state. It lives in its own RIGHT_GUTTER channel, so an open sheet
/// stops short of it and the toggles stay reachable.
export function SheetRail(props: {
  sheet: 'diff' | 'vision' | 'issues' | 'skills' | null
  onToggle: (sheet: 'diff' | 'vision' | 'issues' | 'skills') => void
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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Skills"
              active={sheet === 'skills'}
              onClick={() => onToggle('skills')}
            >
              <Sparkles />
            </Button>
          }
        />
        <TooltipContent side="left">Skills the mastermind has learned</TooltipContent>
      </Tooltip>
    </div>
  )
}
