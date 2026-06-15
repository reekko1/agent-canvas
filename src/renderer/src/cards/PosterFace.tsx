import { useEffect, useReducer, type CSSProperties } from 'react'
import { STATUS_COLORS, type CardMeta } from './meta'
import type { AgentTodo } from '@shared/types'

/** How many checklist rows a stacked poster shows before folding. */
const ROW_BUDGET = 4

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

/** The plan as display rows, collapsed to the row budget: every title when it
 *  fits; otherwise done items fold into "✓ n done" and the tail into "… n
 *  more", keeping the in-progress row (the one that matters) visible. */
function checklistRows(todos: AgentTodo[], budget: number): { text: string; active: boolean }[] {
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

/// A stacked card's compact face: status word, the task headline, the agent's
/// own checklist, and the one line that matters for the current state. Shown
/// in the stack column while the master card holds the live terminal; clicking
/// it promotes the card to master.
export function PosterFace({
  meta,
  folderName,
  isShell,
}: {
  meta: CardMeta
  folderName: string
  isShell?: boolean
}) {
  // Keep the "· 14m" attention-debt suffix current while the poster shows.
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const t = setInterval(tick, 30_000)
    return () => clearInterval(t)
  }, [])

  const color = isShell ? 'var(--muted-foreground)' : STATUS_COLORS[meta.status]
  const headline = meta.task ?? folderName

  // What a glance needs differs between mid-work, finished, and asking.
  let body: string | undefined
  let bodyColor = 'var(--muted-foreground)'
  if (meta.status === 'done') {
    body = meta.summary ?? 'Finished — waiting for you'
    bodyColor = 'var(--card-foreground)'
  } else if (meta.status === 'blocked' || meta.status === 'error') {
    body = meta.detail
    bodyColor = color
  } else {
    body = meta.detail
  }

  const rows = checklistRows(meta.todos ?? [], ROW_BUDGET)

  return (
    <div className="poster-face absolute inset-0 flex flex-col gap-2 overflow-hidden bg-card p-4">
      <div className="truncate font-mono text-[12px] font-semibold" style={{ color }}>
        {isShell ? 'SHELL' : statusLine(meta)}
      </div>
      <div
        className="font-heading text-[18px] font-bold leading-tight text-card-foreground"
        style={clamp(2)}
      >
        {headline}
      </div>
      {rows.length > 0 && (
        <div className="mt-0.5 flex flex-col gap-1">
          {rows.map((r, i) => (
            <div
              key={i}
              className={`truncate text-[12px] ${
                r.active ? 'text-card-foreground' : 'text-muted-foreground'
              }`}
            >
              {r.text}
            </div>
          ))}
        </div>
      )}
      {body && (
        <div className="mt-0.5 font-mono text-[11px]" style={{ ...clamp(2), color: bodyColor }}>
          {body}
        </div>
      )}
    </div>
  )
}
