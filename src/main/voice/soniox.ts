// Soniox real-time voice for the orchestrator: one STT socket (push-to-talk mic
// → text) and one TTS socket per spoken reply (text → audio). Both live here in
// main so the SONIOX_API_KEY never reaches the renderer — the renderer only ships
// raw mic PCM up and plays the PCM that comes back, all over IPC.
//
// STT: wss://stt-rt.soniox.com — send a JSON config, then stream raw pcm_s16le
// bytes; tokens stream back with an `is_final` flag. Push-to-talk uses MANUAL
// finalization (no endpoint detection): on release we send {"type":"finalize"},
// collect the finalized tokens, and the `<fin>` marker ends the utterance.
//
// TTS: wss://tts-rt.soniox.com — send a JSON config (voice + pcm_s16le @ 24k),
// then the whole reply as one text chunk with text_end; base64 PCM streams back
// until `terminated`. A new reply (or the user talking) cancels the current one.
import WebSocket from 'ws'
import { loadSonioxKey } from './keyStore'
import type { OrchestratorEvent } from '../../shared/types'

const STT_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
const TTS_URL = 'wss://tts-rt.soniox.com/tts-websocket'
const STT_MODEL = 'stt-rt-v5'
const TTS_MODEL = 'tts-rt-v1'
const TTS_VOICE = 'Grace'
// Audio rates. The renderer declares its own matching CAPTURE_RATE/PLAYBACK_RATE
// (voice.ts) — these are not a shared export, just this side's copy of the contract.
const STT_SAMPLE_RATE = 16000
const TTS_SAMPLE_RATE = 24000

/** Marker tokens Soniox emits to delimit utterances — never user-visible text. */
const MARKERS = new Set(['<fin>', '<end>'])

function apiKey(): string | undefined {
  return loadSonioxKey()
}

/** The STT opening-handshake config, single-sourced so validation and a live
 *  session state the same contract. Pass `endpointDetection` for a session
 *  (push-to-talk drives finalization itself, so it's false); validation omits it
 *  since it sends no audio. */
function sttConfig(key: string, endpointDetection?: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = {
    api_key: key,
    model: STT_MODEL,
    audio_format: 'pcm_s16le',
    sample_rate: STT_SAMPLE_RATE,
    num_channels: 1,
  }
  if (endpointDetection !== undefined) config.enable_endpoint_detection = endpointDetection
  return config
}

/** Drop all listeners and close a socket, ignoring an already-closing error. */
function closeWs(ws: WebSocket | null): void {
  if (!ws) return
  ws.removeAllListeners()
  try {
    ws.close()
  } catch {
    /* already closing */
  }
}

/** Confirm a key works before storing it, by doing the STT opening handshake:
 *  an invalid key is rejected with an error within a beat; a good key is accepted
 *  by the server's silence (it waits for audio), which the timeout treats as OK.
 *  Used by the onboarding "Save" so a typo never gets persisted. */
export function validateSonioxKey(key: string): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    const trimmed = key.trim()
    if (!trimmed) {
      resolve({ ok: false, message: 'Enter your Soniox API key.' })
      return
    }
    const ws = new WebSocket(STT_URL)
    let settled = false
    const finish = (r: { ok: boolean; message?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeWs(ws)
      resolve(r)
    }
    // Opened, sent config, no rejection — the key is good (server now awaits audio).
    const timer = setTimeout(() => finish({ ok: true }), 2000)
    ws.on('open', () => ws.send(JSON.stringify(sttConfig(trimmed))))
    ws.on('message', (data) => {
      try {
        const res = JSON.parse(data.toString()) as { error_code?: number; error_message?: string }
        if (res.error_code != null) {
          finish({ ok: false, message: res.error_message || 'Soniox rejected this key.' })
        } else {
          finish({ ok: true })
        }
      } catch {
        /* non-JSON frame — ignore, let the timeout accept */
      }
    })
    ws.on('error', () => finish({ ok: false, message: 'Could not reach Soniox — check your connection.' }))
  })
}

export interface VoiceDeps {
  /** Live transcript while the user holds to talk (finalized text + interim). */
  onPartial: (text: string) => void
  /** The finished utterance after finalize — the prompt to submit. */
  onFinal: (text: string) => void
  /** STT failed or no key — surface a hint, the session is already gone. */
  onError: (message: string) => void
  /** A chunk of TTS audio: raw little-endian pcm_s16le, mono, @TTS_SAMPLE_RATE. */
  onTtsAudio: (pcm: Buffer) => void
  /** Barge-in / new reply — the renderer should drop any queued/playing audio. */
  onTtsReset: () => void
}

export class SonioxVoice {
  private stt: WebSocket | null = null
  /** Concatenated text of every final token this utterance (interim is recomputed
   *  per message and never accumulated). */
  private sttFinal = ''
  /** Audio buffered before the socket finished opening — flushed on 'open'. */
  private sttPending: Buffer[] = []
  private sttOpen = false

  // One spoken utterance (one narrated line) at a time. Speech-pacing in the
  // orchestrator guarantees the previous line has finished before the next tool
  // runs and the next line begins, so there's no overlap to manage — no queue.
  private ttsSocket: WebSocket | null = null
  private ttsReady = false
  private ttsStreamId = ''
  /** Text that arrived before the socket finished opening. */
  private ttsPending: string[] = []
  /** speakEnd arrived before the socket opened — finalize once it's open. */
  private ttsFinish = false
  private ttsSeq = 0

  // --- Speech-pacing state -------------------------------------------------
  // Holds a mutating action until the line just narrated has actually been heard,
  // so the action (and its comet) land with the words. `playing` is fed by the
  // renderer's TtsPlayer over IPC; `narrationPending` is set when a line is spoken.
  private playing = false
  private narrationPending = false
  private readonly pacingWaiters = new Set<(playing: boolean) => void>()

  constructor(private readonly deps: VoiceDeps) {}

  /** Voice is usable only when a key is present; the UI greys out the mic. */
  get available(): boolean {
    return !!apiKey()
  }

  // --- Speech-to-text (push-to-talk) ---------------------------------------

  /** Open a fresh STT session for one push-to-talk utterance. */
  startStt(): void {
    const key = apiKey()
    if (!key) {
      this.deps.onError('Set SONIOX_API_KEY to use voice.')
      return
    }
    this.closeStt() // never run two at once — a stale socket would interleave tokens
    this.sttFinal = ''
    this.sttPending = []
    this.sttOpen = false
    const ws = new WebSocket(STT_URL)
    this.stt = ws
    ws.on('open', () => {
      // Push-to-talk finalizes on release, so endpoint detection is off here.
      ws.send(JSON.stringify(sttConfig(key, false)))
      this.sttOpen = true
      for (const buf of this.sttPending) ws.send(buf)
      this.sttPending = []
    })
    ws.on('message', (data) => this.onSttMessage(ws, data))
    ws.on('error', (e) => {
      if (this.stt !== ws) return
      this.deps.onError(e instanceof Error ? e.message : String(e))
      this.closeStt()
    })
  }

  /** Feed one chunk of mic audio (raw pcm_s16le @STT_SAMPLE_RATE) to the session. */
  pushAudio(pcm: Buffer): void {
    const ws = this.stt
    if (!ws) return
    if (this.sttOpen && ws.readyState === WebSocket.OPEN) ws.send(pcm)
    else this.sttPending.push(pcm) // still opening — flushed in order on 'open'
  }

  /** Release: stop sending audio and ask Soniox to finalize everything pending.
   *  The utterance is emitted from onSttMessage when the `<fin>` marker lands. */
  finishStt(): void {
    const ws = this.stt
    if (!ws) return
    if (this.sttOpen && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'finalize' }))
    } else {
      // Never finished opening — nothing to finalize; drop it.
      this.closeStt()
    }
  }

  /** Abandon the current STT session without emitting a transcript (abort). */
  cancelStt(): void {
    this.closeStt()
  }

  private onSttMessage(ws: WebSocket, data: WebSocket.RawData): void {
    if (this.stt !== ws) return
    let res: {
      tokens?: { text?: string; is_final?: boolean }[]
      finished?: boolean
      error_code?: number
      error_message?: string
    }
    try {
      res = JSON.parse(data.toString())
    } catch {
      return
    }
    if (res.error_code != null) {
      this.deps.onError(`${res.error_code} ${res.error_message ?? 'stt error'}`)
      this.closeStt()
      return
    }
    let interim = ''
    let done = !!res.finished
    for (const t of res.tokens ?? []) {
      const text = t.text
      if (!text) continue
      if (MARKERS.has(text)) {
        if (text === '<fin>') done = true // finalize complete — utterance is whole
        continue
      }
      if (t.is_final) this.sttFinal += text
      else interim += text
    }
    this.deps.onPartial((this.sttFinal + interim).trim())
    if (done) {
      this.deps.onFinal(this.sttFinal.trim())
      this.closeStt()
    }
  }

  private closeStt(): void {
    const ws = this.stt
    this.stt = null
    this.sttOpen = false
    this.sttPending = []
    closeWs(ws)
  }

  // --- Text-to-speech ------------------------------------------------------

  /** Begin a spoken line: open a socket and send the voice config. Text streams in
   *  via speakChunk; the previous line has already finished (speech-pacing), so any
   *  lingering socket is just closed without disturbing the player. */
  speakStart(): void {
    const key = apiKey()
    if (!key) return
    this.closeSocket()
    this.ttsReady = false
    this.ttsPending = []
    this.ttsFinish = false
    const streamId = `tts-${++this.ttsSeq}`
    this.ttsStreamId = streamId
    const ws = new WebSocket(TTS_URL)
    this.ttsSocket = ws
    ws.on('open', () => {
      if (this.ttsSocket !== ws) return
      ws.send(
        JSON.stringify({
          api_key: key,
          model: TTS_MODEL,
          voice: TTS_VOICE,
          language: 'en',
          audio_format: 'pcm_s16le',
          sample_rate: TTS_SAMPLE_RATE,
          stream_id: streamId,
        }),
      )
      this.ttsReady = true
      for (const t of this.ttsPending) {
        ws.send(JSON.stringify({ text: t, text_end: false, stream_id: streamId }))
      }
      this.ttsPending = []
      if (this.ttsFinish) ws.send(JSON.stringify({ text: '', text_end: true, stream_id: streamId }))
    })
    ws.on('message', (data) => {
      if (this.ttsSocket !== ws) return
      let res: { audio?: string; terminated?: boolean; error_code?: number }
      try {
        res = JSON.parse(data.toString())
      } catch {
        return
      }
      if (res.error_code != null) {
        this.closeSocket()
        return
      }
      if (res.audio) this.deps.onTtsAudio(Buffer.from(res.audio, 'base64'))
      if (res.terminated) this.closeSocket()
    })
    ws.on('error', () => {
      if (this.ttsSocket === ws) this.closeSocket()
    })
  }

  /** Feed the next piece of text into the current line. */
  speakChunk(text: string): void {
    if (!text) return
    const ws = this.ttsSocket
    if (!ws) return
    if (this.ttsReady && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ text, text_end: false, stream_id: this.ttsStreamId }))
    } else {
      this.ttsPending.push(text) // still opening — flushed in order on 'open'
    }
  }

  /** Close the input side; the line's audio finishes and the socket terminates. */
  speakEnd(): void {
    const ws = this.ttsSocket
    if (!ws) return
    if (this.ttsReady && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ text: '', text_end: true, stream_id: this.ttsStreamId }))
    } else {
      this.ttsFinish = true
    }
  }

  /** One-shot convenience — the non-streamed fallback path. */
  speak(text: string): void {
    const line = text.trim()
    if (!line) return
    this.speakStart()
    this.speakChunk(line)
    this.speakEnd()
  }

  /** Speak a streamed orchestrator turn from its typed events: only assistant
   *  lines are voiced — `start`/`delta`/`final` stream a line, a non-streamed
   *  assistant line speaks at once. Marking `narrationPending` here (for both the
   *  streamed and one-shot paths) is what keeps speech-pacing in lockstep with
   *  what's actually spoken. */
  speakEvent(e: OrchestratorEvent): void {
    if (e.kind !== 'assistant') return
    if (e.phase === 'start') {
      this.speakStart()
    } else if (e.phase === 'delta') {
      this.speakChunk(e.text)
      if (this.available && e.text) this.narrationPending = true
    } else if (e.phase === 'final') {
      this.speakEnd()
    } else if (e.text) {
      this.speak(e.text)
      if (this.available) this.narrationPending = true
    }
  }

  // --- Speech-pacing -------------------------------------------------------

  /** The renderer's player reports the spoken reply started/stopped playing. */
  setPlaying(playing: boolean): void {
    this.playing = playing
    for (const w of [...this.pacingWaiters]) w(playing)
  }

  /** Resolve once the voice has spoken the narration emitted so far — it started
   *  playing and then drained. No-op when voice is unavailable or nothing is
   *  pending; guarded so a TTS that never starts can't wedge a turn. */
  awaitCaughtUp(): Promise<void> {
    if (!this.available || !this.narrationPending) return Promise.resolve()
    this.narrationPending = false
    return new Promise((resolve) => {
      let started = this.playing
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        this.pacingWaiters.delete(handler)
        clearTimeout(startTimer)
        clearTimeout(capTimer)
        resolve()
      }
      const handler = (playing: boolean): void => {
        if (playing) started = true
        else if (started) finish() // played, then drained → the line has been heard
      }
      this.pacingWaiters.add(handler)
      // If audio never begins (TTS error/slow), don't hold the action hostage.
      const startTimer = setTimeout(() => {
        if (!started) finish()
      }, 1000)
      const capTimer = setTimeout(finish, 20000) // hard safety against a wedge
    })
  }

  /** Stop speaking now (barge-in or app teardown) and flush the renderer's audio. */
  cancelSpeak(): void {
    if (this.ttsSocket) this.deps.onTtsReset()
    this.closeSocket()
  }

  private closeSocket(): void {
    const ws = this.ttsSocket
    this.ttsSocket = null
    this.ttsReady = false
    this.ttsPending = []
    this.ttsFinish = false
    closeWs(ws)
  }

  /** Tear down every socket at app exit. */
  dispose(): void {
    this.closeStt()
    this.closeSocket()
  }
}
