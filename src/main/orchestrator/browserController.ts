// The main-process owner of browser-card readiness — the keystone the rest of
// browser agency v2 builds on. A browser card's <webview> lives in the renderer,
// but main needs to know, deterministically, when a given card's guest is mounted
// and its DOM is ready (and, for Tier B, what its WebContents id is).
//
// It does two jobs:
//   1. Readiness — turn the renderer's `browser-ready` signal into an awaitable
//      `ensureReady(cardId)`, so browser tools wait on a real event instead of a
//      fixed delay (replacing request_browser's 700ms sleep).
//   2. Tier-B driving — implement BrowserDriver over the Chrome DevTools Protocol
//      (`webContents.debugger`), keyed off the WebContents id recorded in (1).
//      Reads reuse the shared in-page driver via `Runtime.evaluate`; actions issue
//      REAL, trusted `Input.*` events that work while the app is backgrounded
//      (unlike `sendInputEvent`). Methods throw when CDP is unavailable; the bus
//      then falls back to the Tier-A renderer path. See BROWSER_AGENCY_V2_PLAN §§1–2.
import { webContents, type WebContents } from 'electron'
import {
  READ_SCRIPT,
  resolveRefScript,
  selectAllScript,
  scrollScript,
  selectScript,
  historyScript,
} from '../../shared/browserDriver'
import type { BrowserAction, BrowserSnapshot } from '../../shared/types'
import type { BrowserDriver } from './mainBus'

interface BrowserState {
  /** The guest's WebContents id (for Tier-B CDP), or null once torn down. */
  webContentsId: number | null
  /** dom-ready reached and the guest is live. */
  ready: boolean
}

export class BrowserController implements BrowserDriver {
  private readonly states = new Map<string, BrowserState>()
  /** Resolvers waiting for a card to become ready, by cardId. */
  private readonly waiters = new Map<string, Array<() => void>>()

  /** `wake` asks the renderer to bring a dormant (evicted) browser back to life so
   *  it can be driven — without it, ensureReady would wait forever on a guest the
   *  renderer chose not to mount. Injected by the host (index.ts). */
  constructor(private readonly opts: { wake?: (cardId: string) => void } = {}) {}

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
    // Not ready — it may be newly spawned (mounting) or evicted (dormant). Nudge
    // the renderer to wake it; harmless for one that's already on its way up.
    this.opts.wake?.(cardId)
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

  // ── Tier-B (CDP) driver — implements BrowserDriver ─────────────────────────

  /** Read the page via the shared in-page driver, run through CDP Runtime.evaluate
   *  (main-side, works while stacked/backgrounded). Throws if CDP is unavailable
   *  so the bus can fall back to the renderer path. */
  async read(cardId: string): Promise<BrowserSnapshot> {
    const wc = await this.cdp(cardId)
    const res = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: READ_SCRIPT,
      returnByValue: true,
    })
    if (res?.exceptionDetails) throw new Error('browser read failed in page')
    return res.result.value as BrowserSnapshot
  }

  /** Perform an action with real, trusted input. The ref is resolved to on-screen
   *  coordinates in-page, then the click/keystroke is dispatched as a CDP Input.*
   *  event (background-capable). A stale ref is a normal failure, not a throw. */
  async act(cardId: string, action: BrowserAction): Promise<{ ok: boolean; message: string }> {
    const wc = await this.cdp(cardId)
    // No-ref ops run as a plain in-page evaluate (no coordinates needed).
    if (action.kind === 'scroll') {
      await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: scrollScript(action.direction),
        returnByValue: true,
      })
      return { ok: true, message: `scrolled ${action.direction}` }
    }
    if (action.kind === 'history') {
      await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: historyScript(action.action),
        returnByValue: true,
      })
      return { ok: true, message: action.action }
    }
    if (action.kind === 'select') {
      const r = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: selectScript(action.ref, action.value),
        returnByValue: true,
      })
      if (r?.result?.value === false) {
        return { ok: false, message: `stale-ref: no element ${action.ref} — read again first` }
      }
      return { ok: true, message: `selected ${action.value} in ${action.ref}` }
    }
    const resolved = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: resolveRefScript(action.ref),
      returnByValue: true,
    })
    const box = resolved?.result?.value as { x: number; y: number } | null
    if (!box) {
      return { ok: false, message: `stale-ref: no element ${action.ref} on the page — read again first` }
    }
    if (action.kind === 'click') {
      await this.clickAt(wc, box.x, box.y)
      return { ok: true, message: `clicked ${action.ref}` }
    }
    // type: a REAL click focuses the field first — programmatic el.focus() is
    // unreliable (many sites only enter an editable state on a pointer event),
    // which is why typing used to need a separate browser_click. Then optionally
    // select-all (so the text replaces), then real keystrokes.
    await this.clickAt(wc, box.x, box.y)
    if (action.clear) {
      await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: selectAllScript(action.ref),
        returnByValue: true,
      })
    }
    if (action.text) await wc.debugger.sendCommand('Input.insertText', { text: action.text })
    if (action.submit) await this.pressEnter(wc)
    return { ok: true, message: `typed into ${action.ref}` }
  }

  /** A PNG screenshot via CDP (data URL). */
  async screenshot(cardId: string): Promise<string> {
    const wc = await this.cdp(cardId)
    const res = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
    if (!res?.data) throw new Error('screenshot returned no data')
    return `data:image/png;base64,${res.data}`
  }

  /** Ensure the card's guest is ready and its debugger attached; returns its
   *  WebContents. Throws if there's no live guest or the debugger can't attach
   *  (e.g. DevTools holds the session) — the caller falls back to Tier A. */
  private async cdp(cardId: string): Promise<WebContents> {
    await this.ensureReady(cardId)
    const wcId = this.webContentsIdFor(cardId)
    if (wcId == null) throw new Error(`browser ${cardId} has no live web contents`)
    const wc = webContents.fromId(wcId)
    if (!wc || wc.isDestroyed()) throw new Error(`browser ${cardId} web contents is gone`)
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    return wc
  }

  private async clickAt(wc: WebContents, x: number, y: number): Promise<void> {
    const base = { x, y, button: 'left', clickCount: 1 }
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  }

  private async pressEnter(wc: WebContents): Promise<void> {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }
}
