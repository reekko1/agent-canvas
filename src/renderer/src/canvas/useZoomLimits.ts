import { useEffect, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { nodeRect, type Rect } from '@/frames/geometry'
import { CARD_H, CARD_W, CONTENT_MARGIN, MAX_ZOOM } from './layout'
import type { CanvasNode } from './nodes'

/** Absolute zoom-out safety net (the original's 0.02). */
const ABS_MIN_ZOOM = 0.02
/** Lower = can zoom out further past "content fits the window" (more margin).
 *  At the floor, content occupies this fraction of the window — 0.75 keeps
 *  the overview much tighter than the original's 0.4. */
const MAX_ZOOM_OUT_FACTOR = 0.75

/** The bounding box of everything on the canvas (cards, diffs, frames) with
 *  breathing-room margin — what the zoom-out floor is measured against. Falls
 *  back to a nominal home box when empty so the floor is always defined. */
function contentBounds(nodes: CanvasNode[]): Rect {
  if (nodes.length === 0) {
    return { x: -CARD_W, y: -CARD_H, w: CARD_W * 2, h: CARD_H * 2 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    const r = nodeRect(n)
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return {
    x: minX - CONTENT_MARGIN,
    y: minY - CONTENT_MARGIN,
    w: maxX - minX + CONTENT_MARGIN * 2,
    h: maxY - minY + CONTENT_MARGIN * 2,
  }
}

/// Content-relative zoom-out floor (port of the Swift Viewport.updateLimits):
/// pulling back further than "all items + margin at 40% of the window" feels
/// lost, so the floor follows the content — one card barely zooms out, a
/// spread fleet zooms way out. Re-clamped on every node change and window
/// resize; a camera already below a rising floor is pulled back in (the
/// NSScrollView did that implicitly — d3 only clamps future gestures).
export function useZoomLimits(nodes: CanvasNode[]) {
  const { getViewport, zoomTo } = useReactFlow()
  const [minZoom, setMinZoom] = useState(ABS_MIN_ZOOM)

  useEffect(() => {
    const update = () => {
      const r = contentBounds(nodes)
      const fit = Math.min(window.innerWidth / r.w, window.innerHeight / r.h)
      // Floor capped at MAX_ZOOM: a lone tiny item on a huge display could
      // push fit*factor past 1.0, which would invert the [min, max] extent.
      const next = Math.min(MAX_ZOOM, Math.max(ABS_MIN_ZOOM, fit * MAX_ZOOM_OUT_FACTOR))
      setMinZoom((prev) => (Math.abs(prev - next) < 1e-3 ? prev : next))

      const zoom = getViewport().zoom
      if (zoom < next - 1e-3) void zoomTo(next, { duration: 200 })
      else if (zoom > MAX_ZOOM + 1e-3) void zoomTo(MAX_ZOOM, { duration: 200 })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [nodes, getViewport, zoomTo])

  return minZoom
}
