import { useEffect, useRef } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { CardStatus, PermissionAskInfo } from '../../shared/types'

const COLS = 100
const ROWS = 28

// Mirrors the Swift CardStatus palette role-for-role (loud = blocked/error).
export const STATUS_COLORS: Record<CardStatus, string> = {
  idle: '#565f89',
  running: '#7aa2f7',
  waiting: '#e0af68',
  done: '#9ece6a',
  stalled: '#ff9e64',
  blocked: '#f7768e',
  error: '#db4b4b',
}

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
      theme: { background: '#16161e', foreground: '#c0caf5' },
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
      offData()
      input.dispose()
      term.dispose()
    }
  }, [id])

  const folderName = data.folder.split('/').filter(Boolean).pop() ?? data.folder

  return (
    <div
      style={{
        background: '#16161e',
        border: `2px solid ${color}`,
        borderRadius: 10,
        overflow: 'hidden',
        boxShadow: '0 10px 40px rgba(0,0,0,.55)',
        position: 'relative',
      }}
    >
      <div
        className="card-drag"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 12px',
          background: '#1f2030',
          color: '#a9b1d6',
          font: '12px Menlo',
          cursor: 'grab',
        }}
      >
        <span style={{ color, fontWeight: 700 }}>{meta.status.toUpperCase()}</span>
        <span style={{ color: '#565f89' }}>{folderName}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {meta.task ?? meta.detail ?? ''}
        </span>
        {meta.model && <span style={{ color: '#565f89' }}>{meta.model}</span>}
        {meta.permissionMode === 'bypassPermissions' && (
          <span style={{ color: '#db4b4b', fontWeight: 700 }}>BYPASS</span>
        )}
        <button
          className="nodrag"
          onClick={() => data.onClose(id)}
          title="Delete card (kills its tmux session)"
          style={{
            background: 'none',
            border: 'none',
            color: '#565f89',
            cursor: 'pointer',
            font: '14px Menlo',
          }}
        >
          ✕
        </button>
      </div>

      <div
        className="nodrag nowheel"
        ref={termRef}
        style={{ padding: 6 }}
        // Fly-in rule: while an ask is held the terminal shows no dialog, so
        // engaging with the terminal releases it to the native dialog.
        onMouseDown={() => {
          if (meta.ask) window.canvas.releaseAsks(id)
        }}
      />

      {meta.ask && (
        <div
          className="nodrag"
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            background: 'rgba(31,32,48,.97)',
            border: `1px solid ${STATUS_COLORS.blocked}`,
            borderRadius: 8,
            font: '12px Menlo',
            color: '#c0caf5',
          }}
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {meta.ask.detail}
          </span>
          <button
            onClick={() => data.onDecide(id, meta.ask!.askId, 'allow')}
            style={{
              background: '#9ece6a', color: '#16161e', border: 'none', borderRadius: 6,
              padding: '5px 14px', font: 'bold 12px Menlo', cursor: 'pointer',
            }}
          >
            Allow
          </button>
          <button
            onClick={() => data.onDecide(id, meta.ask!.askId, 'deny')}
            style={{
              background: '#f7768e', color: '#16161e', border: 'none', borderRadius: 6,
              padding: '5px 14px', font: 'bold 12px Menlo', cursor: 'pointer',
            }}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  )
}
