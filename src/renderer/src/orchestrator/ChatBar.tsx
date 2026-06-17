import { useEffect, useRef, useState } from 'react'
import type { OrchestratorEvent, OrchestratorMode } from '@shared/types'
import {
  OrchestratorConfirmToast,
  type OrchestratorConfirm,
} from '@/orchestrator/OrchestratorConfirmToast'

type Line = { kind: OrchestratorEvent['kind'] | 'you'; text: string; name?: string }

const TONE: Record<Line['kind'], string> = {
  you: 'text-foreground',
  assistant: 'text-foreground/90',
  tool: 'text-muted-foreground',
  result: 'text-emerald-400',
  error: 'text-red-400',
  agentReply: 'text-cyan-400',
  auto: 'text-amber-400',
}

// Click cycles through the three modes; the badge shows the current one.
const MODE_ORDER: OrchestratorMode[] = ['manual', 'supervising', 'autopilot']
const MODE_BADGE: Record<OrchestratorMode, { label: string; cls: string; title: string }> = {
  manual: {
    label: '○ manual',
    cls: 'bg-muted/40 text-muted-foreground hover:bg-muted/60',
    title:
      'Manual — replies are echoed but never wake the orchestrator, and every orchestrator action needs your click. Click to supervise.',
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

/** Bottom-center chat bar that drives the in-app orchestrator. The orchestrator's
 *  permission gate rides directly above the input (passed in from Canvas, which
 *  owns the pending-confirm state) so it's never hidden behind the bar. */
export function OrchestratorChatBar({
  confirm,
  onConfirmDecide,
}: {
  confirm: OrchestratorConfirm | null
  onConfirmDecide: (allow: boolean) => void
}): React.JSX.Element {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // How autonomous the orchestrator is; defaults to supervising (main mirrors).
  const [mode, setMode] = useState<OrchestratorMode>('supervising')
  const logRef = useRef<HTMLDivElement>(null)

  function cycleMode(): void {
    setMode((m) => {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length]
      window.canvas.setOrchestratorMode(next)
      return next
    })
  }

  useEffect(
    () =>
      window.canvas.onOrchestratorEvent((e) => {
        if (e.kind === 'result' || e.kind === 'error') setBusy(false)
        setLines((ls) => {
          // The success `result` repeats the turn's final assistant text — it's
          // only here to clear `busy`. Drop it as a line unless it carries
          // something the assistant block didn't (e.g. a tool-only turn).
          if (e.kind === 'result') {
            const lastAssistant = [...ls].reverse().find((l) => l.kind === 'assistant')
            if (!e.text.trim() || lastAssistant?.text.trim() === e.text.trim()) return ls
          }
          return [...ls, { kind: e.kind, text: e.text, name: e.name }]
        })
      }),
    [],
  )

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [lines])

  function submit(): void {
    const text = input.trim()
    if (!text || busy) return
    setLines((ls) => [...ls, { kind: 'you', text }])
    window.canvas.sendOrchestratorPrompt(text)
    setInput('')
    setBusy(true)
  }

  return (
    // A flex child of the shared bottom overlay (which stacks the agent toasts
    // above it) — not fixed, so nothing overlaps the input.
    <div
      className="pointer-events-auto w-[640px] max-w-[calc(100vw-2rem)]"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <OrchestratorConfirmToast confirm={confirm} onDecide={onConfirmDecide} />
      {lines.length > 0 && (
        <div
          ref={logRef}
          className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border/40 bg-background/80 p-3 font-mono text-xs leading-relaxed shadow-lg backdrop-blur-xl"
        >
          {lines.map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap ${TONE[l.kind]}`}>
              {l.kind === 'agentReply' ? (
                <span className="text-cyan-400/70">{`⤷ ${l.name ?? 'agent'}: `}</span>
              ) : l.kind === 'you' ? (
                '› '
              ) : l.kind === 'tool' ? (
                '· '
              ) : l.kind === 'auto' ? (
                '⚡ '
              ) : (
                ''
              )}
              {l.text}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 rounded-full border border-border/40 bg-background/70 px-4 py-2 shadow-lg backdrop-blur-xl">
        <span className="font-mono text-xs text-muted-foreground">{busy ? '…' : '›'}</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="Ask the orchestrator — e.g. “switch to a canvas and spawn an agent there”"
          className="flex-1 bg-transparent font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
        />
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
