import type { CardData } from '@/cards/meta'

/// A card on the canvas. Shell cards are `card` nodes with
/// `data.kind === 'shell'`. The diff is NOT a node — it's a built-in side sheet
/// driven by the active canvas's `dir`, never from this array.
export type CanvasNode = { id: string; type: 'card'; data: CardData }
