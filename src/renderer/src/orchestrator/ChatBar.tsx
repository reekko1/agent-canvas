import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Mic } from 'lucide-react'
import type { OrchestratorEvent, OrchestratorMode } from '@shared/types'
import {
  OrchestratorConfirmToast,
  type OrchestratorConfirm,
} from '@/orchestrator/OrchestratorConfirmToast'
import { MicCapture, TtsPlayer } from '@/orchestrator/voice'

// A whisper is one thing the orchestrator said (or one prompt you sent). The
// latest non-`you` whisper shows transiently above the pill and then fades; the
// full run is kept, collapsed, behind the pill (click to reveal).
type WhisperKind = OrchestratorEvent['kind'] | 'you'
type Entry = { id: number; kind: WhisperKind; text: string }

const TONE: Record<WhisperKind, string> = {
  you: 'text-foreground',
  assistant: 'text-foreground/90',
  tool: 'text-muted-foreground',
  result: 'text-foreground/90',
  error: 'text-red-400',
  auto: 'text-amber-400',
  mode: 'text-amber-400',
}

// A small leading glyph that hints at the kind without a full label.
const GLYPH: Record<WhisperKind, string> = {
  you: '›',
  assistant: '✶',
  tool: '·',
  result: '✶',
  error: '✗',
  auto: '⚡',
  mode: '⚙',
}

/** How long a whisper lingers before it dissolves — a touch longer for more
 *  text, so a longer line is still readable. Errors never auto-fade. */
const fadeMs = (text: string): number => Math.min(9000, 4000 + text.length * 30)

const HISTORY_CAP = 40

// Click cycles through the three modes; the badge shows the current one.
const MODE_ORDER: OrchestratorMode[] = ['manual', 'supervising', 'autopilot']
const MODE_BADGE: Record<OrchestratorMode, { label: string; cls: string; title: string }> = {
  manual: {
    label: '○ manual',
    cls: 'bg-muted/40 text-muted-foreground hover:bg-muted/60',
    title:
      'Manual — replies are not echoed and never wake the orchestrator, and every orchestrator action needs your click. Click to supervise.',
  },
  supervising: {
    label: '◉ supervising',
    cls: 'bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25',
    title:
      'Supervising — the orchestrator wakes on fleet events and uses all its tools freely, without asking, including approving an agent when you tell it to. Unattended agent permission asks still wait for a decision (they are not blanket-approved). Click to engage autopilot.',
  },
  autopilot: {
    label: '⚡ autopilot',
    cls: 'bg-red-500/25 text-red-300 ring-1 ring-red-500/60 hover:bg-red-500/35',
    title:
      'AUTOPILOT — bypasses every confirmation: the orchestrator auto-allows its own actions and auto-approves every agent permission ask. Click to return to manual.',
  },
}

/** Bottom-center "whisper line" that drives the in-app orchestrator. You speak
 *  to it through the always-present pill; it answers by changing the canvas and
 *  whispering a single transient caption that fades on its own (the run is kept,
 *  collapsed, behind the pill). The permission gate rides directly above the
 *  input (passed in from Canvas) so it's never hidden behind the bar. */
export function OrchestratorChatBar({
  confirm,
  onConfirmDecide,
  onSpeakingChange,
}: {
  confirm: OrchestratorConfirm | null
  onConfirmDecide: (allow: boolean) => void
  /** Fires when the orchestrator starts/stops speaking aloud — drives the
   *  app-wide voice glow (rendered by Canvas). */
  onSpeakingChange?: (speaking: boolean) => void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  // It's mid-turn (calling tools) — the pill pulses instead of listing them.
  const [thinking, setThinking] = useState(false)
  // How autonomous the orchestrator is; defaults to supervising (main mirrors).
  const [mode, setMode] = useState<OrchestratorMode>('supervising')
  // The transient caption; null once it has faded or been collapsed away.
  const [whisper, setWhisper] = useState<Entry | null>(null)
  // The collapsed-by-default run, revealed by clicking the pill's glyph.
  const [history, setHistory] = useState<Entry[]>([])
  const [expanded, setExpanded] = useState(false)
  // Push-to-talk: voice is available only when main has a SONIOX_API_KEY; while
  // holding the talk key (or the mic) we stream the mic up and show the live
  // transcript in the input until release submits it.
  const [voiceOk, setVoiceOk] = useState(false)
  const [recording, setRecording] = useState(false)

  const seq = useRef(1)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Pause the fade while the cursor rests on a whisper, so a slow read never
  // loses it. Kept in a ref so the one-time event subscription sees it live.
  const hovering = useRef(false)
  // The last `assistant` text we whispered — used to drop the `result` echo of
  // a turn whose final assistant text we already showed.
  const lastTextRef = useRef('')
  const logRef = useRef<HTMLDivElement>(null)
  // Voice plumbing — the mic capture for the live utterance, the player for the
  // orchestrator's spoken replies, and refs the once-bound key/IPC handlers read
  // so they always see the current state.
  const player = useRef<TtsPlayer | null>(null)
  const mic = useRef<MicCapture | null>(null)
  const recordingRef = useRef(false)
  const voiceOkRef = useRef(false)
  // The assistant line currently streaming in — deltas append to it, `final`
  // commits it to history and lets it fade. Null between turns.
  const streaming = useRef<{ id: number; text: string } | null>(null)

  function clearFade(): void {
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    fadeTimer.current = null
  }
  function scheduleFade(text: string): void {
    clearFade()
    fadeTimer.current = setTimeout(() => {
      if (hovering.current) return // held under the cursor; mouseleave reschedules
      setWhisper(null)
    }, fadeMs(text))
  }

  // One subscription for the bar's lifetime; it only touches refs and stable
  // setters, so the closure captured here stays correct across renders.
  useEffect(() => {
    return window.canvas.onOrchestratorEvent((e) => {
      // Streamed assistant text: open a live line, grow it delta by delta, and
      // only commit + fade once `final` lands, so it never fades mid-stream.
      if (e.kind === 'assistant' && e.phase) {
        if (e.phase === 'start') {
          streaming.current = { id: seq.current++, text: '' }
          setWhisper({ id: streaming.current.id, kind: 'assistant', text: '' })
          clearFade()
        } else if (e.phase === 'delta') {
          const s = streaming.current
          if (!s) return
          s.text += e.text
          setWhisper({ id: s.id, kind: 'assistant', text: s.text })
        } else if (e.phase === 'final') {
          const s = streaming.current
          streaming.current = null
          const id = s?.id ?? seq.current++
          const text = (e.text || s?.text || '').trim()
          if (!text) {
            setWhisper(null)
            return
          }
          lastTextRef.current = text
          const entry: Entry = { id, kind: 'assistant', text }
          setHistory((h) => [...h, entry].slice(-HISTORY_CAP))
          setWhisper(entry)
          scheduleFade(text)
        }
        return
      }
      // Tool calls aren't shown line-by-line anymore — they just mean "working".
      if (e.kind === 'tool') {
        setThinking(true)
        return
      }
      if (e.kind === 'result' || e.kind === 'error') setThinking(false)
      const text = e.text.trim()
      if (!text) return
      // `result` repeats the turn's final assistant text — don't whisper twice.
      if (e.kind === 'result' && text === lastTextRef.current) return

      const entry: Entry = { id: seq.current++, kind: e.kind, text }
      // Only the assistant text feeds the `result`-echo dedup above; tracking
      // auto/mode/error too would let the next result silently swallow itself.
      if (e.kind === 'assistant') lastTextRef.current = text
      setHistory((h) => [...h, entry].slice(-HISTORY_CAP))
      setWhisper(entry)
      if (e.kind === 'error') clearFade() // errors stay until the next thing happens
      else scheduleFade(text)
    })
  }, [])

  // Keep the expanded log pinned to its newest row.
  useEffect(() => {
    if (expanded) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [history, expanded])

  // Voice, set up once for the bar's lifetime: learn whether it's configured,
  // play the orchestrator's spoken replies, mirror the live transcript into the
  // input, submit the finished utterance, and bind hold-⌥ as push-to-talk.
  useEffect(() => {
    player.current = new TtsPlayer()
    // Drive the app-wide voice glow: on/off lifts to Canvas; the live loudness
    // is written to a CSS var each frame (no React re-render in the hot path).
    player.current.listen(
      (active) => onSpeakingChange?.(active),
      (level) => document.documentElement.style.setProperty('--voice-level', level.toFixed(3)),
    )
    void window.canvas.voiceAvailable().then((ok) => {
      voiceOkRef.current = ok
      setVoiceOk(ok)
    })
    const offs = [
      // Voice can be enabled mid-session from onboarding — reveal the mic live.
      window.canvas.onVoiceAvailable((ok) => {
        voiceOkRef.current = ok
        setVoiceOk(ok)
      }),
      window.canvas.onTtsAudio((pcm) => player.current?.push(pcm)),
      window.canvas.onTtsReset(() => player.current?.reset()),
      window.canvas.onSpeechPartial((text) => setInput(text)),
      window.canvas.onSpeechFinal((text) => {
        setInput('')
        submitText(text)
      }),
      window.canvas.onSpeechError((message) => {
        setWhisper({ id: seq.current++, kind: 'error', text: message })
        clearFade()
      }),
    ]
    // Hold the ⌥/Alt key (alone — it types nothing) to talk; release to send.
    // keydown autorepeats, so guard on the recording ref.
    const isTalk = (e: KeyboardEvent): boolean => e.code === 'AltLeft' || e.code === 'AltRight'
    const down = (e: KeyboardEvent): void => {
      if (isTalk(e) && !e.repeat) void startRecording()
    }
    const up = (e: KeyboardEvent): void => {
      if (isTalk(e)) stopRecording()
    }
    // Losing focus mid-hold would never fire keyup — stop so it can't stick on.
    const blur = (): void => stopRecording()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      offs.forEach((off) => off())
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      mic.current?.stop()
      player.current?.reset()
    }
  }, [])

  function cycleMode(): void {
    setMode((m) => {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length]
      window.canvas.setOrchestratorMode(next)
      return next
    })
  }

  function submitText(raw: string): void {
    const text = raw.trim()
    if (!text) return
    // Your prompt joins the history (so the expanded view reads as a dialogue)
    // but is never echoed as a transient whisper — you just typed it.
    setHistory((h) => [...h, { id: seq.current++, kind: 'you' as const, text }].slice(-HISTORY_CAP))
    // Streaming-input session: typing while it works just queues the prompt.
    window.canvas.sendOrchestratorPrompt(text)
    setInput('')
    setThinking(true)
  }

  function submit(): void {
    submitText(input)
  }

  // Hold-to-talk: open the mic and stream pcm up; the live transcript lands in
  // the input via onSpeechPartial, and release (stopRecording) finalizes it.
  async function startRecording(): Promise<void> {
    if (recordingRef.current || !voiceOkRef.current) return
    recordingRef.current = true
    setRecording(true)
    window.canvas.startSpeech()
    const capture = new MicCapture()
    mic.current = capture
    try {
      await capture.start((pcm) => window.canvas.sendSpeechAudio(pcm))
    } catch {
      // Mic denied or unavailable — abort cleanly and tell the user once.
      recordingRef.current = false
      setRecording(false)
      mic.current = null
      window.canvas.cancelSpeech()
      setWhisper({ id: seq.current++, kind: 'error', text: 'Microphone unavailable.' })
      clearFade()
    }
  }

  function stopRecording(): void {
    if (!recordingRef.current) return
    recordingRef.current = false
    setRecording(false)
    mic.current?.stop()
    mic.current = null
    window.canvas.finishSpeech()
  }

  return (
    // A flex child of the shared bottom overlay (which stacks the agent toasts
    // above it) — not fixed, so nothing overlaps the input.
    <div
      className="pointer-events-auto w-[640px] max-w-[calc(100vw-2rem)]"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <OrchestratorConfirmToast confirm={confirm} onDecide={onConfirmDecide} />

      <AnimatePresence mode="wait">
        {expanded ? (
          // The run, on demand — the old log, collapsed by default.
          <motion.div
            key="log"
            ref={logRef}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border/40 bg-background/80 p-3 font-mono text-xs leading-relaxed shadow-lg backdrop-blur-xl"
          >
            {history.length === 0 ? (
              <div className="text-muted-foreground/60">nothing yet</div>
            ) : (
              history.map((l) => (
                <div key={l.id} className={`whitespace-pre-wrap ${TONE[l.kind]}`}>
                  <span className="text-muted-foreground/50">{`${GLYPH[l.kind]} `}</span>
                  {l.text}
                </div>
              ))
            )}
          </motion.div>
        ) : whisper ? (
          // The transient caption: one thing it said, fading on its own.
          <motion.div
            key={whisper.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            onMouseEnter={() => {
              hovering.current = true
              clearFade()
            }}
            onMouseLeave={() => {
              hovering.current = false
              if (whisper.kind !== 'error') scheduleFade(whisper.text)
            }}
            className="mb-2 w-full rounded-xl border border-border/40 bg-background/75 px-3.5 py-2.5 shadow-lg backdrop-blur-xl"
          >
            <div className={`whitespace-pre-wrap font-mono text-xs leading-relaxed ${TONE[whisper.kind]}`}>
              <span className="text-cyan-400/70">{`${GLYPH[whisper.kind]} `}</span>
              {whisper.text}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div
        // A breathing cyan glow while it works — a CSS animation on a pseudo-
        // element (`.orchestrator-pill`, see index.css) so it runs on the
        // compositor and no React re-render can restart or flash it. `is-working`
        // eases the glow in/out; the loop itself never fully fades (it breathes).
        className={`orchestrator-pill flex items-center gap-2 rounded-full border bg-background/70 px-4 py-2 shadow-lg backdrop-blur-xl transition-colors ${
          thinking ? 'is-working border-cyan-400/40' : 'border-border/40'
        }`}
      >
        {/* The leading glyph doubles as the history toggle (the pill's glow and
            the "working" caption carry the busy state, so it stays calm). */}
        <button
          type="button"
          onClick={() => history.length > 0 && setExpanded((v) => !v)}
          title={history.length > 0 ? (expanded ? 'Hide history' : 'Show history') : undefined}
          className={`shrink-0 font-mono text-xs transition-colors ${
            history.length > 0 ? 'cursor-pointer text-muted-foreground hover:text-foreground' : 'text-muted-foreground'
          }`}
        >
          {expanded ? '⌄' : '›'}
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape' && expanded) setExpanded(false)
          }}
          placeholder={
            recording
              ? 'Listening…'
              : voiceOk
                ? 'Ask the orchestrator — or hold ⌥ to talk'
                : 'Ask the orchestrator — e.g. “switch to a canvas and spawn an agent there”'
          }
          className="flex-1 bg-transparent font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        {voiceOk && (
          // Press-and-hold to talk, mirroring the ⌥ hotkey; pulses while live.
          <button
            type="button"
            aria-label="Push to talk"
            title="Hold to talk (or hold ⌥)"
            onPointerDown={(e) => {
              e.preventDefault()
              void startRecording()
            }}
            onPointerUp={stopRecording}
            onPointerLeave={stopRecording}
            className={`shrink-0 transition-colors ${
              recording ? 'animate-pulse text-red-400' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Mic className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={cycleMode}
          title={MODE_BADGE[mode].title}
          className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] transition-colors ${MODE_BADGE[mode].cls}`}
        >
          {MODE_BADGE[mode].label}
        </button>
      </div>
    </div>
  )
}
