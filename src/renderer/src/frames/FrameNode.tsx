import { useStore, type NodeProps } from '@xyflow/react'
import { ResizeGrip } from '@/cards/ResizeGrip'
import { MIN_FRAME_H, MIN_FRAME_W } from '@/canvas/layout'

export interface FrameData extends Record<string, unknown> {
  name: string
  /** Lit while a card is being dragged over this frame — the live "drop here
   *  to join" cue. Driven by the canvas during a node drag. */
  highlighted?: boolean
}

/// A frame's on-canvas body (port of the Swift FrameView): a calm dashed
/// rounded boundary drawn *behind* the cards. The body passes every hit
/// through to the pane (the node carries pointer-events: none) — only the
/// resize grip is interactive. The label is a separate constant-size overlay
/// (FrameChips) floating above the cards. The frame never glows.
export function FrameNode({ data }: NodeProps & { data: FrameData }) {
  // Compensate stroke width for zoom (quantized) so the boundary reads on
  // screen at any magnification — the god-view altitude that matters.
  const inv = useStore((s) => {
    const raw = Math.max(1, 1 / s.transform[2])
    return Math.pow(1.2, Math.round(Math.log(raw) / Math.log(1.2)))
  })
  const hl = data.highlighted ?? false

  return (
    <div
      className="h-full w-full rounded-[22px]"
      style={{
        borderStyle: 'dashed',
        borderWidth: Math.max(1.5, (hl ? 3 : 2) * inv),
        borderColor: hl
          ? 'color-mix(in srgb, var(--primary) 85%, transparent)'
          : 'color-mix(in srgb, var(--foreground) 20%, transparent)',
        background: hl
          ? 'color-mix(in srgb, var(--primary) 10%, transparent)'
          : 'color-mix(in srgb, var(--foreground) 3%, transparent)',
      }}
    >
      <ResizeGrip minWidth={MIN_FRAME_W} minHeight={MIN_FRAME_H} />
    </div>
  )
}
