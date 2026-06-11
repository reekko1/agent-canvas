import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { terminalTheme } from '@/lib/theme'

/// The card's live terminal: owns the xterm instance and its addons, mirrors
/// the theme, follows the card's pixel size, and is the one place the agent's
/// pty gets spawned (on mount, after subscribing — no byte can outrun us).
export function TerminalView({
  cardId,
  folder,
  hidden,
  holdsAsk,
}: {
  cardId: string
  folder: string
  /** True while the poster covers the card (far zoom). visibility, not
   *  display: layout holds the card's size and xterm keeps consuming the
   *  stream; only compositing stops. */
  hidden: boolean
  holdsAsk: boolean
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
    // card resize, and mirror the resulting cols/rows into the pty (tmux and
    // the claude TUI reflow from the SIGWINCH).
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(termRef.current!)
    fit.fit()
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // DOM renderer fallback — fine for a handful of cards
    }
    const refit = new ResizeObserver(() => fit.fit())
    refit.observe(termRef.current!)
    const gridChange = term.onResize(({ cols, rows }) => window.canvas.resize(cardId, cols, rows))
    const offData = window.canvas.onPtyData((id, d) => {
      if (id === cardId) term.write(d)
    })
    const input = term.onData((d) => window.canvas.write(cardId, d))
    // Spawn (or reattach to) the agent only now that the terminal is
    // subscribed — no byte of output can outrun the listener.
    void window.canvas.ensureCard(cardId, folder, term.cols, term.rows)
    return () => {
      refit.disconnect()
      themeObserver.disconnect()
      offData()
      gridChange.dispose()
      input.dispose()
      term.dispose()
    }
  }, [cardId, folder])

  return (
    <div
      className="nodrag nowheel h-full p-3"
      style={{ visibility: hidden ? 'hidden' : 'visible' }}
      // Fly-in rule: while an ask is held the terminal shows no dialog, so
      // engaging with the terminal releases it to the native dialog.
      onMouseDown={() => {
        if (holdsAsk) window.canvas.releaseAsks(cardId)
      }}
    >
      <div ref={termRef} className="h-full w-full" />
    </div>
  )
}
