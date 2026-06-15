import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { terminalTheme } from '@/lib/theme'

/// The card's live terminal: owns the xterm instance and its addons, mirrors
/// the theme, follows the card's pixel size, and is the one place the agent's
/// pty gets spawned (on mount, after subscribing — no byte can outrun us).
///
/// Mouse model — "a normal terminal", deliberately: tmux has mouse on, but
/// the ONLY mouse events it ever receives are wheel reports we synthesize.
/// Its mouse-tracking requests are stripped from the stream before xterm
/// sees them, so xterm never enters mouse-report mode: drag/double-click
/// selection is native and local, a click clears it, Cmd-C copies.
/// Scrolling up puts tmux in copy-mode (where the history lives); typing
/// snaps back to live first.

/** DECSET/DECRST params that switch a terminal into mouse-report mode. */
const MOUSE_MODES = new Set(['9', '1000', '1001', '1002', '1003', '1005', '1006', '1015', '1016'])

/** A streaming filter that removes mouse-tracking enables/disables from the
 *  pty stream (and holds back a chunk-spanning partial sequence until the
 *  rest arrives). Everything else passes through untouched. */
function makeMouseModeFilter(): (chunk: string) => string {
  let pending = ''
  return (chunk) => {
    let s = pending + chunk
    pending = ''
    const tail = s.match(/\x1b(\[\??[\d;]*)?$/)
    if (tail) {
      pending = s.slice(tail.index!)
      s = s.slice(0, tail.index!)
    }
    return s.replace(/\x1b\[\?([\d;]+)([hl])/g, (all, params: string, hl: string) => {
      const kept = (params.split(';') as string[]).filter((p) => !MOUSE_MODES.has(p))
      if (kept.length === params.split(';').length) return all
      return kept.length ? `\x1b[?${kept.join(';')}${hl}` : ''
    })
  }
}
export function TerminalView({
  cardId,
  folder,
  kind,
  hidden,
  interactive,
  onEngage,
}: {
  cardId: string
  folder: string
  kind: 'agent' | 'shell'
  /** True while the poster covers the card (stacked). visibility, not
   *  display: layout holds the card's size and xterm keeps consuming the
   *  stream; only compositing stops. */
  hidden: boolean
  /** False while the card is compact/stacked: the terminal is inert so a drag
   *  can't start an xterm selection instead of clicking through to promote.
   *  Only the master (engaged) terminal takes the cursor. */
  interactive: boolean
  onEngage: () => void
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
    // Coalesce a burst of size changes — grip-resize today, the master-stack
    // tiling animation later — into ONE fit once motion settles. A naive
    // fit-per-callback runs ~60×/s during a continuous resize, and every fit's
    // onResize SIGWINCHes the pty (tmux and the claude TUI both reflow), which
    // thrashes the agent. A trailing debounce keeps resetting while the size is
    // still moving, so the single fit lands after the animation/drag stops. The
    // mount-time fit above stays immediate, so the pty spawns correctly sized.
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
    const stripMouseModes = makeMouseModeFilter()
    const offData = window.canvas.onPtyData((id, d) => {
      if (id === cardId) term.write(stripMouseModes(d))
    })

    // Wheel → synthesized SGR reports, straight to the pty: tmux scrolls its
    // history (xterm has none behind tmux's alternate screen). One report per
    // line; coords are moot for a single-pane session. Direct-spawn fallback
    // (no tmux): the app just ignores them — nothing regresses.
    let wheelCarry = 0
    let inScrollback = false
    term.attachCustomWheelEventHandler((e) => {
      const cell = term.element ? term.element.clientHeight / term.rows : 17
      wheelCarry += e.deltaMode === 1 ? e.deltaY : e.deltaY / cell
      const lines = Math.trunc(wheelCarry)
      wheelCarry -= lines
      if (lines !== 0) {
        if (lines < 0) inScrollback = true
        const n = Math.min(Math.abs(lines), 40)
        window.canvas.write(cardId, `\x1b[<${lines < 0 ? 64 : 65};1;1M`.repeat(n))
      }
      return false // no arrow-key fallback, no local viewport scroll
    })

    // Typing while scrolled snaps back to live first (normal-terminal
    // behavior): cancel copy-mode server-side, then deliver the keystroke —
    // the chain keeps key bursts ordered behind that round-trip. Esc and
    // arrow-right are pure "back to the input" gestures while scrolled:
    // swallowed after the exit (a forwarded Esc would interrupt the agent;
    // a forwarded arrow would nudge the input cursor).
    const EXIT_ONLY = new Set([
      '\x1b', // Esc
      '\x1b[C', // arrow right
      '\x1bOC', // arrow right, application cursor mode
    ])
    let writes: Promise<void> = Promise.resolve()
    const input = term.onData((d) => {
      const wasScrolled = inScrollback
      inScrollback = false
      writes = writes.then(async () => {
        if (wasScrolled) {
          await window.canvas.leaveScrollback(cardId)
          if (EXIT_ONLY.has(d)) return
        }
        window.canvas.write(cardId, d)
      })
    })

    // Spawn (or reattach to) the agent only now that the terminal is
    // subscribed — no byte of output can outrun the listener.
    void window.canvas.ensureCard(cardId, folder, term.cols, term.rows, kind)
    return () => {
      if (settle) clearTimeout(settle)
      refit.disconnect()
      themeObserver.disconnect()
      offData()
      gridChange.dispose()
      input.dispose()
      term.dispose()
    }
  }, [cardId, folder, kind])

  return (
    <div
      className={`h-full p-3 ${interactive ? '' : 'pointer-events-none'}`}
      style={{ visibility: hidden ? 'hidden' : 'visible' }}
      // Fly-in rule: while an ask is held (toast up), the terminal shows no
      // dialog — engaging the terminal releases it to the native dialog.
      onMouseDown={onEngage}
    >
      <div ref={termRef} className="h-full w-full" />
    </div>
  )
}
