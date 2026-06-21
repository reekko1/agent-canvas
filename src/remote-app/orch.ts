import type { OrchClientFrame, OrchServerFrame } from '@shared/types'
import { ensureToken, dropToken } from './net'

/// The orchestrator transport: one WebSocket to /orch making the phone a second
/// client into the desktop's shared session. Text frames are JSON control/events
/// (OrchServerFrame); binary frames are raw TTS PCM. The single `dispatch` of a
/// parsed frame is the only place wire field names are read, so realigning to the
/// server stays one-file. Reconnects with capped backoff (the session is
/// long-lived, so — unlike /term — it keeps trying).

export type ConnState = 'live' | 'reconnecting' | 'down'

export interface OrchHandlers {
  /** A text control/event frame from main. */
  onFrame: (f: OrchServerFrame) => void
  /** A binary frame: one chunk of TTS audio (pcm_s16le @24kHz). */
  onTtsAudio: (pcm: Uint8Array) => void
  /** Connection state, for the chat bar's status pill. */
  onConn: (state: ConnState) => void
}

let socket: WebSocket | null = null
let handlers: OrchHandlers | null = null
let attempts = 0
let closing = false

export function initOrch(h: OrchHandlers): void {
  handlers = h
  closing = false
  void connect()
}

async function connect(): Promise<void> {
  if (closing) return
  let token: string
  try {
    token = await ensureToken()
  } catch {
    scheduleReconnect()
    return
  }
  if (closing) return
  const url = new URL('orch', location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  socket = ws
  ws.onopen = () => {
    attempts = 0
    handlers?.onConn('live')
  }
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let f: OrchServerFrame
      try {
        f = JSON.parse(e.data)
      } catch {
        return
      }
      handlers?.onFrame(f)
    } else {
      handlers?.onTtsAudio(new Uint8Array(e.data as ArrayBuffer))
    }
  }
  ws.onerror = () => {
    /* onclose follows */
  }
  ws.onclose = () => {
    socket = null
    // The desktop may have restarted and rotated its per-process token (which
    // also gates the upgrade) — drop it so the retry refetches a fresh one.
    dropToken()
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (closing) return
  attempts++
  handlers?.onConn(attempts > 4 ? 'down' : 'reconnecting')
  setTimeout(() => void connect(), Math.min(5000, 400 * attempts))
}

/** Send a JSON control frame (no-op if the socket isn't open). */
export function sendJSON(frame: OrchClientFrame): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
}

/** Send a binary frame — one chunk of mic PCM (pcm_s16le @16kHz). */
export function sendBinary(pcm: ArrayBuffer): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(pcm)
}
