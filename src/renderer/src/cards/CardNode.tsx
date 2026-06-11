import { useStore, type NodeProps } from '@xyflow/react'
import { STATUS_COLORS, type CardData } from './meta'
import { TerminalView } from './TerminalView'
import { PosterFace, posterCompensation } from './PosterFace'
import { ResizeGrip } from './ResizeGrip'

/// One agent on the canvas: status-tinted chrome around a live terminal,
/// swapping to the poster face at far zoom, with the resize grip riding on
/// top. Pure composition — each face owns its own behavior.
export function CardNode({ id, data }: NodeProps & { data: CardData }) {
  const { meta, folder, kind } = data
  const isShell = kind === 'shell'
  // A shell card has no agent to speak for it — calm, neutral chrome always.
  const color = isShell ? 'var(--border)' : STATUS_COLORS[meta.status]
  const folderName = folder.split('/').filter(Boolean).pop() ?? folder

  // Far-zoom LOD: 0 = terminal; otherwise the poster's (quantized) zoom
  // compensation, so zoom gestures re-render the card a handful of times.
  const compensation = useStore((s) => posterCompensation(s.transform[2]))

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl border-2 bg-card shadow-2xl"
      style={{ borderColor: color }}
    >
      <div className="card-drag flex cursor-grab items-center gap-2.5 bg-muted px-3 py-1.5 font-mono text-xs text-foreground/80">
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
          className="nodrag border-none bg-transparent font-mono text-sm text-muted-foreground hover:text-foreground"
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
          hidden={compensation > 0}
          onEngage={() => data.onEngage(id)}
        />
        {compensation > 0 && (
          <PosterFace meta={meta} folderName={folderName} compensation={compensation} />
        )}
      </div>

      <ResizeGrip />
    </div>
  )
}
