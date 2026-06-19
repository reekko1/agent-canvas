import { Bot, Globe, Smartphone, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CardKind } from '@shared/types'

/// The floating left rail: spawn a new agent / terminal / browser into the
/// active canvas, plus the remote-access entry. Spawn buttons are disabled when
/// there's no active canvas (nothing to spawn into).
export function ActionRail(props: {
  active: boolean
  onAddCard: (kind: CardKind) => void
  onRemote: () => void
}) {
  const { active, onAddCard, onRemote } = props
  return (
    <div
      className="fixed left-3 top-1/2 z-40 flex -translate-y-1/2 flex-col gap-1 rounded-full border border-border/40 bg-background/55 p-1.5 shadow-lg shadow-black/10 backdrop-blur-xl"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="New agent"
              disabled={!active}
              onClick={() => onAddCard('agent')}
            >
              <Bot />
            </Button>
          }
        />
        <TooltipContent side="right">New agent</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="New terminal"
              disabled={!active}
              onClick={() => onAddCard('shell')}
            >
              <SquareTerminal />
            </Button>
          }
        />
        <TooltipContent side="right">New terminal</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="New browser"
              disabled={!active}
              onClick={() => onAddCard('browser')}
            >
              <Globe />
            </Button>
          }
        />
        <TooltipContent side="right">New browser</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="icon" aria-label="Remote access" onClick={onRemote}>
              <Smartphone />
            </Button>
          }
        />
        <TooltipContent side="right">Remote access</TooltipContent>
      </Tooltip>
    </div>
  )
}
