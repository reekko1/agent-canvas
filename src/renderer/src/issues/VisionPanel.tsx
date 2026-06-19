import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CLASS_META, ClassTag } from './badges'
import { Field, SectionLabel, Segmented, TextArea, TextInput, linesToList } from './ui'
import type { IssueBoardApi } from './useIssueBoard'
import type { VisionEditClass } from '@shared/types'

const CLASSES: VisionEditClass[] = ['clarification', 'redirection', 'expansion']

/// The canvas's vision body: its current north star (the hero of the sheet), the
/// immutable version timeline ("git for intent"), and the commit composer. The
/// human is the sole writer (agents may propose, never commit); committing a
/// redirection/expansion triggers the store's propagation pass over the fleet.
export function VisionPanel({ board }: { board: IssueBoardApi }) {
  const { currentVersion, versions } = board
  const [composing, setComposing] = useState(false)
  const [viewingId, setViewingId] = useState<string | null>(null)

  const [body, setBody] = useState('')
  const [principles, setPrinciples] = useState('')
  const [antiVision, setAntiVision] = useState('')
  const [rationale, setRationale] = useState('')
  const [cls, setCls] = useState<VisionEditClass>('clarification')

  const startCompose = (): void => {
    setBody(currentVersion?.body ?? '')
    setPrinciples((currentVersion?.principles ?? []).join('\n'))
    setAntiVision((currentVersion?.antiVision ?? []).join('\n'))
    setRationale('')
    setCls(currentVersion ? 'clarification' : 'expansion')
    setComposing(true)
  }

  const commit = (): void => {
    board.commitVisionVersion({
      body: body.trim(),
      principles: linesToList(principles),
      antiVision: linesToList(antiVision),
      rationale: rationale.trim(),
      class: cls,
    })
    setComposing(false)
    setRationale('')
  }

  const viewing = versions.find((v) => v.id === viewingId) ?? currentVersion

  if (composing) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-3">
          <Field label="Vision — the end-state, written as if already real">
            <TextArea
              autoFocus
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder="A supervisor sits down and understands the whole fleet at a glance…"
            />
          </Field>
          <Field label="Principles">
            <TextArea
              value={principles}
              onChange={(e) => setPrinciples(e.target.value)}
              rows={3}
              placeholder="One per line"
            />
          </Field>
          <Field label="Anti-vision">
            <TextArea
              value={antiVision}
              onChange={(e) => setAntiVision(e.target.value)}
              rows={3}
              placeholder="One per line — what this must never become"
            />
          </Field>
          <Field label="Rationale — why this changed">
            <TextInput
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Sharpened the cockpit metaphor…"
            />
          </Field>
          <Field label="Class — how it bears on in-flight sprints" hint={CLASS_META[cls].hint}>
            <Segmented
              value={cls}
              onChange={setCls}
              options={CLASSES.map((c) => ({ value: c, label: CLASS_META[c].label }))}
            />
          </Field>
          <div className="flex items-center gap-2 pt-0.5">
            <Button disabled={!rationale.trim()} onClick={commit}>
              Commit v{(currentVersion?.n ?? 0) + 1}
            </Button>
            <Button variant="ghost" onClick={() => setComposing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {viewing ? (
        <div className="vision-aura rounded-xl">
          <div className="relative z-10 space-y-3">
            <div className="flex items-center gap-2">
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: 'rgb(34 211 238)' }}
                aria-hidden
              />
              <span className="font-mono text-[11px] text-muted-foreground">v{viewing.n}</span>
              <ClassTag cls={viewing.class} />
              {viewing.id === currentVersion?.id ? (
                <span className="text-[11px] text-muted-foreground/60">· north star</span>
              ) : (
                <button
                  className="ml-auto text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setViewingId(null)}
                >
                  Back to current
                </button>
              )}
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
              {viewing.body || <span className="text-muted-foreground">(empty)</span>}
            </p>
            {viewing.principles.length > 0 && (
              <Bullets title="Principles" items={viewing.principles} />
            )}
            {viewing.antiVision.length > 0 && (
              <Bullets title="Anti-vision" items={viewing.antiVision} />
            )}
            {viewing.rationale && (
              <p className="text-[11px] italic leading-relaxed text-muted-foreground">
                Why v{viewing.n}: {viewing.rationale}
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          No vision yet. Commit the first version to set the product's north star.
        </p>
      )}

      {versions.length > 0 && (
        <div className="mt-4 space-y-1.5 border-t border-border pt-3">
          <SectionLabel>History</SectionLabel>
          {/* The version timeline as a luminous spine — "git for intent" read top
              (latest) to bottom, each commit a node on the line. */}
          <div className="relative ml-1 space-y-0.5 border-l border-border/70 pl-3">
            {versions.map((v) => {
              const active = v.id === viewing?.id
              return (
                <button
                  key={v.id}
                  onClick={() => setViewingId(v.id)}
                  className={cn(
                    'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                    active ? 'bg-accent' : 'hover:bg-hover',
                  )}
                >
                  <span
                    aria-hidden
                    className="absolute -left-[15px] size-1.5 rounded-full ring-2 ring-card"
                    style={{ backgroundColor: active ? 'rgb(34 211 238)' : 'var(--color-border)' }}
                  />
                  <span className="font-mono text-[11px] text-muted-foreground">v{v.n}</span>
                  <ClassTag cls={v.class} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {v.rationale || '—'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <Button variant="secondary" className="mt-4" onClick={startCompose}>
        {currentVersion ? 'Commit new version' : 'Set the vision'}
      </Button>
    </div>
  )
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="space-y-1">
      <SectionLabel>{title}</SectionLabel>
      <ul className="ml-4 list-disc space-y-0.5 text-xs leading-relaxed text-foreground/80 marker:text-muted-foreground/50">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  )
}
