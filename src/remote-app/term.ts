import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/// A full-screen terminal for one card: an xterm wired to the card's tmux
/// session over a WebSocket (/term). It's a SECOND tmux client, so it mirrors
/// the desktop live — type here, it lands there. An accessory bar supplies the
/// keys a soft keyboard lacks (Esc/Tab/Ctrl-C/arrows), which the claude TUI
/// leans on.

// Control sequences the on-screen keyboard can't produce.
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
    `<div class="term-keys">${KEYS.map((k, i) => `<button data-k="${i}">${k.label}</button>`).join('')}</div>`
  overlay.querySelector('.term-name')!.textContent = name
  document.body.appendChild(overlay)
  const host = overlay.querySelector('.term-host') as HTMLElement
  const stateEl = overlay.querySelector('#ts') as HTMLElement

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

  const url = new URL('term', location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('card', cardId)
  url.searchParams.set('cols', String(term.cols))
  url.searchParams.set('rows', String(term.rows))
  const ws = new WebSocket(url)

  const send = (m: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }
  ws.onopen = () => {
    stateEl.textContent = 'live'
    fit.fit()
    send({ r: [term.cols, term.rows] })
    term.focus()
  }
  ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '')
  ws.onclose = () => {
    stateEl.textContent = 'closed'
  }
  ws.onerror = () => {
    stateEl.textContent = 'error'
  }

  term.onData((d) => send({ i: d }))
  term.onResize(() => send({ r: [term.cols, term.rows] }))

  // Refit when the soft keyboard opens/closes or the device rotates.
  const refit = (): void => {
    try {
      fit.fit()
    } catch {
      /* host detached */
    }
  }
  window.addEventListener('resize', refit)
  window.visualViewport?.addEventListener('resize', refit)

  overlay.querySelectorAll('[data-k]').forEach((b) =>
    b.addEventListener('click', () => {
      send({ i: KEYS[Number((b as HTMLElement).dataset.k)].seq })
      term.focus()
    }),
  )

  const close = (): void => {
    window.removeEventListener('resize', refit)
    window.visualViewport?.removeEventListener('resize', refit)
    try {
      ws.close()
    } catch {
      /* already closing */
    }
    term.dispose()
    overlay.remove()
    active = null
  }
  overlay.querySelector('.term-back')!.addEventListener('click', close)
  active = close
}
