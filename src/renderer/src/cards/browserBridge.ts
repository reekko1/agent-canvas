// A module-level registry of live browser-card control handles, keyed by cardId.
//
// A browser card's <webview> lives in the renderer (BrowserView), but the
// orchestrator's drive commands (read/screenshot/act) arrive in Canvas's
// orchestrator-command handler. Rather than thread per-card refs through the node
// tree, BrowserView registers an imperative handle here on mount and drops it on
// unmount; the command handler looks the card up and calls into it. This mirrors
// the "ref-for-stable-subscription" pattern used across the canvas — a small
// decoupled seam instead of prop drilling.
//
// This is the renderer half of the shared BrowserController (BROWSER_AGENCY_PLAN
// §2): Tier A drives the webview tag directly here. Tier B now ships too —
// main's BrowserController drives the page over CDP (background-capable input) —
// so this handle is the Tier-A fallback the bus reaches for when CDP is
// unavailable (no live guest, can't attach), not a future tier.
import type { BrowserAction, BrowserActionResult, BrowserSnapshot } from '@shared/types'

export interface BrowserHandle {
  /** A PNG data URL of the current page (works while the card is stacked). */
  screenshot(): Promise<string>
  /** The set-of-marks observation of the current page. */
  read(): Promise<BrowserSnapshot>
  /** Perform a mutating action; resolves with an ok/message result. */
  act(action: BrowserAction): Promise<BrowserActionResult>
}

const handles = new Map<string, BrowserHandle>()

/** Register a card's control handle; returns an unregister fn for cleanup. The
 *  identity check on unregister avoids a remount race clobbering a fresh handle. */
export function registerBrowser(cardId: string, handle: BrowserHandle): () => void {
  handles.set(cardId, handle)
  return () => {
    if (handles.get(cardId) === handle) handles.delete(cardId)
  }
}

/** The live handle for a browser card, or undefined if its view isn't mounted. */
export function getBrowser(cardId: string): BrowserHandle | undefined {
  return handles.get(cardId)
}
