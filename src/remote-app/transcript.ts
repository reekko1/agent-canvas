import type { TranscriptItem } from '@shared/types'
import { esc } from './util'

/// A full-screen READ-ONLY view of one agent card's conversation — the phone
/// analogue of the desktop's TranscriptView. Agent cards are headless
/// sessions now (no tmux, no terminal to mirror), so there is nothing to type
/// into from here; approvals/questions already cover phone-side interaction.
/// Polls `GET /transcript?card=` every 2s (ungated, like `/state`) while open.

let active: (() => void) | null = null

function formatCost(item: TranscriptItem): string {
  return typeof item.durationMs === 'number' ? `${Math.round(item.durationMs / 1000)}s` : ''
}

function itemHtml(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
      return `<div class="tx-row tx-user">${esc(item.text)}</div>`
    case 'assistant':
      return (
        `<div class="tx-row tx-assistant">${esc(item.text)}` +
        (item.streaming ? '<span class="tx-cursor">▍</span>' : '') +
        `</div>`
      )
    case 'tool':
      return `<div class="tx-row tx-tool${item.failed ? ' tx-tool-failed' : ''}">▸ ${esc(item.text)}</div>`
    case 'error':
      return `<div class="tx-row tx-error">${esc(item.text)}</div>`
    case 'system':
      return `<div class="tx-row tx-system">${esc(item.text)}</div>`
    case 'turn': {
      const cost = formatCost(item)
      return `<div class="tx-row tx-turn">${cost ? `<span>${esc(cost)}</span>` : ''}</div>`
    }
    default:
      return ''
  }
}

export function openTranscript(cardId: string, name: string): void {
  active?.() // only one overlay at a time (shared with term.ts's old behavior)

  const overlay = document.createElement('div')
  overlay.className = 'tx-overlay'
  overlay.innerHTML =
    `<div class="tx-bar"><button class="tx-back">‹ Canvases</button>` +
    `<span class="tx-name"></span><span class="tx-state" id="txs">loading…</span></div>` +
    `<div class="tx-body"></div>`
  overlay.querySelector('.tx-name')!.textContent = name
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden' // freeze the panel behind the overlay
  const body = overlay.querySelector('.tx-body') as HTMLElement
  const stateEl = overlay.querySelector('#txs') as HTMLElement

  // Auto-follow the bottom unless the user scrolled up to read history.
  let atBottom = true
  body.addEventListener('scroll', () => {
    atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48
  })

  const render = (items: TranscriptItem[]): void => {
    body.innerHTML = items.map(itemHtml).join('') || '<div class="tx-empty">no conversation yet</div>'
    if (atBottom) body.scrollTop = body.scrollHeight
  }

  let closed = false
  const tick = (): void => {
    fetch('transcript?card=' + encodeURIComponent(cardId))
      .then((r) => r.json())
      .then((items: unknown) => {
        if (closed) return
        stateEl.textContent = 'live'
        render(Array.isArray(items) ? (items as TranscriptItem[]) : [])
      })
      .catch(() => {
        if (!closed) stateEl.textContent = 'offline'
      })
  }
  tick()
  const interval = setInterval(tick, 2000)

  const close = (): void => {
    closed = true
    clearInterval(interval)
    overlay.remove()
    document.body.style.overflow = ''
    active = null
  }
  overlay.querySelector('.tx-back')!.addEventListener('click', close)
  active = close
}
