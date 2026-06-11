import { NodeResizeControl } from '@xyflow/react'
import { MIN_CARD_H, MIN_CARD_W } from '@/canvas/layout'

/// The card's resize affordance (port of the Swift ResizeHandlesView, v1 =
/// bottom-right corner only): an invisible grab zone pinned fully inside the
/// corner, plus a bracket drawn as card chrome (.resize-grip in index.css) so
/// its position never depends on the control's box math. xyflow centers
/// handles ON the corner point, where the card's overflow-hidden would clip.
export function ResizeGrip() {
  return (
    <>
      <NodeResizeControl
        position="bottom-right"
        minWidth={MIN_CARD_W}
        minHeight={MIN_CARD_H}
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
          // xyflow's stylesheet centers the handle via the CSS `translate`
          // property (not transform) — kill it or the hitbox sits half
          // outside the card, where overflow-hidden eats it.
          translate: 'none',
        }}
      />
      <div className="resize-grip" />
    </>
  )
}
