# orchestrator (renderer)

The renderer face of the natural-language orchestrator: a bottom-center chat bar you type or talk to, a permission gate, action "comets" fired at agent cards, and the audio glue for voice. The actual agent loop and MCP server live in the main process; everything here is presentation plus the bridge to main over `window.canvas.*` IPC. The components are mounted and wired by `../canvas/Canvas.tsx`, not self-contained.

## Files

- **ChatBar.tsx** — `OrchestratorChatBar`, the bottom pill. Owns the input, the mode badge (manual / partner / autonomous, cycled on click), the transient "whisper" caption + collapsed run history, the working pulse, and all push-to-talk wiring. Renders `OrchestratorConfirmToast` directly above itself.
- **OrchestratorConfirmToast.tsx** — `OrchestratorConfirmToast` + the `OrchestratorConfirm` type. A single Allow/Deny permission gate (`accent-ai`-tinted to read as the orchestrator, not an agent). Pure presentation; Canvas supplies the value and the decision callback.
- **Comet.tsx** — `OrchestratorComets` and the per-comet `Comet`. SVG comet that arcs from the chat bar to a target agent card, with a trailing tail and a ring bloom on landing; color is keyed to the action kind (`accent-ai`=identity, amber=approve, red=kill). Each comet self-removes via `onDone`.
- **voice.ts** — `MicCapture` (getUserMedia → AudioWorklet → 16 kHz pcm_s16le chunks) and `TtsPlayer` (gapless scheduling of 24 kHz pcm_s16le chunks on a Web Audio timeline, plus the loudness analyser that drives the edge glow). No React.

## Architecture / data flow

A typed prompt goes out via `submitText` → `window.canvas.sendOrchestratorPrompt(text)`; the prompt is pushed onto local history (kind `you`, never whispered). A spoken prompt takes the same path: holding ⌥ (or the mic button) calls `startRecording`, which opens `MicCapture` and streams pcm up with `sendSpeechAudio`; `onSpeechPartial` mirrors the live transcript into the input, and release (`finishSpeech`) makes main emit `onSpeechFinal`, which calls `submitText`.

Main streams a turn back as `OrchestratorEvent`s over `onOrchestratorEvent` (one subscription for the bar's lifetime, reads only refs/stable setters). Streamed `assistant` text carries a `phase`: `start` opens a live whisper line, `delta` appends, `final` commits it to history and starts the fade timer — so a line never fades mid-stream. `tool` events only flip the working pulse; `result`/`error` clear it. A `result` that repeats the turn's final assistant text is dropped (dedup via `lastTextRef`). `error` whispers are red and never auto-fade.

Confirm-toast approval flow: main asks via an `OrchestratorCommand` (`onOrchestratorCommand`, handled in Canvas, not here). Canvas turns a `confirm` command into an `OrchestratorConfirm` and passes it as the `confirm` prop; clicking Allow/Deny invokes `onConfirmDecide`, which Canvas replies with over the correlation-id channel (`orchestratorResult(id, { allow })`).

Comets are likewise Canvas's job: main fires `onOrchestratorTarget`, Canvas resolves the target card's rect and pushes a `CometSpec`. Comet timing is shared with main via `COMET_TRAVEL_MS` so the action's visible effect (e.g. a revealed spawn card) lands when the comet does.

Voice ownership split: the renderer owns the audio devices — mic capture, the TTS playback timeline, barge-in (`reset`), and the loudness envelope. Grabbing the mic barges in instantly: `startRecording` calls `reset()` locally rather than waiting for main's `onTtsReset` to round-trip back, and main pairs that with interrupting the orchestrator turn so it stops narrating instead of starting a fresh spoken line a beat later. Main owns the Soniox STT/TTS sockets, the `SONIOX_API_KEY`, and turning text into audio chunks. `TtsPlayer.listen` reports speaking on/off (lifted to Canvas via `onSpeakingChange` for the edge glow, and to main via `notifyVoicePlaying` so main can pace actions to the voice) and writes the per-frame `--voice-level` CSS var directly (no React re-render in the hot path).

## Conventions & gotchas

- Once-bound `useEffect` subscriptions (events, keydown/keyup/blur) deliberately read live state through refs (`recordingRef`, `voiceOkRef`, `streaming`, `hovering`, `lastTextRef`) — don't convert these to state-in-deps.
- Push-to-talk is the bare ⌥ key (it types nothing). `keydown` autorepeats, so `startRecording` guards on `recordingRef`; window `blur` force-stops so a held key can't stick recording on.
- The working glow is a CSS animation on the `.orchestrator-pill` pseudo-element (see `index.css`) so it runs on the compositor and React re-renders can't restart/flash it.
- Voice is available only when main reports a Soniox key (`voiceAvailable`, refreshable mid-session via `onVoiceAvailable`); the mic button and ⌥ hint are gated on it.
- Audio is fixed-rate (16 kHz capture, 24 kHz playback) to match the Soniox config in `main`'s `voice/soniox.ts`; the capture worklet is inlined as a Blob URL to avoid a separate bundled asset. `TtsPlayer` reuses one AudioContext (Chromium caps concurrent contexts) and `reset()` stops live sources rather than churning contexts.
- The `tool` event kind never becomes a whisper, so `WhisperKind` excludes it; the styling tables are keyed only to kinds that can render.
- These components don't fetch their own state — Canvas owns `orchConfirm`, `comets`, `speaking`, and the command/target handlers. Trace the full flow through `Canvas.tsx`.
