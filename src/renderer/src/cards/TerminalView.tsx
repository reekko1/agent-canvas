import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { terminalTheme } from '@/lib/theme'

/// A shell card's live terminal: a direct pty (no tmux — agent cards are
/// headless sessions, see TranscriptView), so this is "a normal terminal"
/// with nothing to strip or synthesize: xterm's own local scrollback and
/// native mouse handling just work.
export function TerminalView({
  cardId,
  folder,
  interactive,
}: {
  cardId: string
  folder: string
  /** False while the card is compact/stacked: the terminal is inert so a drag
   *  can't start an xterm selection instead of clicking through to promote.
   *  Only the master (engaged) terminal takes the cursor. Stacked shells stay
   *  VISIBLE (the live terminal is their own preview) — only interactivity
   *  toggles. */
  interactive: boolean
}) {
  const termRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'Menlo, monospace',
      scrollback: 5000,
      theme: terminalTheme(),
    })
    // Re-resolve the terminal palette when dark/light flips on <html>.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    // The grid follows the card's pixel size: fit on mount, refit on every
    // card resize, and mirror the resulting cols/rows into the pty (the
    // shell reflows from the SIGWINCH).
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(termRef.current!)
    fit.fit()
    let webgl: WebglAddon | undefined
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl?.dispose())
      term.loadAddon(webgl)
    } catch {
      // DOM renderer fallback — fine for a handful of cards
    }
    // Coalesce a burst of size changes — grip-resize today, the master-stack
    // tiling animation later — into ONE fit once motion settles. A naive
    // fit-per-callback runs ~60×/s during a continuous resize, and every fit's
    // onResize SIGWINCHes the pty, which thrashes the shell. A trailing
    // debounce keeps resetting while the size is still moving, so the single
    // fit lands after the animation/drag stops. The mount-time fit above stays
    // immediate, so the pty spawns correctly sized.
    let settle: ReturnType<typeof setTimeout> | undefined
    const refit = new ResizeObserver(() => {
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => {
        settle = undefined
        fit.fit()
      }, 100)
    })
    refit.observe(termRef.current!)
    const gridChange = term.onResize(({ cols, rows }) => window.canvas.resize(cardId, cols, rows))
    const offData = window.canvas.onPtyData((id, d) => {
      if (id === cardId) term.write(d)
    })
    const input = term.onData((d) => window.canvas.write(cardId, d))

    // Spawn (or reattach to) the shell only now that the terminal is
    // subscribed — no byte of output can outrun the listener.
    void window.canvas.ensureShell(cardId, folder, term.cols, term.rows)
    return () => {
      if (settle) clearTimeout(settle)
      refit.disconnect()
      themeObserver.disconnect()
      offData()
      gridChange.dispose()
      input.dispose()
      webgl?.dispose()
      term.dispose()
    }
  }, [cardId, folder])

  return (
    <div className={`h-full p-3 ${interactive ? '' : 'pointer-events-none'}`}>
      <div ref={termRef} className="h-full w-full" />
    </div>
  )
}
