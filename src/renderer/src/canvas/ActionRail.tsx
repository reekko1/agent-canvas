import { useEffect, useRef, useState } from 'react'
import { Bot, Globe, Smartphone, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDismiss } from '@/hooks/use-dismiss'
import type { CardKind, CliKind } from '@shared/types'

/** Display label per CLI for the new-agent menu. */
const CLI_LABEL: Record<CliKind, string> = { claude: 'Claude Code', codex: 'Codex' }

/// The floating left rail: spawn a new agent / terminal / browser into the
/// active canvas, plus the remote-access entry. Spawn buttons are disabled when
/// there's no active canvas (nothing to spawn into). The new-agent button opens
/// a menu of installed CLIs (probed once via availableClis) — pick which backs
/// the card.
export function ActionRail(props: {
  active: boolean
  onAddCard: (kind: CardKind, cli?: CliKind) => void
  onRemote: () => void
}) {
  const { active, onAddCard, onRemote } = props
  const [clis, setClis] = useState<CliKind[]>(['claude'])
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Probe installed CLIs once; empty (nothing on PATH) falls back to claude so
  // the menu is never blank.
  useEffect(() => {
    void window.canvas.availableClis().then((found) => setClis(found.length ? found : ['claude']))
  }, [])

  useDismiss(menuRef, () => setMenuOpen(false), menuOpen)

  return (
    <div
      className="fixed left-3 top-1/2 z-40 flex -translate-y-1/2 flex-col gap-1 rounded-full border border-border/40 bg-background/55 p-1.5 shadow-lg shadow-black/10 backdrop-blur-xl"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <div ref={menuRef} className="relative">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="New agent"
                disabled={!active}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <Bot />
              </Button>
            }
          />
          <TooltipContent side="right">New agent</TooltipContent>
        </Tooltip>
        {menuOpen && (
          <div className="absolute left-full top-0 z-50 ml-2 min-w-[150px] overflow-hidden rounded-xl border border-border/40 bg-popover/95 p-1 text-sm shadow-xl backdrop-blur-xl">
            {clis.map((cli) => (
              <button
                key={cli}
                className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  onAddCard('agent', cli)
                  setMenuOpen(false)
                }}
              >
                {CLI_LABEL[cli]}
              </button>
            ))}
          </div>
        )}
      </div>
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
