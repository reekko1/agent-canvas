import { useEffect, useRef, useState } from 'react'
import type { OrchestratorEvent } from '@shared/types'

type Line = { kind: OrchestratorEvent['kind'] | 'you'; text: string }

const TONE: Record<Line['kind'], string> = {
  you: 'text-foreground',
  assistant: 'text-foreground/90',
  tool: 'text-muted-foreground',
  result: 'text-emerald-400',
  error: 'text-red-400',
}

/** Bottom-center chat bar that drives the in-app orchestrator. */
export function OrchestratorChatBar(): React.JSX.Element {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      window.canvas.onOrchestratorEvent((e) => {
        setLines((ls) => [...ls, { kind: e.kind, text: e.text }])
        if (e.kind === 'result' || e.kind === 'error') setBusy(false)
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
    <div
      className="fixed bottom-4 left-1/2 z-40 w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      {lines.length > 0 && (
        <div
          ref={logRef}
          className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border/40 bg-background/80 p-3 font-mono text-xs leading-relaxed shadow-lg backdrop-blur-xl"
        >
          {lines.map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap ${TONE[l.kind]}`}>
              {l.kind === 'you' ? '› ' : l.kind === 'tool' ? '· ' : ''}
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
      </div>
    </div>
  )
}
