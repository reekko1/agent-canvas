// Shared geometry constants for the canvas (port of the Swift CanvasLayout).
// Centralized so views and persistence agree on sizes without passing them.

/** Default on-canvas size of a card. */
export const CARD_W = 960
export const CARD_H = 640

/** Smallest a card may be resized to — keeps a terminal usable. */
export const MIN_CARD_W = 360
export const MIN_CARD_H = 240

/** Gap between cards in the new-card placement grid. */
export const CARD_GAP = 80
