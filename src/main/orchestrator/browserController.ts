// The main-process owner of browser-card readiness — the keystone the rest of
// browser agency v2 builds on. A browser card's <webview> lives in the renderer,
// but main needs to know, deterministically, when a given card's guest is mounted
// and its DOM is ready (and, for Tier B, what its WebContents id is).
//
// Today it does one job: turn the renderer's `browser-ready` signal into an
// awaitable `ensureReady(cardId)`, so browser tools wait on a real event instead
// of a fixed delay (it replaces request_browser's 700ms sleep). Phase 1 grows
// this object into the full BrowserController — a CDP driver keyed off the
// WebContents id recorded here, with the renderer path as fallback. See
// BROWSER_AGENCY_V2_PLAN.md §§1–2.

interface BrowserState {
  /** The guest's WebContents id (for Tier-B CDP), or null once torn down. */
  webContentsId: number | null
  /** dom-ready reached and the guest is live. */
  ready: boolean
}

export class BrowserController {
  private readonly states = new Map<string, BrowserState>()
  /** Resolvers waiting for a card to become ready, by cardId. */
  private readonly waiters = new Map<string, Array<() => void>>()

  /** The renderer reported a guest reached dom-ready (or re-navigated). Records
   *  its WebContents id and wakes anyone awaiting readiness. */
  markReady(cardId: string, webContentsId: number): void {
    this.states.set(cardId, { webContentsId, ready: true })
    const waiting = this.waiters.get(cardId)
    if (waiting) {
      this.waiters.delete(cardId)
      for (const resolve of waiting) resolve()
    }
  }

  /** The renderer tore the guest down (card closed, or — later — went dormant). */
  markGone(cardId: string): void {
    this.states.set(cardId, { webContentsId: null, ready: false })
  }

  /** The live WebContents id for a card's guest, or null if not ready. */
  webContentsIdFor(cardId: string): number | null {
    const s = this.states.get(cardId)
    return s?.ready ? s.webContentsId : null
  }

  /** Resolve once the card's guest is ready to be read/driven. Returns
   *  immediately if it already is; rejects if no readiness arrives in time
   *  (e.g. the card never mounted). Replaces the old fixed settle delay. */
  ensureReady(cardId: string, timeoutMs = 8000): Promise<void> {
    if (this.states.get(cardId)?.ready) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const remove = (): void => {
        const arr = this.waiters.get(cardId)
        if (!arr) return
        const i = arr.indexOf(wake)
        if (i >= 0) arr.splice(i, 1)
      }
      const timer = setTimeout(() => {
        remove()
        reject(new Error(`browser ${cardId} did not become ready within ${timeoutMs}ms`))
      }, timeoutMs)
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const arr = this.waiters.get(cardId) ?? []
      arr.push(wake)
      this.waiters.set(cardId, arr)
    })
  }
}
