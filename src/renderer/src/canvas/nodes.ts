import type { CardData } from '@/cards/meta'

/// A card on the canvas. Shell cards are `card` nodes with
/// `data.kind === 'shell'`. Diffs are NOT nodes — they render as a side sheet
/// from the canvas's `openDiff` state, never from this array.
export type CanvasNode = { id: string; type: 'card'; data: CardData }
