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

const STT_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
const TTS_URL = 'wss://tts-rt.soniox.com/tts-websocket'
const STT_MODEL = 'stt-rt-v5'
const TTS_MODEL = 'tts-rt-v1'
const TTS_VOICE = 'Grace'
/** Mic capture rate the renderer worklet emits; STT config must match. */
export const STT_SAMPLE_RATE = 16000
/** TTS output rate; the renderer's player must decode at exactly this rate. */
export const TTS_SAMPLE_RATE = 24000

/** Marker tokens Soniox emits to delimit utterances — never user-visible text. */
const MARKERS = new Set(['<fin>', '<end>'])

function apiKey(): string | undefined {
  return loadSonioxKey()
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
      ws.removeAllListeners()
      try {
        ws.close()
      } catch {
        /* already closing */
      }
      resolve(r)
    }
    // Opened, sent config, no rejection — the key is good (server now awaits audio).
    const timer = setTimeout(() => finish({ ok: true }), 2000)
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          api_key: trimmed,
          model: STT_MODEL,
          audio_format: 'pcm_s16le',
          sample_rate: STT_SAMPLE_RATE,
          num_channels: 1,
        }),
      )
    })
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

  // One spoken utterance at a time. Utterances queue (FIFO); index 0 is the one
  // currently on the wire, the rest wait so a new utterance never severs an
  // unfinished one mid-audio. Within an utterance, text streams in live.
  private ttsSocket: WebSocket | null = null
  private ttsReady = false
  private ttsStreamId = ''
  /** Chunks of the active utterance already sent (the rest stream as they land). */
  private ttsSent = 0
  /** Guards against sending text_end twice for the active utterance. */
  private ttsEndSent = false
  private ttsUtterances: { chunks: string[]; ended: boolean }[] = []
  /** The utterance currently receiving chunks (the latest speakStart). */
  private ttsBuilding: { chunks: string[]; ended: boolean } | null = null
  private ttsSeq = 0

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
      ws.send(
        JSON.stringify({
          api_key: key,
          model: STT_MODEL,
          audio_format: 'pcm_s16le',
          sample_rate: STT_SAMPLE_RATE,
          num_channels: 1,
          // Push-to-talk finalizes on release, so semantic endpointing only adds
          // false triggers — we drive finalization ourselves.
          enable_endpoint_detection: false,
        }),
      )
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
    if (ws) {
      ws.removeAllListeners()
      try {
        ws.close()
      } catch {
        /* already closing */
      }
    }
  }

  // --- Text-to-speech ------------------------------------------------------

  /** Begin a spoken utterance. If one is already playing, this one queues and
   *  starts only after it finishes — so a new utterance never cuts off the audio
   *  still streaming from the last one. */
  speakStart(): void {
    if (!apiKey()) return
    const utt = { chunks: [] as string[], ended: false }
    this.ttsBuilding = utt
    this.ttsUtterances.push(utt)
    if (this.ttsUtterances.length === 1) this.openTts()
  }

  /** Feed the next piece of text into the utterance being built. Streams live to
   *  the wire when that utterance is the active one and the socket is open. */
  speakChunk(text: string): void {
    if (!text || !this.ttsBuilding) return
    this.ttsBuilding.chunks.push(text)
    this.flushTts()
  }

  /** Close the input side of the current utterance; its audio finishes and the
   *  socket terminates on its own, after which any queued utterance starts. */
  speakEnd(): void {
    if (!this.ttsBuilding) return
    this.ttsBuilding.ended = true
    this.ttsBuilding = null
    this.flushTts()
  }

  /** One-shot convenience — the non-streaming fallback path. */
  speak(text: string): void {
    const line = text.trim()
    if (!line) return
    this.speakStart()
    this.speakChunk(line)
    this.speakEnd()
  }

  /** Open a socket for the active utterance (the head of the queue). */
  private openTts(): void {
    const key = apiKey()
    if (!key || !this.ttsUtterances[0]) return
    this.ttsReady = false
    this.ttsSent = 0
    this.ttsEndSent = false
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
      this.flushTts()
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
        this.finishTts()
        return
      }
      if (res.audio) this.deps.onTtsAudio(Buffer.from(res.audio, 'base64'))
      if (res.terminated) this.finishTts()
    })
    ws.on('error', () => {
      if (this.ttsSocket === ws) this.finishTts()
    })
  }

  /** Send whatever of the active utterance hasn't gone out yet, then text_end if
   *  it's complete. Safe to call repeatedly — it only sends the new tail. */
  private flushTts(): void {
    const utt = this.ttsUtterances[0]
    const ws = this.ttsSocket
    if (!utt || !ws || !this.ttsReady || ws.readyState !== WebSocket.OPEN) return
    while (this.ttsSent < utt.chunks.length) {
      ws.send(JSON.stringify({ text: utt.chunks[this.ttsSent], text_end: false, stream_id: this.ttsStreamId }))
      this.ttsSent++
    }
    if (utt.ended && !this.ttsEndSent) {
      ws.send(JSON.stringify({ text: '', text_end: true, stream_id: this.ttsStreamId }))
      this.ttsEndSent = true
    }
  }

  /** The active utterance's socket ended (terminated or errored) — drop it and
   *  start the next queued utterance, if any. */
  private finishTts(): void {
    this.closeSocket()
    this.ttsUtterances.shift()
    if (this.ttsUtterances.length) this.openTts()
  }

  /** Stop speaking now (barge-in or app teardown): drop the queue, close the
   *  socket, and tell the renderer to flush any queued audio. */
  cancelSpeak(): void {
    const had = this.ttsSocket !== null || this.ttsUtterances.length > 0
    this.ttsUtterances = []
    this.ttsBuilding = null
    this.closeSocket()
    if (had) this.deps.onTtsReset()
  }

  private closeSocket(): void {
    const ws = this.ttsSocket
    this.ttsSocket = null
    this.ttsReady = false
    this.ttsSent = 0
    this.ttsEndSent = false
    if (ws) {
      ws.removeAllListeners()
      try {
        ws.close()
      } catch {
        /* already closing */
      }
    }
  }

  /** Tear down every socket at app exit. */
  dispose(): void {
    this.closeStt()
    this.ttsUtterances = []
    this.ttsBuilding = null
    this.closeSocket()
  }
}
