import type { Node } from '@xyflow/react'
import type { CardData } from '@/cards/meta'
import type { DiffData } from '@/diff/DiffNode'
import type { FrameData } from '@/frames/FrameNode'

/// Everything that can live on the canvas. `type` is the discriminant —
/// narrow on it before touching `data`. (Shell cards are `card` nodes with
/// `data.kind === 'shell'`, mirroring the Swift CardRole.)
export type CanvasNode =
  | Node<CardData, 'card'>
  | Node<DiffData, 'diff'>
  | Node<FrameData, 'frame'>
