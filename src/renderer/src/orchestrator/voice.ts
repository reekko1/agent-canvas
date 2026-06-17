// Renderer-side audio for the orchestrator's voice. Two halves:
//   • MicCapture — getUserMedia → an AudioWorklet that downsamples to 16 kHz
//     mono and emits little-endian pcm_s16le chunks. Those go up over IPC to the
//     Soniox STT socket in main.
//   • TtsPlayer — schedules the 24 kHz pcm_s16le chunks that stream back from the
//     TTS socket, gapless, on a Web Audio timeline. reset() is barge-in: it kills
//     everything queued so a new reply (or the user talking) cuts the old voice.
// Both rates are fixed by the Soniox config in main (see voice/soniox.ts).

const CAPTURE_RATE = 16000
const PLAYBACK_RATE = 24000

// Voice-reactive glow tuning. The analyser RMS of 16-bit speech sits around
// 0.05–0.2, so GAIN lifts it toward a ~1 peak; RELEASE is the per-frame decay
// (fast attack, slow release — an audio-meter envelope, so the glow swells on
// syllables and eases down instead of strobing); FLOOR keeps it from going dark
// mid-sentence during brief quiet spots.
const LEVEL_GAIN = 5
const LEVEL_RELEASE = 0.9
const LEVEL_FLOOR = 0.3

// The capture worklet, inlined as a Blob URL so there's no separate asset to
// bundle across dev and packaged builds. It buffers ~100 ms of float samples,
// converts to int16, and posts the raw bytes back to the main thread.
const CAPTURE_WORKLET = `
class PCM16Capture extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf = new Int16Array(1600) // ~100ms @ 16kHz
    this._n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i]
      s = s < -1 ? -1 : s > 1 ? 1 : s
      this._buf[this._n++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this._n === this._buf.length) {
        this.port.postMessage(this._buf.buffer.slice(0))
        this._n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm16-capture', PCM16Capture)
`

let workletUrl: string | null = null
function captureWorkletUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }))
  }
  return workletUrl
}

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null

  /** Open the mic and start emitting pcm_s16le @16 kHz chunks. Throws if the
   *  user (or OS) denies microphone access. */
  async start(onChunk: (pcm: ArrayBuffer) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    // Asking for a 16 kHz context lets Chromium resample for us — the worklet
    // then only has to pack float→int16.
    this.ctx = new AudioContext({ sampleRate: CAPTURE_RATE })
    await this.ctx.audioWorklet.addModule(captureWorkletUrl())
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.ctx, 'pcm16-capture')
    this.node.port.onmessage = (e) => onChunk(e.data as ArrayBuffer)
    // A muted sink keeps the graph pulling without monitoring the mic to speakers.
    const mute = this.ctx.createGain()
    mute.gain.value = 0
    src.connect(this.node)
    this.node.connect(mute)
    mute.connect(this.ctx.destination)
  }

  /** Stop capture and release the mic. Safe to call more than once. */
  stop(): void {
    this.node?.port.close()
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.ctx?.close()
    this.ctx = null
  }
}

export class TtsPlayer {
  // One reused context for the bar's lifetime — Chromium caps concurrent
  // AudioContexts, so reset() stops the live sources rather than churning contexts.
  private ctx: AudioContext | null = null
  // Sources feed an analyser (→ destination) so we can read playback loudness and
  // drive the voice-reactive edge glow off what's actually being heard.
  private analyser: AnalyserNode | null = null
  private wave: Float32Array<ArrayBuffer> | null = null
  /** Sources still scheduled or playing, so a barge-in can stop them all. */
  private readonly live = new Set<AudioBufferSourceNode>()
  /** The Web Audio time at which the next chunk should start, so back-to-back
   *  chunks play seamlessly instead of overlapping or gapping. */
  private next = 0
  /** Smoothed 0..1 loudness driving the glow; the rAF id while it's running. */
  private level = 0
  private raf = 0
  private speaking = false
  private onActive?: (active: boolean) => void
  private onLevel?: (level: number) => void

  /** Register glow hooks: `onActive` toggles the edge glow on/off when speech
   *  starts/ends; `onLevel` fires every frame with the live 0..1 loudness. */
  listen(onActive: (active: boolean) => void, onLevel: (level: number) => void): void {
    this.onActive = onActive
    this.onLevel = onLevel
  }

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: PLAYBACK_RATE })
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 512
      this.analyser.connect(this.ctx.destination)
      this.wave = new Float32Array(this.analyser.fftSize)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  /** Queue one chunk of spoken audio (pcm_s16le, mono, 24 kHz) for playback. */
  push(pcm: ArrayBuffer | Uint8Array): void {
    const ctx = this.ensure()
    const i16 =
      pcm instanceof Uint8Array
        ? new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
        : new Int16Array(pcm)
    if (i16.length === 0) return
    const f32 = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000
    const buf = ctx.createBuffer(1, f32.length, PLAYBACK_RATE)
    buf.getChannelData(0).set(f32)
    const node = ctx.createBufferSource()
    node.buffer = buf
    node.connect(this.analyser ?? ctx.destination)
    node.onended = () => this.live.delete(node)
    this.live.add(node)
    const now = ctx.currentTime
    if (this.next < now) this.next = now + 0.02 // small lead-in after a gap
    node.start(this.next)
    this.next += buf.duration
    if (!this.speaking) {
      this.speaking = true
      this.onActive?.(true)
      this.tick()
    }
  }

  /** Per-frame loudness → glow level, while audio is playing. */
  private tick = (): void => {
    const an = this.analyser
    const wave = this.wave
    if (!an || !wave) return
    an.getFloatTimeDomainData(wave)
    let sum = 0
    for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i]
    const rms = Math.sqrt(sum / wave.length)
    const reactive = Math.min(1, rms * LEVEL_GAIN)
    // Fast attack (jump up), slow release (ease down) — an audio-meter envelope.
    this.level = Math.max(reactive, this.level * LEVEL_RELEASE)
    this.onLevel?.(LEVEL_FLOOR + (1 - LEVEL_FLOOR) * this.level)
    // Speech is over once nothing is queued and the envelope has eased to ~0;
    // the consumer's on/off fade carries the visual out, so we don't snap to 0.
    if (this.live.size === 0 && this.level < 0.02) {
      this.speaking = false
      this.raf = 0
      this.onActive?.(false)
      return
    }
    this.raf = requestAnimationFrame(this.tick)
  }

  /** Barge-in: stop every scheduled/playing chunk now and forget the timeline. */
  reset(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    for (const node of this.live) {
      try {
        node.stop()
      } catch {
        /* already stopped */
      }
    }
    this.live.clear()
    this.next = 0
    this.level = 0
    if (this.speaking) {
      this.speaking = false
      this.onActive?.(false)
    }
  }
}
