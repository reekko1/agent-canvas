import { useEffect, useState } from 'react'
import { Bot, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { STATUS_COLORS, type CardData } from './meta'
import { TerminalView } from './TerminalView'
import { PosterFace } from './PosterFace'
import { ShellFace } from './ShellFace'

/** How often the shell title re-reads the pane's running command (ms). */
const POLL_MS = 1500

/** Poll the command running in a shell card's pane (the "what's running"
 *  title) — the main process resolves it to the typed command or null when
 *  idle. Disabled for agent cards: the spine already speaks for those. */
function useRunningCommand(cardId: string, enabled: boolean): string | null {
  const [running, setRunning] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = async (): Promise<void> => {
      const cmd = await window.canvas.paneCommand(cardId)
      if (alive) setRunning(cmd)
    }
    void tick()
    const t = setInterval(tick, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [cardId, enabled])
  return running
}

/// One agent on the canvas: status-tinted chrome around a live terminal. As
/// the master it shows the terminal; in the stack a compact poster overlays
/// the (still-mounted) terminal, and clicking it promotes the card. The xterm
/// instance never unmounts across that switch — `stacked` only toggles which
/// face composites.
export function CardNode({
  id,
  data,
  stacked,
}: {
  id: string
  data: CardData
  stacked: boolean
}) {
  const { meta, folder, kind } = data
  const isShell = kind === 'shell'
  // A shell card has no agent to speak for it — calm, neutral chrome always.
  const color = isShell ? 'var(--border)' : STATUS_COLORS[meta.status]
  const folderName = folder.split('/').filter(Boolean).pop() ?? folder
  const running = useRunningCommand(id, isShell)

  return (
    <div
      className={`relative flex h-full w-full flex-col overflow-hidden border-2 shadow-2xl ${
        // Shell = a squarer, single-surface screen; agent = a soft poster.
        isShell ? 'rounded-lg bg-terminal' : 'rounded-2xl bg-card'
      }`}
      style={{ borderColor: color }}
    >
      <div
        className={`flex items-center gap-2.5 px-3 py-1.5 font-mono text-xs ${
          // Shell chrome melts into the screen; agent chrome is a poster bar.
          isShell
            ? 'border-b border-border/40 bg-terminal text-terminal-foreground/80'
            : 'bg-muted text-foreground/80'
        }`}
      >
        {/* Identity mark: a bot for the agent, the shell's >_ prompt for shells. */}
        {isShell ? (
          <span className="font-bold text-muted-foreground/70" aria-hidden>
            {'>_'}
          </span>
        ) : (
          <Bot className="size-3.5 text-muted-foreground/70" aria-hidden />
        )}
        <span className="text-muted-foreground">{folderName}</span>
        {/* Shell bar carries only the folder; its command lives on the poster. */}
        <span className="flex-1 truncate">{isShell ? '' : (meta.task ?? meta.detail ?? '')}</span>
        {meta.model && <span className="text-muted-foreground">{meta.model}</span>}
        {meta.permissionMode === 'bypassPermissions' && (
          <span className="font-bold text-status-error">BYPASS</span>
        )}
        {/* Status HUD on the right — a live dot reading out the agent's state. */}
        {!isShell && (
          <span className="flex items-center gap-1.5 font-bold" style={{ color }}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
            {meta.status.toUpperCase()}
          </span>
        )}
        <span className="mx-1 h-4 w-px bg-border" />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => data.onClose(id)}
          title="Delete card (kills its tmux session)"
          aria-label="Delete card"
        >
          <X />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <TerminalView
          cardId={id}
          folder={folder}
          kind={kind}
          // A stacked shell shows its live terminal as the preview; only the
          // agent poster covers its terminal.
          hidden={stacked && !isShell}
          // Stacked terminals are inert — the promote button owns the cursor,
          // so a drag can't start an xterm selection instead of expanding.
          interactive={!stacked}
          onEngage={() => data.onEngage(id)}
        />
        {stacked && (
          <button
            className="absolute inset-0 block cursor-pointer border-none bg-transparent p-0 text-left"
            onClick={() => data.onPromote(id)}
            title="Open in the main view"
          >
            {isShell ? (
              <ShellFace running={running} />
            ) : (
              <PosterFace meta={meta} />
            )}
          </button>
        )}
      </div>
    </div>
  )
}
