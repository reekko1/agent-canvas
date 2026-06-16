import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/// A full-screen terminal for one card: an xterm wired to the card's tmux
/// session over a WebSocket (/term). It's a SECOND tmux client, so it mirrors
/// the desktop live. The accessory bar supplies what a soft keyboard lacks —
/// a sticky Ctrl modifier, Esc/Tab/^C/arrows, and scroll (synthesised mouse
/// wheels that drive tmux copy-mode, since the history lives in tmux).

// Direct keys: tap → send this sequence as-is.
const KEYS: { label: string; seq: string }[] = [
  { label: 'esc', seq: '\x1b' },
  { label: 'tab', seq: '\t' },
  { label: '^C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
]
let active: (() => void) | null = null

export function openTerminal(cardId: string, name: string): void {
  active?.() // only one terminal at a time

  const overlay = document.createElement('div')
  overlay.className = 'term-overlay'
  overlay.innerHTML =
    `<div class="term-bar"><button class="term-back">‹ Canvases</button>` +
    `<span class="term-name"></span><span class="term-state" id="ts">connecting…</span></div>` +
    `<div class="term-host"></div>` +
    `<div class="term-keys">` +
    `<button data-mod="ctrl">ctrl</button>` +
    KEYS.map((k, i) => `<button data-k="${i}">${k.label}</button>`).join('') +
    `<button data-scroll="up">⤒</button><button data-scroll="down">⤓</button>` +
    `</div>`
  overlay.querySelector('.term-name')!.textContent = name
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden' // freeze the panel behind the terminal
  const host = overlay.querySelector('.term-host') as HTMLElement
  const stateEl = overlay.querySelector('#ts') as HTMLElement
  const ctrlBtn = overlay.querySelector('[data-mod="ctrl"]') as HTMLElement

  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12,
    cursorBlink: true,
    scrollback: 4000,
    theme: {
      background: '#13111c',
      foreground: '#eee9df',
      cursor: '#fbb636',
      selectionBackground: '#393744',
    },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)
  fit.fit()

  // ---- WebSocket with auto-reconnect ----
  let socket: WebSocket | null = null
  let closing = false
  let attempts = 0
  const send = (m: unknown): void => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m))
  }
  const connect = (): void => {
    const url = new URL('term', location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('card', cardId)
    url.searchParams.set('cols', String(term.cols))
    url.searchParams.set('rows', String(term.rows))
    const ws = new WebSocket(url)
    socket = ws
    ws.onopen = () => {
      attempts = 0
      stateEl.textContent = 'live'
      fit.fit()
      send({ r: [term.cols, term.rows] })
      term.focus()
    }
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '')
    ws.onerror = () => {
      stateEl.textContent = 'error'
    }
    ws.onclose = () => {
      if (closing) return
      if (attempts++ < 6) {
        stateEl.textContent = 'reconnecting…'
        setTimeout(connect, Math.min(2000, 400 * attempts))
      } else {
        stateEl.textContent = 'disconnected'
      }
    }
  }
  connect()

  // ---- Sticky Ctrl modifier: arms the next typed char as Ctrl+<char> ----
  let ctrl = false
  const setCtrl = (on: boolean): void => {
    ctrl = on
    ctrlBtn.classList.toggle('on', on)
  }
  term.onData((d) => {
    if (ctrl && d.length === 1) {
      const c = d.toUpperCase().charCodeAt(0)
      if (c >= 64 && c <= 95) d = String.fromCharCode(c & 0x1f) // @A-Z[\]^_ → control code
      setCtrl(false)
    }
    send({ i: d })
  })
  term.onResize(() => send({ r: [term.cols, term.rows] }))

  // ---- Scroll: natural touch/wheel → tmux copy-mode (server-side, resilient).
  // The terminal mirrors tmux's alternate screen, so there's no local
  // scrollback; we translate the gesture into {s:lines} (+back/−forward) and
  // the server drives copy-mode. Throttled so a drag doesn't flood tmux.
  const cellH = (): number => host.clientHeight / term.rows || 17
  let pend = 0
  let flushing: ReturnType<typeof setTimeout> | null = null
  const scrollBy = (lines: number): void => {
    if (!lines) return
    pend += lines
    if (flushing) return
    flushing = setTimeout(() => {
      const s = pend
      pend = 0
      flushing = null
      if (s) send({ s })
    }, 50)
  }
  let lastY: number | null = null
  let accum = 0
  let claimed = false
  host.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return
      lastY = e.touches[0].clientY
      accum = 0
      claimed = false
    },
    { passive: true },
  )
  host.addEventListener(
    'touchmove',
    (e) => {
      if (lastY == null || e.touches.length !== 1) return
      accum += e.touches[0].clientY - lastY
      lastY = e.touches[0].clientY
      if (!claimed && Math.abs(accum) > 6) claimed = true // a real drag, not a tap
      if (!claimed) return
      e.preventDefault()
      const ch = cellH()
      const lines = Math.trunc(accum / ch)
      if (lines) {
        accum -= lines * ch
        scrollBy(lines) // finger down (accum>0) → reveal older → scroll back
      }
    },
    { passive: false },
  )
  host.addEventListener('touchend', () => (lastY = null), { passive: true })
  host.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      scrollBy(Math.round(-e.deltaY / cellH()) || (e.deltaY < 0 ? 1 : -1))
    },
    { passive: false },
  )

  // The overlay stays full-screen (always covering the panel); we only pad its
  // bottom by the soft keyboard's height (layout viewport − visual viewport) so
  // the terminal + accessory bar sit just above the keyboard. Shrinking the
  // overlay itself would let the panel show through any gap.
  const vv = window.visualViewport
  const layout = (): void => {
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    overlay.style.paddingBottom = `${kb}px`
    try {
      fit.fit()
    } catch {
      /* host detached */
    }
  }
  vv?.addEventListener('resize', layout)
  vv?.addEventListener('scroll', layout)
  window.addEventListener('resize', layout)
  layout()

  // ---- Accessory bar ----
  overlay.querySelectorAll('[data-k]').forEach((b) =>
    b.addEventListener('click', () => {
      send({ i: KEYS[Number((b as HTMLElement).dataset.k)].seq })
      term.focus()
    }),
  )
  ctrlBtn.addEventListener('click', () => {
    setCtrl(!ctrl)
    term.focus()
  })
  overlay.querySelectorAll('[data-scroll]').forEach((b) =>
    b.addEventListener('click', () => {
      const page = Math.max(1, term.rows - 2)
      scrollBy((b as HTMLElement).dataset.scroll === 'up' ? page : -page)
    }),
  )

  const close = (): void => {
    closing = true
    vv?.removeEventListener('resize', layout)
    vv?.removeEventListener('scroll', layout)
    window.removeEventListener('resize', layout)
    try {
      socket?.close()
    } catch {
      /* already closing */
    }
    term.dispose()
    overlay.remove()
    document.body.style.overflow = ''
    active = null
  }
  overlay.querySelector('.term-back')!.addEventListener('click', close)
  active = close
}
