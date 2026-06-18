# voice (main)

Soniox-backed voice for the orchestrator, living entirely in the main process so the API key and the WebSockets never reach the renderer. The renderer only ships raw mic PCM up and plays the PCM that comes back, all over IPC.

## Files

- `keyStore.ts` — Soniox API key: load, source-detection, and OS-encrypted persistence via Electron `safeStorage`.
- `soniox.ts` — `SonioxVoice`: STT (push-to-talk) and TTS (per-line) WebSocket client, plus key validation and speech-pacing.

## Architecture / data flow

**Key resolution.** `loadSonioxKey()` returns the key in effect: an exported `SONIOX_API_KEY` (trimmed) always wins; otherwise the encrypted key at `SPINE_DIR/soniox.key`, decrypted with `safeStorage` only when the OS keychain is available. `storeSonioxKey()` encrypts and writes that file (mode `0o600`) and refuses (returns false) rather than ever persisting plaintext when encryption is unavailable. `sonioxKeySource()` reports `env`/`stored`/`none` to drive onboarding without revealing the value.

**STT (push-to-talk).** One socket per utterance to `stt-rt.soniox.com`. `startStt()` closes any prior session, opens a socket, and on `open` sends the config (`pcm_s16le`, 16 kHz, mono, endpoint detection OFF). `pushAudio()` streams mic chunks (buffered into `sttPending` until the socket opens, then flushed in order). On release `finishStt()` sends `{type:"finalize"}`; tokens arrive with `is_final`, final text accumulates into `sttFinal` while interim is recomputed per message. `onPartial` fires the live transcript; the `<fin>` marker (or `finished`) ends the utterance, firing `onFinal` and closing. `cancelStt()` aborts with no transcript.

**TTS (streaming, one line at a time).** `speakStart()` opens a socket per spoken line to `tts-rt.soniox.com` and sends the config (voice `Grace`, `en`, `pcm_s16le` @ 24 kHz, a `stream_id`). `speakChunk()` feeds text (buffered into `ttsPending` until open); `speakEnd()` sends `text_end:true`. Audio frames arrive base64-encoded, decoded to `Buffer` and handed to `onTtsAudio`; `terminated` closes the socket. `speak()` is the one-shot fallback. `speakEvent()` voices only assistant orchestrator events, mapping `start`/`delta`/`final` phases onto the streaming calls. `cancelSpeak()` is barge-in: fires `onTtsReset` so the renderer drops queued audio, then closes.

**Speech-pacing.** The renderer's player reports playback state via `setPlaying()`. `awaitCaughtUp()` resolves once a narrated line has started playing and then drained, letting the orchestrator hold a mutating action until its words are heard. Guarded by a 1 s start-timeout and a 20 s hard cap so a TTS that never starts can't wedge a turn.

**Validation.** `validateSonioxKey()` does the STT handshake only: a bad key is rejected fast with an `error_code`; a good key is accepted by the server's silence (2 s timeout = OK). Used by onboarding "Save" so a typo never gets persisted.

## Conventions & gotchas

- The key is never exported or logged; `available`/`apiKey()` only check presence.
- Audio sample rates here (16 k STT, 24 k TTS) are this side's copy of a contract the renderer (`voice.ts`) restates independently — not a shared export; keep them in sync.
- `MARKERS` (`<fin>`, `<end>`) are Soniox delimiters, never user-visible text — they are stripped before emitting transcript.
- Every socket callback guards `this.stt !== ws` / `this.ttsSocket !== ws` so a stale, replaced socket can't interleave into live state.
- TTS assumes no overlap: only one spoken line at a time, relying on the orchestrator's speech-pacing to serialize lines — there is no queue.
- `closeWs()` drops all listeners and swallows already-closing errors; `dispose()` tears down both sockets at app exit.
