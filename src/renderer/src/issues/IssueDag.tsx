import { useMemo, useState } from 'react'
import { AlertTriangle, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ISSUE_KINDS, KIND_META } from './badges'
import { Chip, Field, InlineComposer, SectionLabel, Segmented, TextArea, TextInput, asIcon } from './ui'
import { IssueRow } from './IssueRow'
import type { IssueBoardApi } from './useIssueBoard'
import type { Issue, IssueKind } from '@shared/types'

const PlusIcon = asIcon(Plus)

/// Lay the plan's issues out as dependency-ordered waves (Kahn over `deps`), not
/// a node-edge canvas — legible at the sheet's narrow width with zero
/// graph-layout dependency. Wave 1 is the parallel frontier (what a fleet would
/// run at once). Deps pointing outside this plan are treated as satisfied; a true
/// cycle (a human can hand-enter one) lands in a flagged group instead of looping.
function layerize(issues: Issue[]): { waves: Issue[][]; cycle: Issue[] } {
  const ids = new Set(issues.map((i) => i.id))
  const byId = new Map(issues.map((i) => [i.id, i] as const))
  const remaining = new Set(issues.map((i) => i.id))
  const placed = new Set<string>()
  const waves: Issue[][] = []
  while (remaining.size) {
    const wave = [...remaining].filter((id) => {
      const deps = byId.get(id)?.deps ?? []
      return deps.every((d) => !ids.has(d) || placed.has(d))
    })
    if (wave.length === 0) break // cycle — stop and flag the remainder
    waves.push(wave.map((id) => byId.get(id)!))
    for (const id of wave) {
      remaining.delete(id)
      placed.add(id)
    }
  }
  return { waves, cycle: [...remaining].map((id) => byId.get(id)!) }
}

export function IssueDag({ board, planId }: { board: IssueBoardApi; planId: string }) {
  const issues = board.issuesByPlan(planId)
  const { waves, cycle } = useMemo(() => layerize(issues), [issues])
  const [adding, setAdding] = useState(false)

  return (
    <div className="space-y-3">
      <SectionLabel count={issues.length}>Issues</SectionLabel>

      {issues.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">No issues yet.</p>
      )}

      {waves.map((wave, w) => (
        <div key={w} className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <span className="font-medium">Wave {w + 1}</span>
            {w === 0 && <span>· parallel frontier</span>}
          </div>
          <div className="space-y-1.5">
            {wave.map((issue) => (
              <IssueRow key={issue.id} board={board} issue={issue} siblings={issues} />
            ))}
          </div>
        </div>
      ))}

      {cycle.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-status-error/30 bg-status-error/10 p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] text-status-error">
            <AlertTriangle className="size-3" /> Dependency cycle — fix deps to order these.
          </div>
          <div className="space-y-1.5">
            {cycle.map((issue) => (
              <IssueRow key={issue.id} board={board} issue={issue} siblings={issues} />
            ))}
          </div>
        </div>
      )}

      {adding ? (
        <IssueComposer
          board={board}
          planId={planId}
          siblings={issues}
          onDone={() => setAdding(false)}
        />
      ) : (
        <Button variant="secondary" leadingIcon={PlusIcon} onClick={() => setAdding(true)}>
          New issue
        </Button>
      )}
    </div>
  )
}

function IssueComposer({
  board,
  planId,
  siblings,
  onDone,
}: {
  board: IssueBoardApi
  planId: string
  siblings: Issue[]
  onDone: () => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [verify, setVerify] = useState('')
  const [kind, setKind] = useState<IssueKind>('task')
  const [deps, setDeps] = useState<string[]>([])

  const toggleDep = (id: string): void =>
    setDeps((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]))

  const create = (): void => {
    if (!title.trim()) return
    board.createIssue({
      planRef: planId,
      title: title.trim(),
      description: description.trim(),
      verify: verify.trim(),
      issueKind: kind,
      deps,
    })
    onDone()
  }

  return (
    <InlineComposer
      submitLabel="Create issue"
      canSubmit={!!title.trim()}
      onSubmit={create}
      onCancel={onDone}
    >
      <TextInput
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
      />
      <Field label="Kind">
        <Segmented
          value={kind}
          onChange={setKind}
          options={ISSUE_KINDS.map((k) => ({ value: k, label: KIND_META[k].label }))}
        />
      </Field>
      <Field label="Description">
        <TextArea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="The implementation steps"
        />
      </Field>
      <Field label="Verify">
        <TextArea
          value={verify}
          onChange={(e) => setVerify(e.target.value)}
          rows={2}
          placeholder="Acceptance criteria — what 'done' is checked against"
        />
      </Field>
      {siblings.length > 0 && (
        <Field label="Depends on">
          <div className="flex flex-wrap gap-1.5">
            {siblings.map((s) => (
              <Chip key={s.id} active={deps.includes(s.id)} onClick={() => toggleDep(s.id)}>
                <span className="max-w-[160px] truncate">{s.title}</span>
              </Chip>
            ))}
          </div>
        </Field>
      )}
    </InlineComposer>
  )
}
