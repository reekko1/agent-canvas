import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { CanvasNode } from './nodes'

/// How many browser <webview> guests stay live at once. The rest are evicted to
/// dormant (guest dropped, GL/process freed, snapshot face shown) and woken on
/// demand. Caps per-webview cost so a big fleet doesn't choke — kept well under
/// Chromium's ~16-WebGL-context ceiling, which browsers share with terminals.
const BROWSER_BUDGET = 6

/// Owns the app-wide browser webview budget: a recency rank per browser (higher
/// = more recent), bumped on promote / spawn / wake, plus the per-browser scan
/// pulse. `selectDormant` ranks every browser (the active master always wins)
/// and evicts the lowest past the budget — every browser holds resources
/// regardless of which canvas parks it. Reads the live node set through
/// `nodesRef` so the kind-aware close path can ask `isBrowserCard` without a
/// per-render resubscribe.
export function useBrowserBudget(nodesRef: MutableRefObject<CanvasNode[]>) {
  // Recency rank per browser, bumped on promote / spawn / wake. A monotonic
  // counter (not a clock) gives stable ordering; the lowest-ranked browsers
  // past the budget go dormant.
  const [browserRecency, setBrowserRecency] = useState<Map<string, number>>(() => new Map())
  const recencyTick = useRef(0)
  // Keyed on the id prefix (not the node's `kind`) on purpose: this fires for a
  // freshly spawned browser before its node is in `nodesRef`, and from promote
  // where only the id is in hand. The recency map stays browser-only by skipping
  // non-`browser-` ids; the authoritative `kind` drives the session-aware paths.
  const bumpBrowser = useCallback((cardId: string) => {
    if (!cardId.startsWith('browser-')) return
    setBrowserRecency((prev) => new Map(prev).set(cardId, (recencyTick.current += 1)))
  }, [])

  /** A card is a browser by its authoritative `kind` — the discriminant the rest
   *  of the canvas keys on. Used for the session-less close path (a browser has no
   *  tmux/pty to kill, and killing one logs a missing-session error). */
  const isBrowserCard = useCallback(
    (id: string): boolean =>
      nodesRef.current.some((n) => n.id === id && n.type === 'card' && n.data.kind === 'browser'),
    [nodesRef],
  )

  // Per-browser scan pulse: a nonce bumped each time a card's page is captured
  // (browser_screenshot), passed to CardNode to (re)play the one-shot scan sweep.
  const [scanPulse, setScanPulse] = useState<Map<string, number>>(() => new Map())
  const scanTick = useRef(0)

  // Main needs a dormant browser driven — bump it to most-recent so the budget
  // brings it back live (its guest remounts and reloads).
  useEffect(() => window.canvas.onBrowserWake((cardId) => bumpBrowser(cardId)), [bumpBrowser])
  // A browser's page was screenshotted — bump its pulse to play the scan sweep.
  useEffect(
    () =>
      window.canvas.onBrowserScan((cardId) =>
        setScanPulse((prev) => new Map(prev).set(cardId, (scanTick.current += 1))),
      ),
    [],
  )

  // Keep the BROWSER_BUDGET most-recent browser guests live (the active master
  // always wins), evict the rest to dormant. Takes the partitioned card set +
  // master id so it stays in sync with the layout without owning it.
  const selectDormant = useCallback(
    (cardNodes: CanvasNode[], masterCardId: string | undefined): Set<string> => {
      const ids = cardNodes.flatMap((n) => (n.data.kind === 'browser' ? [n.id] : []))
      if (ids.length <= BROWSER_BUDGET) return new Set<string>()
      const ranked = [...ids].sort((a, b) => {
        const ra = a === masterCardId ? Infinity : (browserRecency.get(a) ?? 0)
        const rb = b === masterCardId ? Infinity : (browserRecency.get(b) ?? 0)
        return rb - ra
      })
      return new Set(ranked.slice(BROWSER_BUDGET))
    },
    [browserRecency],
  )

  return { bumpBrowser, isBrowserCard, scanPulse, selectDormant }
}
