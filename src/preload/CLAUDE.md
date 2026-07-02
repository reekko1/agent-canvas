# src/preload

The Electron `contextBridge` bridge — the **only** sanctioned channel between
renderer and main. `index.ts` builds one object that implements `CanvasApi`
(from `src/shared`) and exposes it on `window.canvas`. Renderer-initiated calls
become `ipcRenderer.invoke` (request/response) or `ipcRenderer.send`
(fire-and-forget); main-initiated pushes become `ipcRenderer.on` subscriptions,
wrapped by the local `subscribe` helper that returns an unsubscribe function.

## Surface

The API exposed on `window.canvas` groups by concern:

- **Spine / sessions** — card lifecycle (`newCard`, `newShell`, `killCard`,
  `setInitialPrompt`), agent cards are HEADLESS sessions (no pty): `startAgent`
  (takes an optional `cli` — which CLI backs the card; idempotent, called on
  every CardNode mount) and `availableClis` (which CLIs are installed on PATH,
  for the spawn picker) start/ensure the session, `sendToCard` (returns a
  `SendOutcome` — `'sent'` or `'queued'`) and `interruptCard` drive it,
  `loadTranscript` + `onTranscriptItem` are its transcript feed (initial paint
  + live push), `onSessionEnded` is its lifecycle end (the agent-card analogue
  of `onPtyExit`). Shell cards keep a direct pty (no tmux): `ensureShell`,
  `write`, `resize`, `onPtyData`, `onPtyExit`, `shellTitle` (a ps-walk of the
  pty's own pid — replaces the old paneCommand/paneCwd pair with one call).
  Card events and plan (`onCardEvent`), workspace persistence (`loadWorkspace`,
  `saveWorkspace`), and asks/questions (`onAsk`, `onQuestion`, `decide`,
  `answerQuestion`, `releaseAsks` — `onAsk`/`decide` are dormant now that cards
  run unattended; `ask_user` via `onQuestion`/`answerQuestion` is live).
- **Issue store (Mastermind substrate)** — the visible `Vision → Sprint → Plan →
  Issue` board: `loadIssueStore`, `issueAction` (apply one mutation), `onIssueUpdate`
  (the whole projection re-pushed on every applied action).
- **Git / diff** — `watchDiff`/`unwatchDiff`, `readFileDiff`, `gitAction`,
  `repoIdentity`, `onDiffSnapshot`, plus folder actions `revealFolder`,
  `openInEditor`, `pickFolder`.
- **Remote panel / readiness / update** — `publishRemoteState`,
  `checkRemoteReadiness`, `checkAppReadiness`, `onAskDecided`,
  `onQuestionDecided`, `openExternal`, `onUpdateStatus`, `quitAndInstall`.
- **Orchestrator** — `sendOrchestratorPrompt`, `onOrchestratorEvent`,
  `onOrchestratorCommand`, `onOrchestratorTarget`, `orchestratorResult`,
  `setOrchestratorMode`, plus browser-card driving: `browserReady` (a guest
  reached dom-ready / was torn down — feeds main's readiness map) and
  `onBrowserWake` (revive a dormant/evicted browser so it can be driven).
- **Voice** — availability (`voiceAvailable`, `saveVoiceKey`, `onVoiceAvailable`),
  push-to-talk STT (`startSpeech`, `sendSpeechAudio`, `finishSpeech`,
  `cancelSpeech`, `onSpeechPartial`, `onSpeechFinal`, `onSpeechError`), and TTS
  playback (`notifyVoicePlaying`, `onTtsAudio`, `onTtsReset`).

## Conventions & gotchas

- Runs with `contextIsolation` on: the renderer never touches `ipcRenderer`
  directly — everything goes through `window.canvas`.
- Renderer → main is `invoke` (awaitable) or `send` (one-way); main → renderer is
  a channel push, consumed via an `on*` subscription that returns its own teardown.
- **Every new IPC channel must be declared here** (and matched by a handler in
  main and a method on `CanvasApi`). The channel string is the contract — keep
  both ends in sync.
- The type source is `src/shared` (`CanvasApi`, payload shapes). This file only
  wires channels to that interface; it defines no types of its own.
