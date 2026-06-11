import { useRef, useState } from 'react'
import type { Rect } from './geometry'

/// A transparent screen-space capture layer for *drawing* a new frame by
/// dragging a rectangle (the Figma/Sketch gesture — port of the Swift
/// FrameDrawOverlay). Mounted only while the Frame tool is armed; it grabs
/// canvas drags, paints a live rubber-band, and on mouse-up reports the drawn
/// rect in screen coords (the canvas converts to document space). A too-small
/// drag — or a bare click — reports null, i.e. just cancel.
export function FrameDrawOverlay({ onCommit }: { onCommit: (rect: Rect | null) => void }) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const [rubber, setRubber] = useState<Rect | null>(null)

  const rectFrom = (a: { x: number; y: number }, x: number, y: number): Rect => ({
    x: Math.min(a.x, x),
    y: Math.min(a.y, y),
    w: Math.abs(x - a.x),
    h: Math.abs(y - a.y),
  })

  return (
    <div
      className="absolute inset-0 z-20 cursor-crosshair"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, y: e.clientY }
      }}
      onPointerMove={(e) => {
        if (start.current) setRubber(rectFrom(start.current, e.clientX, e.clientY))
      }}
      onPointerUp={(e) => {
        const s = start.current
        start.current = null
        setRubber(null)
        if (!s) return onCommit(null)
        const r = rectFrom(s, e.clientX, e.clientY)
        onCommit(Math.hypot(r.w, r.h) < 12 ? null : r) // tiny drag / bare click → cancel
      }}
    >
      {rubber && (
        <div
          className="absolute rounded-[22px] border-2 border-dashed"
          style={{
            left: rubber.x,
            top: rubber.y,
            width: rubber.w,
            height: rubber.h,
            borderColor: 'color-mix(in srgb, var(--primary) 90%, transparent)',
            background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
          }}
        />
      )}
    </div>
  )
}
