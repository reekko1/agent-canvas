import { useRef } from 'react'
import { useReactFlow, useViewport } from '@xyflow/react'
import type { CanvasNode } from '@/canvas/nodes'
import { frameMembers, nodeRect } from './geometry'

/// The frames' labels — constant-size chips in a screen-space layer above the
/// cards (port of the Swift FrameLabelOverlay), so they stay readable and
/// reachable at any zoom. Drag a chip to move its frame and members, click
/// (no drag) to fit the camera to the group, double-click to rename,
/// right-click to delete. Clamped to the viewport so a big frame's label
/// never scrolls out of reach; fully off-screen frames drop their chip.
export function FrameChips({
  nodes,
  setNodes,
  onRename,
  onDelete,
}: {
  nodes: CanvasNode[]
  setNodes: (updater: (ns: CanvasNode[]) => CanvasNode[]) => void
  onRename: (frameId: string, name: string) => void
  onDelete: (frameId: string) => void
}) {
  const viewport = useViewport()
  const { fitBounds } = useReactFlow()

  const drag = useRef<{
    frameId: string
    startClientX: number
    startClientY: number
    zoom: number
    moved: boolean
    starts: Map<string, { x: number; y: number }>
  } | null>(null)

  const frames = nodes.filter((n) => n.type === 'frame')

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {frames.map((frame) => {
        const rect = nodeRect(frame)
        const { x: vx, y: vy, zoom } = viewport
        const screen = {
          x: rect.x * zoom + vx,
          y: rect.y * zoom + vy,
          w: rect.w * zoom,
          h: rect.h * zoom,
        }
        // Frame fully off-screen → drop the chip.
        if (screen.x + screen.w < 0 || screen.y + screen.h < 0) return null
        if (screen.x > window.innerWidth || screen.y > window.innerHeight) return null

        // Top clamp clears the hiddenInset traffic lights AND the h-12 window
        // drag strip (z-20, above this layer) — a chip pinned under either is
        // hidden and/or unclickable.
        const pad = 8
        const topPad = 48
        const left = Math.min(Math.max(screen.x + 12, pad), window.innerWidth - 160)
        const top = Math.min(Math.max(screen.y + 12, topPad), window.innerHeight - 44)

        const members = frameMembers(frame, nodes)
        const loud = members.some(
          (m) => m.type === 'card' && (m.data.meta.status === 'blocked' || m.data.meta.status === 'error'),
        )

        return (
          <div
            key={frame.id}
            className="pointer-events-auto absolute flex select-none items-center gap-2 rounded-xl border bg-muted px-2.5 py-1.5 font-mono text-[13px] font-semibold shadow-lg"
            style={{ left, top }}
            title="Drag to move · click to zoom to frame · double-click to rename · right-click to delete"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.currentTarget.setPointerCapture(e.pointerId)
              drag.current = {
                frameId: frame.id,
                startClientX: e.clientX,
                startClientY: e.clientY,
                zoom: viewport.zoom,
                moved: false,
                // Snapshot the frame AND its members at the pre-move position.
                starts: new Map(
                  [frame, ...members].map((n) => [n.id, { ...n.position }]),
                ),
              }
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (!d || d.frameId !== frame.id) return
              const dxs = e.clientX - d.startClientX
              const dys = e.clientY - d.startClientY
              if (!d.moved && Math.hypot(dxs, dys) < 4) return
              d.moved = true
              const dx = dxs / d.zoom
              const dy = dys / d.zoom
              setNodes((ns) =>
                ns.map((n) => {
                  const start = d.starts.get(n.id)
                  return start ? { ...n, position: { x: start.x + dx, y: start.y + dy } } : n
                }),
              )
            }}
            onPointerUp={() => {
              const d = drag.current
              drag.current = null
              if (d && !d.moved) {
                // Click (no drag) → fit the camera to the group.
                void fitBounds(
                  { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
                  { duration: 600, padding: 0.12 },
                )
              }
            }}
            onDoubleClick={() => {
              const name = prompt('Frame name', frame.data.name as string)
              if (name?.trim()) onRename(frame.id, name.trim())
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              if (confirm(`Delete frame “${frame.data.name}”? Its cards stay on the canvas.`)) {
                onDelete(frame.id)
              }
            }}
          >
            <span className="h-3 w-3 rounded-[4px] border-[1.6px] border-muted-foreground" />
            <span className="text-foreground">{frame.data.name as string}</span>
            <span className="rounded-full border px-1.5 text-[10.5px] text-muted-foreground">
              {members.length}
            </span>
            {loud && (
              <span className="rounded-full border border-status-blocked/45 bg-status-blocked/15 px-1.5 text-[9px] text-status-blocked">
                NEEDS YOU
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
