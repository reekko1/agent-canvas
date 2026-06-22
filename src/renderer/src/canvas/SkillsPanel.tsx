import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { SheetShell } from './SheetShell'
import { cn } from '@/lib/utils'
import { relativeFromSeconds } from '@shared/time'
import { provenanceCanvas } from '@shared/provenance'
import type { SkillView } from '@shared/types'
import type { SkillsPanelApi } from './useSkillsPanel'

function SkillRow({
  skill,
  canvasName,
}: {
  skill: SkillView
  canvasName?: (id: string) => string | undefined
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const pid = provenanceCanvas(skill.source)
  const where = pid ? canvasName?.(pid) : undefined
  const learned = skill.createdAt ? relativeFromSeconds(new Date(skill.createdAt).getTime() / 1000) : null
  const used = skill.lastUsed != null ? relativeFromSeconds(skill.lastUsed / 1000) : null
  return (
    <div className={cn('border-b border-border/60 last:border-0', skill.archived && 'opacity-60')}>
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/40"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[13px] text-foreground">{skill.name}</div>
          {skill.description && (
            <div className="truncate text-[12px] text-muted-foreground">{skill.description}</div>
          )}
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10.5px] text-muted-foreground/70">
            {learned && (
              <span>
                learned {learned} ago{where ? ` · ${where}` : ''}
              </span>
            )}
            {used && <span>· used {used} ago</span>}
            {skill.archived && <span>· archived</span>}
          </div>
        </div>
      </button>
      {open && (
        <pre className="whitespace-pre-wrap px-3 pb-3 pl-8 font-sans text-[12px] leading-relaxed text-foreground/80">
          {skill.body}
        </pre>
      )}
    </div>
  )
}

/// The Skills gallery body — read-only: a list of the mastermind's learned procedures
/// (each row expands to its full body), plus a collapsible archived section. No editing.
export function SkillsPanel({
  panel,
  canvasName,
  onCollapse,
}: {
  panel: SkillsPanelApi
  canvasName?: (id: string) => string | undefined
  onCollapse: () => void
}): React.JSX.Element {
  const [showArchived, setShowArchived] = useState(false)
  const { hydrated, active, archived } = panel
  return (
    <SheetShell
      title={<span className="text-sm font-semibold text-foreground">Skills</span>}
      subtitle={hydrated ? `${active.length} learned` : undefined}
      onCollapse={onCollapse}
      bodyClassName="overflow-y-auto"
    >
      {!hydrated ? (
        <div className="px-3 py-6 text-[12px] text-muted-foreground">Loading…</div>
      ) : active.length === 0 && archived.length === 0 ? (
        <div className="px-4 py-8 text-[12px] leading-relaxed text-muted-foreground">
          No skills yet. The mastermind hasn’t learned any procedures — they’ll appear here as
          it works the fleet.
        </div>
      ) : (
        <div>
          {active.map((s) => (
            <SkillRow key={s.name} skill={s} canvasName={canvasName} />
          ))}
          {archived.length > 0 && (
            <div className="border-t border-border">
              <button
                type="button"
                className="flex w-full items-center gap-1 px-3 py-2 text-[11px] text-muted-foreground hover:bg-muted/40"
                onClick={() => setShowArchived((v) => !v)}
              >
                <ChevronRight
                  className={cn('h-3 w-3 transition-transform', showArchived && 'rotate-90')}
                />
                {showArchived ? 'Hide' : 'Show'} {archived.length} archived
              </button>
              {showArchived &&
                archived.map((s) => <SkillRow key={s.name} skill={s} canvasName={canvasName} />)}
            </div>
          )}
        </div>
      )}
    </SheetShell>
  )
}
