import type { OrchestratorEvent, OrchestratorMode } from '@shared/types'
import { $, esc } from './util'
import { initOrch, sendJSON, sendBinary, type ConnState } from './orch'
import { MicCapture, TtsPlayer } from './voice'

/// The orchestrator chat — the phone's home view. Mirrors the desktop chat bar
/// without React: a streamed message log, an input bar with push-to-talk, a mode
/// badge, the working pulse, and the manual-mode confirm gate. Talks to the same
/// shared session over orch.ts; voice reuses the vendored MicCapture/TtsPlayer.

type Kind = OrchestratorEvent['kind'] // 'assistant' | 'tool' | 'result' | 'error' | 'auto' | 'mode'
type MsgKind = Exclude<Kind, 'tool'> | 'you' // 'tool' only drives the pulse, never a row

// Leading glyph per row kind — mirrors the desktop ChatBar GLYPH table.
const GLYPH: Record<MsgKind, string> = {
  you: '›',
  assistant: '✶',
  result: '✶',
  error: '✗',
  auto: '⚡',
  mode: '⚙',
}

const MODE_ORDER: OrchestratorMode[] = ['manual', 'partner', 'autonomous']

// ---- Module state (survives view switches; the socket may come and go) ----
let log: HTMLElement
let bar: HTMLElement
let input: HTMLInputElement
let micBtn: HTMLElement
let modeBadge: HTMLElement
let connPill: HTMLElement
let confirmHost: HTMLElement

let mode: OrchestratorMode = 'manual'
let voiceAvailable = false
let lastText = '' // for the result-echo dedup (a result that repeats the final line)
let streamNode: HTMLElement | null = null
let streamText = ''
let currentConfirmId: number | null = null

const player = new TtsPlayer()
let mic: MicCapture | null = null
let recording = false

// ---- Message log -----------------------------------------------------------
function addMsg(kind: MsgKind, text: string): HTMLElement {
  const row = document.createElement('div')
  row.className = `msg msg-${kind}`
  row.innerHTML = `<span class="g">${GLYPH[kind]}</span><span class="t">${esc(text)}</span>`
  log.appendChild(row)
  log.scrollTop = log.scrollHeight
  return row
}
function setRowText(row: HTMLElement, text: string): void {
  const t = row.querySelector('.t')
  if (t) t.textContent = text
  log.scrollTop = log.scrollHeight
}

// ---- Streamed assistant line (start → delta → final) -----------------------
function startStream(): void {
  streamText = ''
  streamNode = addMsg('assistant', '')
}
function appendStream(chunk: string): void {
  streamText += chunk
  if (streamNode) setRowText(streamNode, streamText)
}
function finalizeStream(full: string): void {
  const text = full || streamText
  if (streamNode) setRowText(streamNode, text)
  lastText = text
  streamNode = null
  streamText = ''
}

function setThinking(on: boolean): void {
  bar.classList.toggle('is-working', on)
}

// ---- Inbound orchestrator events -------------------------------------------
function onEvent(e: OrchestratorEvent): void {
  switch (e.kind) {
    case 'assistant':
      if (e.phase === 'start') startStream()
      else if (e.phase === 'delta') appendStream(e.text)
      else if (e.phase === 'final') finalizeStream(e.text)
      else {
        addMsg('assistant', e.text) // non-streamed assistant line
        lastText = e.text
      }
      break
    case 'tool':
      setThinking(true)
      break
    case 'result':
      setThinking(false)
      // A result that just repeats the final assistant line is noise — drop it.
      if (e.text && e.text !== lastText) addMsg('result', e.text)
      break
    case 'error':
      setThinking(false)
      addMsg('error', e.text)
      break
    case 'auto':
      addMsg('auto', e.text)
      break
    case 'mode':
      addMsg('mode', e.text)
      break
  }
}

// ---- Mode badge ------------------------------------------------------------
function paintMode(): void {
  modeBadge.textContent = mode
  modeBadge.className = `chat-mode mode-${mode}`
}
function setMode(next: OrchestratorMode, fromServer: boolean): void {
  mode = next
  paintMode()
  if (!fromServer) sendJSON({ t: 'mode', mode })
}
function cycleMode(): void {
  const i = MODE_ORDER.indexOf(mode)
  setMode(MODE_ORDER[(i + 1) % MODE_ORDER.length], false)
}

// ---- Confirm gate ----------------------------------------------------------
function showConfirm(id: number, title: string, detail: string): void {
  currentConfirmId = id
  confirmHost.innerHTML =
    `<div class="orch-confirm"><div class="oc-head"><span class="oc-dot"></span>` +
    `<span class="oc-title">${esc(title)}</span></div>` +
    `<div class="oc-detail">${esc(detail)}</div>` +
    `<div class="oc-acts">` +
    `<button class="allow" data-confirm="allow">Allow</button>` +
    `<button class="deny" data-confirm="deny">Deny</button></div></div>`
}
function clearConfirm(id?: number): void {
  if (id != null && id !== currentConfirmId) return
  currentConfirmId = null
  confirmHost.innerHTML = ''
}

// ---- Voice -----------------------------------------------------------------
function startRecording(): void {
  if (recording || !voiceAvailable) return
  recording = true
  micBtn.classList.add('recording')
  player.unlock() // resume the audio context on the gesture (iOS)
  player.reset() // local barge-in: cut the spoken reply instantly
  sendJSON({ t: 'stt-start' })
  mic = new MicCapture()
  mic.start((pcm) => sendBinary(pcm)).catch(() => {
    addMsg('error', 'Microphone unavailable.')
    sendJSON({ t: 'stt-cancel' })
    endRecordingUI()
  })
}
function endRecordingUI(): void {
  recording = false
  micBtn.classList.remove('recording')
  mic?.stop()
  mic = null
}
function finishRecording(): void {
  if (!recording) return
  endRecordingUI()
  sendJSON({ t: 'stt-finish' }) // utterance finalizes server-side → stt-final
}
function cancelRecording(): void {
  if (!recording) return
  endRecordingUI()
  sendJSON({ t: 'stt-cancel' })
}

// ---- Send ------------------------------------------------------------------
function submitText(raw: string): void {
  const text = raw.trim()
  if (!text) return
  addMsg('you', text)
  sendJSON({ t: 'prompt', text })
  input.value = ''
  setThinking(true)
}

export function initChat(): void {
  log = $('chat-log')
  bar = $('chat-bar')
  input = $('chat-input') as HTMLInputElement
  micBtn = $('chat-mic')
  modeBadge = $('chat-mode')
  connPill = $('chat-conn')
  confirmHost = $('chat-confirm')
  paintMode()

  // Compose / send.
  $('chat-send').addEventListener('click', () => submitText(input.value))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitText(input.value)
    }
  })
  modeBadge.addEventListener('click', cycleMode)

  // Push-to-talk: press-and-hold (no ⌥ on mobile). Pointer events cover touch +
  // mouse; force-stop on cancel/leave/blur/hide so a missed pointerup can't stick
  // recording on.
  micBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    // Capture the pointer so a slight finger drift off the button doesn't fire
    // pointerleave and cancel mid-utterance — pointerup/cancel still fire reliably.
    try {
      micBtn.setPointerCapture(e.pointerId)
    } catch {
      /* capture unsupported — pointerleave fallback below still guards */
    }
    startRecording()
  })
  micBtn.addEventListener('pointerup', (e) => {
    e.preventDefault()
    finishRecording()
  })
  micBtn.addEventListener('pointercancel', cancelRecording)
  window.addEventListener('blur', cancelRecording)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelRecording()
  })

  // Confirm gate buttons (delegated — the sheet is re-rendered per gate).
  confirmHost.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[data-confirm]') as HTMLElement | null
    if (!t || currentConfirmId == null) return
    sendJSON({ t: 'confirm', id: currentConfirmId, allow: t.dataset.confirm === 'allow' })
    clearConfirm()
  })

  // Keep the input bar above the soft keyboard (lifted from term.ts).
  const vv = window.visualViewport
  const layout = (): void => {
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    bar.style.transform = kb ? `translateY(-${kb}px)` : ''
  }
  vv?.addEventListener('resize', layout)
  vv?.addEventListener('scroll', layout)
  window.addEventListener('resize', layout)

  // TTS playback glow.
  player.listen(
    (active) => bar.classList.toggle('speaking', active),
    (level) => bar.style.setProperty('--voice-level', String(level)),
  )

  // Open the socket and route frames.
  initOrch({
    onTtsAudio: (pcm) => player.push(pcm),
    onConn: (state: ConnState) => {
      connPill.textContent = state === 'live' ? '' : state === 'reconnecting' ? 'reconnecting…' : 'offline'
      connPill.style.display = state === 'live' ? 'none' : 'inline'
    },
    onFrame: (f) => {
      switch (f.t) {
        case 'hello':
          setMode(f.mode, true)
          voiceAvailable = f.voiceAvailable
          micBtn.style.display = voiceAvailable ? '' : 'none'
          break
        case 'event':
          onEvent(f.event)
          break
        case 'mode':
          setMode(f.mode, true)
          break
        case 'confirm':
          showConfirm(f.id, f.title, f.detail)
          break
        case 'confirm-clear':
          clearConfirm(f.id)
          break
        case 'stt-partial':
          input.value = f.text
          break
        case 'stt-final':
          input.value = ''
          submitText(f.text)
          break
        case 'stt-error':
          addMsg('error', f.message)
          endRecordingUI()
          break
        case 'tts-reset':
          player.reset()
          break
      }
    },
  })
}
