import { useState } from 'react'
import { InlineComposer, SectionLabel, TextArea } from './ui'
import type { IssueBoardApi } from './useIssueBoard'

/// Distance to the vision — ASSESSED, never computed (a recurring qualitative
/// judgment, not a number). v1: the human records it by hand; the slot is exactly
/// what a recurring auditor agent fills later. The latest reading leads; past
/// readings sit quietly beneath as a timeline.
export function DistancePanel({ board }: { board: IssueBoardApi }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const latest = board.latestDistance
  const history = board.distance.slice(1)

  const record = (): void => {
    if (!note.trim()) return
    board.assessDistance(note.trim())
    setNote('')
    setOpen(false)
  }

  return (
    <div className="space-y-2 border-b border-border px-4 py-3">
      <SectionLabel
        action={
          <button
            className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Close' : 'Assess'}
          </button>
        }
      >
        Distance to vision
      </SectionLabel>

      <p className="text-[13px] leading-relaxed text-foreground/90">
        {latest ? latest.note : <span className="text-muted-foreground">Not yet assessed.</span>}
      </p>

      {open && (
        <InlineComposer
          submitLabel="Record"
          canSubmit={!!note.trim()}
          onSubmit={record}
          onCancel={() => setOpen(false)}
        >
          <TextArea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="How close is the product to the vision, and what's the biggest gap?"
          />
        </InlineComposer>
      )}

      {history.length > 0 && (
        <div className="space-y-1 pt-0.5">
          {history.map((d, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-muted-foreground/80">
              {d.note}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
