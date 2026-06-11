// Shared geometry constants for the canvas (port of the Swift CanvasLayout).
// Centralized so views and persistence agree on sizes without passing them.

/** Default on-canvas size of a card. */
export const CARD_W = 960
export const CARD_H = 640

/** Default on-canvas size of a diff object — a touch wider than a card for
 *  its two-pane split. */
export const DIFF_W = 1100
export const DIFF_H = 720

/** Smallest an item may be resized to — keeps a terminal or two-pane usable. */
export const MIN_CARD_W = 360
export const MIN_CARD_H = 240

/** Smallest a frame may be resized to. */
export const MIN_FRAME_W = 260
export const MIN_FRAME_H = 200

/** Gap between cards in the new-card placement grid. */
export const CARD_GAP = 80

/** Never zoom past 1:1 — card document units equal terminal native pixels,
 *  so 1.0 is exactly crisp and anything above is upscale blur. */
export const MAX_ZOOM = 1.0

/** Breathing room added around content when computing the "fit all" bounds. */
export const CONTENT_MARGIN = 120
