import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from 'react'
import { STATUS_COLORS, type CardMeta } from './meta'
import type { AgentTodo } from '@shared/types'

// Poster tunables (port of the Swift CanvasLayout poster constants).
/** Below this canvas zoom an agent card shows its poster face. */
export const POSTER_ZOOM = 0.55
const PADDING = 26
/** Ceiling on zoom compensation: past this the type stops growing. */
const MAX_SCALE = 3.5
/** Quantize compensation to steps so a camera fly re-renders the poster a
 *  handful of times, not per frame (the useStore selector returns it). */
const SCALE_STEP = 1.2
/** Document-unit height of the poster's irreducible core (status + two
 *  headline lines) — also caps the scale on short cards. */
const CORE_HEIGHT = 180
// Simplification tiers, as scale cutoffs: past dense the line caps tighten
// and the checklist shrinks; past body the body line goes; past todos only
// status + headline remain.
const DENSE_CUTOFF = 1.5
const BODY_CUTOFF = 2.2
const TODOS_CUTOFF = 3.0
const ROW_BUDGETS = { dense: 7, mid: 5, tight: 4 }

/** Zoom compensation for the poster's type: 1/zoom for constant on-screen
 *  size, capped and quantized. 0 = terminal LOD (poster hidden). */
export function posterCompensation(zoom: number): number {
  if (zoom >= POSTER_ZOOM) return 0
  const raw = Math.min(1 / zoom, MAX_SCALE)
  const stepped = Math.pow(SCALE_STEP, Math.round(Math.log(raw) / Math.log(SCALE_STEP)))
  return Math.max(1, stepped)
}

/** "✦2 · BLOCKED · 14m" — subagent count + status word + attention debt for
 *  the states that accumulate it. */
function statusLine(meta: CardMeta): string {
  let word = meta.status.toUpperCase()
  const carriesDebt =
    meta.status === 'blocked' || meta.status === 'error' || meta.status === 'stalled'
  if (carriesDebt && meta.statusSince) {
    const mins = Math.floor((Date.now() - meta.statusSince) / 60_000)
    if (mins >= 1) word += ` · ${mins}m`
  }
  if ((meta.subagents ?? 0) > 0) word = `✦${meta.subagents} · ${word}`
  return word
}

/** The plan as display rows, collapsed to the row budget: every title when
 *  it fits; otherwise done items fold into "✓ n done" and the tail into
 *  "… n more", keeping the in-progress row (the one that matters) visible. */
function checklistRows(
  todos: AgentTodo[],
  budget: number,
): { text: string; active: boolean }[] {
  if (!todos.length) return []
  const row = (t: AgentTodo): { text: string; active: boolean } => {
    if (t.status === 'completed') return { text: `✓ ${t.content}`, active: false }
    if (t.status === 'in_progress') return { text: `▸ ${t.activeForm ?? t.content}`, active: true }
    return { text: `○ ${t.content}`, active: false }
  }
  if (todos.length <= budget) return todos.map(row)

  const rows: { text: string; active: boolean }[] = []
  const doneCount = todos.filter((t) => t.status === 'completed').length
  if (doneCount > 0) rows.push({ text: `✓ ${doneCount} done`, active: false })
  const open = todos.filter((t) => t.status !== 'completed')
  const slots = Math.max(1, budget - rows.length - 1) // reserve the "… n more" line
  if (open.length > slots) {
    rows.push(...open.slice(0, slots).map(row))
    rows.push({ text: `… ${open.length - slots} more`, active: false })
  } else {
    rows.push(...open.map(row))
  }
  return rows
}

const clamp = (lines: number): CSSProperties => ({
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: lines,
  overflow: 'hidden',
})

/// A card's far-zoom LOD: when the terminal has shrunk to unreadable mush,
/// the card becomes album art — big status, the task in poster type, the
/// agent's own checklist, and the one line that matters for the current
/// state. Type is zoom-compensated (CSS transform, ≈1/zoom) so it reads at a
/// constant on-screen size, and sheds lower-priority rows as they'd no
/// longer fit. (Port of the Swift CardPosterView.)
export function PosterFace({
  meta,
  folderName,
  compensation,
}: {
  meta: CardMeta
  folderName: string
  compensation: number
}) {
  // Keep the "· 14m" attention-debt suffix current while the poster shows.
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const t = setInterval(tick, 30_000)
    return () => clearInterval(t)
  }, [])

  // Short cards cap the compensation: the irreducible core must always fit.
  const ref = useRef<HTMLDivElement>(null)
  const [heightCap, setHeightCap] = useState(MAX_SCALE)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setHeightCap(Math.max(1, el.clientHeight / CORE_HEIGHT))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const scale = Math.min(compensation, heightCap)

  const showsBody = scale < BODY_CUTOFF
  const showsTodos = scale < TODOS_CUTOFF
  const rowBudget =
    scale < DENSE_CUTOFF ? ROW_BUDGETS.dense : scale < BODY_CUTOFF ? ROW_BUDGETS.mid : ROW_BUDGETS.tight

  const color = STATUS_COLORS[meta.status]
  const headline = meta.task ?? folderName

  // What a glance needs differs completely between a card mid-work (plan +
  // live action), one that finished (the payoff line), and one that's asking.
  let body: string | undefined
  let bodyColor = 'var(--muted-foreground)'
  if (meta.status === 'done') {
    body = meta.summary ?? 'Finished — waiting for you'
    bodyColor = 'var(--card-foreground)' // the payoff line earns full ink
  } else if (meta.status === 'blocked' || meta.status === 'error') {
    body = meta.detail
    bodyColor = color
  } else {
    body = meta.detail
  }

  const rows = showsTodos ? checklistRows(meta.todos ?? [], rowBudget) : []

  return (
    <div ref={ref} className="poster-face absolute inset-0 overflow-hidden bg-card">
      <div
        className="flex flex-col gap-[14px]"
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          width: `${100 / scale}%`,
          padding: PADDING,
        }}
      >
        <div className="truncate font-mono text-[17px] font-semibold" style={{ color }}>
          {statusLine(meta)}
        </div>
        <div
          className="font-heading text-[36px] font-bold leading-[1.15] text-card-foreground"
          style={clamp(showsBody ? 3 : 2)}
        >
          {headline}
        </div>
        {rows.length > 0 && (
          <div className="mt-[6px] flex flex-col gap-[7px]">
            {rows.map((r, i) => (
              <div
                key={i}
                className={`truncate text-[21px] font-medium ${
                  r.active ? 'text-card-foreground' : 'text-muted-foreground'
                }`}
              >
                {r.text}
              </div>
            ))}
          </div>
        )}
        {showsBody && body && (
          <div
            className="mt-[6px] font-mono text-[16px]"
            style={{ ...clamp(scale < DENSE_CUTOFF ? 4 : 2), color: bodyColor }}
          >
            {body}
          </div>
        )}
      </div>
    </div>
  )
}
