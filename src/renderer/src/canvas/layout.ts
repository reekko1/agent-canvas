// Master-stack layout geometry (fixed viewport — no pan/zoom). The canvas
// derives every card's rect from these + the window size + which card is the
// master, so nothing about position is persisted.

/** Top strip reserved for the window-drag region and the toolbars. */
export const TOP_STRIP = 56
/** Outer padding around the whole layout. */
export const PAD = 12
/** Left inset for the master card. Clears the floating left toolbar — pill's
 *  right edge sits at ~62px (left-3 + p-1.5 + border + a 36px icon button) —
 *  with roughly the same gap on the inside (~14px) as the toolbar has to the
 *  window edge (~12px), so the toolbar reads as centered in its own channel. */
export const LEFT_GUTTER = 76
/** The stack column takes this fraction of the window width, clamped. */
export const STACK_FRACTION = 0.3
export const STACK_MIN = 320
export const STACK_MAX = 560
/** Fixed height of a stacked (poster) card; the column scrolls past this. */
export const STACK_CARD_H = 220
/** Gap between stacked cards, and between master and the stack column. */
export const GAP = 12

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Width of the stack column for a given window width. */
export function stackWidth(W: number): number {
  return Math.round(Math.min(STACK_MAX, Math.max(STACK_MIN, W * STACK_FRACTION)))
}

/** The master slot rect — full content area when there's no stack, otherwise
 *  the left region beside the stack column. */
export function masterRect(W: number, H: number, hasStack: boolean): Rect {
  const right = hasStack ? W - stackWidth(W) - GAP : W - PAD
  return { x: LEFT_GUTTER, y: TOP_STRIP, w: right - LEFT_GUTTER, h: H - TOP_STRIP - PAD }
}

/** The rect for the i-th stacked card (before scroll offset is applied). */
export function stackSlot(W: number, i: number): Rect {
  const sw = stackWidth(W)
  return {
    x: W - sw + PAD,
    y: TOP_STRIP + i * (STACK_CARD_H + GAP),
    w: sw - PAD - PAD,
    h: STACK_CARD_H,
  }
}

/** Total scrollable height of the stack column for `count` cards. */
export function stackContentHeight(count: number): number {
  return count * (STACK_CARD_H + GAP)
}
