import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { STATUS_COLORS, type CardData } from './meta'
import { TerminalView } from './TerminalView'
import { PosterFace } from './PosterFace'

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

/** A shell card's title: the command it's running, or a muted "idle". */
function ShellTitle({ running }: { running: string | null }) {
  return running ? (
    <span className="text-foreground">{running}</span>
  ) : (
    <span className="text-muted-foreground/60">idle</span>
  )
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
      className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl border-2 bg-card shadow-2xl"
      style={{ borderColor: color }}
    >
      <div className="flex items-center gap-2.5 bg-muted px-3 py-1.5 font-mono text-xs text-foreground/80">
        {isShell ? (
          <span className="font-bold text-muted-foreground">SHELL</span>
        ) : (
          <span className="font-bold" style={{ color }}>
            {meta.status.toUpperCase()}
          </span>
        )}
        <span className="text-muted-foreground">{folderName}</span>
        <span className="flex-1 truncate">
          {isShell ? <ShellTitle running={running} /> : (meta.task ?? meta.detail ?? '')}
        </span>
        {meta.model && <span className="text-muted-foreground">{meta.model}</span>}
        {meta.permissionMode === 'bypassPermissions' && (
          <span className="font-bold text-status-error">BYPASS</span>
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
          hidden={stacked}
          onEngage={() => data.onEngage(id)}
        />
        {stacked && (
          <button
            className="absolute inset-0 block cursor-pointer border-none bg-transparent p-0 text-left"
            onClick={() => data.onPromote(id)}
            title="Open in the main view"
          >
            <PosterFace meta={meta} folderName={folderName} isShell={isShell} running={running} />
          </button>
        )}
      </div>
    </div>
  )
}
