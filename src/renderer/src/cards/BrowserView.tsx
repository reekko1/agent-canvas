import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
import { registerBrowser } from './browserBridge'
import { READ_SCRIPT, buildActionScript } from '@shared/browserDriver'

/// The card's live web view: the browser analogue of TerminalView. Owns an
/// Electron <webview> guest (its own process, the `persist:browser` session) and
/// the address bar that drives it. Created imperatively once on mount and never
/// torn down across face switches — like the xterm instance, the guest's page,
/// scroll, and login state survive stacking and project switches; `hidden` only
/// toggles compositing (visibility, not display, so layout/size stay valid).
///
/// A browser card has NO tmux/pty/spine session — nothing here touches
/// window.canvas.ensureCard. Navigation, title, favicon, and the blur snapshot
/// are reported up via `onNavigate` so the node (and persistence) track them.

/** Best-effort URL normalization for the address bar: bare hosts get https://,
 *  anything already schemed (http, https, about:, file:…) passes through. */
function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s
  return `https://${s}`
}

export function BrowserView({
  cardId,
  url,
  goto,
  hidden,
  interactive,
  dormant,
  onNavigate,
}: {
  cardId: string
  /** The page to load on mount (the persisted/last-navigated url). */
  url?: string
  /** An imperative navigation request (orchestrator-driven): load `url` each
   *  time `nonce` changes. The address bar drives the webview directly instead. */
  goto?: { url: string; nonce: number }
  /** True while a poster covers the card (stacked): the guest stays mounted and
   *  alive, only compositing stops — and a blur snapshot is captured. */
  hidden: boolean
  /** False while stacked: the address bar is inert and the promote button owns
   *  the cursor (clicks fall through to promote, never into the page). */
  interactive: boolean
  /** Evicted to free resources (webview budget): the guest is NOT mounted at all
   *  (its process/GL context released); the snapshot face covers the card. The
   *  guest re-mounts and reloads `url` when this clears (a wake). Only ever set on
   *  non-master browsers, which are already covered by their face. */
  dormant: boolean
  onNavigate: (
    cardId: string,
    patch: { url?: string; title?: string; favicon?: string; snapshot?: string },
  ) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<WebviewTag | null>(null)
  const [address, setAddress] = useState(url ?? '')
  const [editing, setEditing] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false, loading: false })

  // Build the <webview> guest once (imperatively — it isn't a typed JSX element,
  // and createElement lets us set the creation-time `partition` before attach).
  // No `allowpopups`: window.open / target=_blank are dropped in v1, so the host
  // can keep denying uncontrolled BrowserWindows. Inline listeners infer their
  // event types from the WebviewTag overloads and die with the element on unmount.
  useEffect(() => {
    // Dormant (evicted): mount no guest at all — the snapshot face covers the
    // card. Re-running this effect when `dormant` clears (a wake) recreates the
    // guest and reloads `url`; in-page state (scroll/forms) is lost, login is not
    // (shared persist:browser partition).
    if (dormant) return
    const view = document.createElement('webview') as unknown as WebviewTag
    view.setAttribute('partition', 'persist:browser')
    view.style.width = '100%'
    view.style.height = '100%'
    view.src = url && url.length > 0 ? normalizeUrl(url) : 'about:blank'

    const syncNav = (): void => {
      try {
        setNav((n) => ({ ...n, back: view.canGoBack(), forward: view.canGoForward() }))
      } catch {
        // canGoBack/Forward throw before the guest attaches — ignore until dom-ready.
      }
    }
    const track = (u: string): void => {
      setAddress(u)
      onNavigate(cardId, { url: u })
      syncNav()
    }
    view.addEventListener('did-navigate', (e) => track(e.url))
    view.addEventListener('did-navigate-in-page', (e) => {
      if (e.isMainFrame) track(e.url)
    })
    view.addEventListener('page-title-updated', (e) => onNavigate(cardId, { title: e.title }))
    view.addEventListener('page-favicon-updated', (e) => {
      if (e.favicons[0]) onNavigate(cardId, { favicon: e.favicons[0] })
    })
    view.addEventListener('did-start-loading', () => setNav((n) => ({ ...n, loading: true })))
    view.addEventListener('did-stop-loading', () => {
      setNav((n) => ({ ...n, loading: false }))
      syncNav()
    })
    // dom-ready is the readiness signal: the DOM is parsed and the guest has a
    // WebContents id. Report it up so browser tools wait on this instead of a
    // fixed delay (and Tier-B CDP learns the id). Re-fires on each navigation.
    view.addEventListener('dom-ready', () => {
      syncNav()
      try {
        window.canvas.browserReady(cardId, view.getWebContentsId())
      } catch {
        // getWebContentsId throws before attach — the next dom-ready will report.
      }
    })

    hostRef.current!.appendChild(view)
    viewRef.current = view
    // Expose the guest for orchestrator/agent-driven see-and-control. capturePage
    // works while stacked; executeJavaScript runs the Tier-A driver in the page.
    const unregister = registerBrowser(cardId, {
      screenshot: async () => (await view.capturePage()).toDataURL(),
      read: async () => await view.executeJavaScript(READ_SCRIPT),
      act: async (action) => await view.executeJavaScript(buildActionScript(action), true),
    })
    return () => {
      unregister()
      window.canvas.browserReady(cardId, null) // the guest is going away
      view.remove() // drops the guest process and its listeners with it
      viewRef.current = null
    }
    // Re-mounts only on identity change or a dormancy flip — a stacked/master
    // toggle (hidden) keeps the same guest, so the page survives.
  }, [cardId, dormant])

  // Capture a thumbnail the moment the card is demoted from master (hidden flips
  // false → true). The guest keeps a live offscreen surface while CSS-hidden, so
  // capturePage stays valid; the result feeds the stacked BrowserFace.
  const wasHidden = useRef(hidden)
  useEffect(() => {
    const view = viewRef.current
    if (view && hidden && !wasHidden.current) {
      view
        .capturePage()
        .then((img) => onNavigate(cardId, { snapshot: img.resize({ width: 640 }).toDataURL() }))
        .catch(() => {})
    }
    wasHidden.current = hidden
  }, [hidden, cardId, onNavigate])

  // Orchestrator-driven navigation: load the requested url each time the nonce
  // advances. Seeded with the mount-time nonce so the initial `src` isn't
  // double-loaded; the address bar uses `go()` directly and never touches this.
  const lastGoto = useRef(goto?.nonce ?? 0)
  useEffect(() => {
    if (!goto || goto.nonce === lastGoto.current) return
    lastGoto.current = goto.nonce
    const next = normalizeUrl(goto.url)
    setAddress(next)
    viewRef.current?.loadURL(next).catch(() => {})
  }, [goto])

  const go = (raw: string): void => {
    const next = normalizeUrl(raw)
    setEditing(false)
    setAddress(next)
    viewRef.current?.loadURL(next).catch(() => {})
  }

  return (
    <div
      className="flex h-full w-full flex-col bg-card"
      style={{ visibility: hidden ? 'hidden' : 'visible' }}
    >
      {/* Address bar — the focused card's browser chrome. Inert when stacked. */}
      <div
        className={`flex items-center gap-1.5 border-b border-border/60 bg-muted px-2 py-1.5 ${
          interactive ? '' : 'pointer-events-none'
        }`}
      >
        <button
          className="rounded p-1 text-muted-foreground enabled:hover:bg-border disabled:opacity-30"
          disabled={!nav.back}
          onClick={() => viewRef.current?.goBack()}
          title="Back"
          aria-label="Back"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <button
          className="rounded p-1 text-muted-foreground enabled:hover:bg-border disabled:opacity-30"
          disabled={!nav.forward}
          onClick={() => viewRef.current?.goForward()}
          title="Forward"
          aria-label="Forward"
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-border"
          onClick={() => viewRef.current?.reload()}
          title="Reload"
          aria-label="Reload"
        >
          <RotateCw className={`size-3.5 ${nav.loading ? 'animate-spin' : ''}`} />
        </button>
        <input
          className="min-w-0 flex-1 rounded bg-card px-2 py-1 font-mono text-xs text-foreground outline-none ring-1 ring-border focus:ring-primary"
          value={address}
          placeholder="Enter a URL"
          spellCheck={false}
          onChange={(e) => {
            setEditing(true)
            setAddress(e.target.value)
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go((e.target as HTMLInputElement).value)
            else if (e.key === 'Escape' && editing) (e.target as HTMLInputElement).blur()
          }}
        />
      </div>
      {/* The guest is appended here imperatively. */}
      <div ref={hostRef} className="relative min-h-0 flex-1" />
    </div>
  )
}
