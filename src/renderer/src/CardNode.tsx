import { useEffect, useRef } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { Button } from '@/components/ui/button'
import type { CardStatus, PermissionAskInfo } from '../../shared/types'

const COLS = 100
const ROWS = 28

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
  detail?: string
  task?: string
  model?: string
  permissionMode?: string
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
  const { meta } = data
  const color = STATUS_COLORS[meta.status]

  useEffect(() => {
    const term = new Terminal({
      cols: COLS,
      rows: ROWS,
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
    term.open(termRef.current!)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // DOM renderer fallback — fine for a handful of cards
    }
    const offData = window.canvas.onPtyData((cardId, d) => {
      if (cardId === id) term.write(d)
    })
    const input = term.onData((d) => window.canvas.write(id, d))
    window.canvas.resize(id, COLS, ROWS)
    return () => {
      themeObserver.disconnect()
      offData()
      input.dispose()
      term.dispose()
    }
  }, [id])

  const folderName = data.folder.split('/').filter(Boolean).pop() ?? data.folder

  return (
    <div
      className="relative overflow-hidden rounded-2xl border-2 bg-card shadow-2xl"
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

      <div
        className="nodrag nowheel p-1.5"
        ref={termRef}
        // Fly-in rule: while an ask is held the terminal shows no dialog, so
        // engaging with the terminal releases it to the native dialog.
        onMouseDown={() => {
          if (meta.ask) window.canvas.releaseAsks(id)
        }}
      />

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
