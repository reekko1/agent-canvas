import { useEffect, useReducer, type CSSProperties } from 'react'
import { STATUS_COLORS, isLoud, type CardMeta } from './meta'

const clamp = (lines: number): CSSProperties => ({
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: lines,
  overflow: 'hidden',
})

/// A stacked agent card's compact face — a mission poster, sibling to the
/// shell's instrument readout. The status word lives in the window bar above,
/// so the poster leads with the task itself and pins the one live thing to the
/// bottom (the step it's working on now, or the reason it needs you), with a
/// progress bar standing in for the shell's cursor — a glance at how alive it is
/// and how far it's got. Clicking promotes the card to master, where the full
/// plan and terminal live.
export function PosterFace({ meta }: { meta: CardMeta }) {
  // Keep the attention-debt minutes current while the poster shows.
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const t = setInterval(tick, 30_000)
    return () => clearInterval(t)
  }, [])

  const color = STATUS_COLORS[meta.status]
  // The project name already reads in the window bar — don't echo it here.
  const headline = meta.task

  const todos = meta.todos ?? []
  const total = todos.length
  const completed = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')

  // Attention debt — minutes stuck — for the states that accumulate it. Not in
  // the window bar, so it rides the progress row here.
  const carriesDebt =
    meta.status === 'blocked' || meta.status === 'error' || meta.status === 'stalled'
  const debtMins =
    carriesDebt && meta.statusSince ? Math.floor((Date.now() - meta.statusSince) / 60_000) : 0

  // The active step is always surfaced when one is in flight — "blocked while
  // doing X" is exactly when X matters most. The state reason rides as a second
  // line below it (the summary when done, the reason when it's asking).
  const activeStep = current?.activeForm ?? current?.content
  let reason: { text: string; color: string } | undefined
  if (meta.status === 'done') {
    reason = { text: meta.summary ?? 'Finished — waiting for you', color: 'var(--card-foreground)' }
  } else if (isLoud(meta.status)) {
    if (meta.detail) reason = { text: meta.detail, color }
  } else if (!activeStep && meta.detail) {
    // Nothing in flight (no checklist) — fall back to whatever it last said.
    reason = { text: meta.detail, color: 'var(--muted-foreground)' }
  }

  return (
    <div className="poster-face absolute inset-0 flex flex-col overflow-hidden bg-card p-4">
      {/* The mission leads — status already reads in the window bar above. */}
      {headline && (
        <div
          className="font-heading text-[18px] font-bold leading-tight text-card-foreground"
          style={clamp(3)}
        >
          {headline}
        </div>
      )}

      {/* The live now-lines and progress, pinned low like the shell's prompt. */}
      <div className="mt-auto flex flex-col gap-2">
        {activeStep && (
          <div
            className="font-mono text-[12px] leading-snug text-card-foreground"
            style={clamp(2)}
          >
            <span className="mr-1.5" style={{ color }} aria-hidden>
              ▸
            </span>
            {activeStep}
          </div>
        )}
        {reason && (
          <div
            className="font-mono text-[12px] leading-snug"
            style={{ ...clamp(2), color: reason.color }}
          >
            {reason.text}
          </div>
        )}
        {total > 0 && (
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${(completed / total) * 100}%`, backgroundColor: color }}
              />
            </div>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {(meta.subagents ?? 0) > 0 && `✦${meta.subagents} · `}
              {debtMins >= 1 && `${debtMins}m · `}
              {completed}/{total}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
