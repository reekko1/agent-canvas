import { useEffect, useRef } from 'react'
import { NodeResizeControl, useStore, type NodeProps } from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { Button } from '@/components/ui/button'
import { PosterFace, posterCompensation } from './PosterFace'
import type { AgentTodo, CardStatus, PermissionAskInfo } from '../../shared/types'

// Smallest a card may be resized to — keeps a terminal usable
// (the Swift CanvasLayout.minItemSize).
const MIN_W = 360
const MIN_H = 240

// Status palette lives in index.css (:root tokens); loud = blocked/error.
export const STATUS_COLORS: Record<CardStatus, string> = {
  idle: 'var(--status-idle)',
  running: 'var(--status-running)',
  waiting: 'var(--status-waiting)',
  done: 'var(--status-done)',
  stalled: 'var(--status-stalled)',
  blocked: 'var(--status-blocked)',
  error: 'var(--status-error)',
}

// xterm renders to canvas, so it needs resolved values, not var() references.
const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

const terminalTheme = () => ({
  background: cssVar('--terminal-background'),
  foreground: cssVar('--terminal-foreground'),
  cursor: cssVar('--terminal-cursor'),
  selectionBackground: cssVar('--terminal-selection'),
})

export interface CardMeta {
  status: CardStatus
  /** When the status last changed — feeds the "· 14m" attention-debt suffix. */
  statusSince?: number
  /** The CLI session running in this card — persisted (unlike status) because
   *  a tmux session outlives the app: it keys plan re-hydration on restart. */
  sessionId?: string
  detail?: string
  task?: string
  summary?: string
  model?: string
  permissionMode?: string
  subagents?: number
  todos?: AgentTodo[]
  ask?: PermissionAskInfo | null
}

export interface CardData extends Record<string, unknown> {
  folder: string
  meta: CardMeta
  onDecide: (cardId: string, askId: string, decision: 'allow' | 'deny') => void
  onClose: (cardId: string) => void
}

export function CardNode({ id, data }: NodeProps & { data: CardData }) {
  const termRef = useRef<HTMLDivElement>(null)
  const { meta, folder } = data
  const color = STATUS_COLORS[meta.status]

  useEffect(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'Menlo, monospace',
      scrollback: 5000,
      theme: terminalTheme(),
    })
    // Re-resolve the terminal palette when dark/light flips on <html>.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    // The grid follows the card's pixel size: fit on mount, refit on every
    // card resize, and mirror the resulting cols/rows into the pty (tmux and
    // the claude TUI reflow from the SIGWINCH).
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(termRef.current!)
    fit.fit()
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // DOM renderer fallback — fine for a handful of cards
    }
    const refit = new ResizeObserver(() => fit.fit())
    refit.observe(termRef.current!)
    const gridChange = term.onResize(({ cols, rows }) => window.canvas.resize(id, cols, rows))
    const offData = window.canvas.onPtyData((cardId, d) => {
      if (cardId === id) term.write(d)
    })
    const input = term.onData((d) => window.canvas.write(id, d))
    // Spawn (or reattach to) the agent only now that the terminal is
    // subscribed — no byte of output can outrun the listener.
    void window.canvas.ensureCard(id, folder, term.cols, term.rows)
    return () => {
      refit.disconnect()
      themeObserver.disconnect()
      offData()
      gridChange.dispose()
      input.dispose()
      term.dispose()
    }
  }, [id, folder])

  const folderName = data.folder.split('/').filter(Boolean).pop() ?? data.folder

  // Far-zoom LOD: 0 = terminal; otherwise the poster's (quantized) zoom
  // compensation, so zoom gestures re-render the card a handful of times.
  const compensation = useStore((s) => posterCompensation(s.transform[2]))

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl border-2 bg-card shadow-2xl"
      style={{ borderColor: color }}
    >
      <div className="card-drag flex cursor-grab items-center gap-2.5 bg-muted px-3 py-1.5 font-mono text-xs text-foreground/80">
        <span className="font-bold" style={{ color }}>{meta.status.toUpperCase()}</span>
        <span className="text-muted-foreground">{folderName}</span>
        <span className="flex-1 truncate">
          {meta.task ?? meta.detail ?? ''}
        </span>
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
        <div
          className="nodrag nowheel h-full p-3"
          // visibility (not display): layout holds the card's size and xterm
          // keeps consuming the stream; only compositing stops under the poster.
          style={{ visibility: compensation ? 'hidden' : 'visible' }}
          // Fly-in rule: while an ask is held the terminal shows no dialog, so
          // engaging with the terminal releases it to the native dialog.
          onMouseDown={() => {
            if (meta.ask) window.canvas.releaseAsks(id)
          }}
        >
          <div ref={termRef} className="h-full w-full" />
        </div>
        {compensation > 0 && (
          <PosterFace meta={meta} folderName={folderName} compensation={compensation} />
        )}
      </div>

      {/* Invisible grab zone pinned fully inside the corner (xyflow centers
          handles ON the corner point, where overflow-hidden would clip). The
          bracket below is card chrome, not a child, so its position never
          depends on the control's box math. */}
      <NodeResizeControl
        position="bottom-right"
        minWidth={MIN_W}
        minHeight={MIN_H}
        autoScale={false} // hitbox scales with the card, exactly like the bracket
        style={{
          background: 'transparent',
          border: 'none',
          width: 40,
          height: 40,
          left: 'auto',
          top: 'auto',
          right: 0,
          bottom: 0,
          // xyflow's stylesheet centers the handle on the corner via the CSS
          // `translate` property (not transform) — kill it or the hitbox sits
          // half outside the card, where overflow-hidden eats it.
          translate: 'none',
        }}
      />
      <div className="resize-grip" />

      {meta.ask && (
        <div className="nodrag absolute inset-x-3 bottom-3 flex items-center gap-2.5 rounded-md border border-status-blocked bg-popover/95 px-3.5 py-2.5 font-mono text-xs text-popover-foreground">
          <span className="flex-1 truncate">
            {meta.ask.detail}
          </span>
          <Button
            size="sm"
            className="bg-status-done text-terminal hover:bg-status-done/90"
            onClick={() => data.onDecide(id, meta.ask!.askId, 'allow')}
          >
            Allow
          </Button>
          <Button
            size="sm"
            className="bg-status-blocked text-terminal hover:bg-status-blocked/90"
            onClick={() => data.onDecide(id, meta.ask!.askId, 'deny')}
          >
            Deny
          </Button>
        </div>
      )}
    </div>
  )
}
