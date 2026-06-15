import { STATUS_COLORS, type CardData } from './meta'
import { TerminalView } from './TerminalView'
import { PosterFace } from './PosterFace'

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
        <span className="flex-1 truncate">{meta.task ?? meta.detail ?? ''}</span>
        {meta.model && <span className="text-muted-foreground">{meta.model}</span>}
        {meta.permissionMode === 'bypassPermissions' && (
          <span className="font-bold text-status-error">BYPASS</span>
        )}
        <button
          className="border-none bg-transparent font-mono text-sm text-muted-foreground hover:text-foreground"
          onClick={() => data.onClose(id)}
          title="Delete card (kills its tmux session)"
        >
          ✕
        </button>
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
            <PosterFace meta={meta} folderName={folderName} isShell={isShell} />
          </button>
        )}
      </div>
    </div>
  )
}
