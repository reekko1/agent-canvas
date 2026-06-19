import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SPRINT_STATE_META, SprintStateBadge, Tag, VerdictPill } from './badges'
import { Field, InlineComposer, TextArea, TextInput, csvToList } from './ui'
import { IssueDag } from './IssueDag'
import type { IssueBoardApi } from './useIssueBoard'
import type { Sprint, SprintState } from '@shared/types'

/// The selected sprint's detail: its outcome heading + state, then its plan
/// (gate #1 approval is the "Approve plan" action) and the plan's issue DAG. The
/// contextual moves drive the early states (draft a plan → PLAN_REVIEW, approve
/// → APPROVED, first issue → DECOMPOSED); the late states advance via the
/// explicit button — the manual stand-ins for the agent gates.
const ADVANCE: Partial<Record<SprintState, SprintState>> = {
  DECOMPOSED: 'EXECUTING',
  EXECUTING: 'OUTCOME_REVIEW',
  OUTCOME_REVIEW: 'DONE',
}

export function PlanView({ board, sprint }: { board: IssueBoardApi; sprint: Sprint }) {
  const plans = board.plansBySprint(sprint.id)
  const next = ADVANCE[sprint.state]

  return (
    <div className="flex flex-col gap-4 p-3">
      {/* The sprint is the title of this detail view — outcome, state, the gap it
          closes — then a single rule hands off to the plan + issues body. No
          nested card: the pane already is the plan view. */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold leading-snug text-foreground">
          {sprint.outcome || 'Untitled sprint'}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <SprintStateBadge state={sprint.state} />
          {next && (
            <Button variant="secondary" onClick={() => board.setSprintState(sprint.id, next)}>
              Advance to {SPRINT_STATE_META[next].label.toLowerCase()}
            </Button>
          )}
        </div>
        {sprint.gapRationale && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground/70">Closes</span> {sprint.gapRationale}
          </p>
        )}
      </div>

      {plans.length === 0 ? (
        <div className="border-t border-border pt-4">
          <PlanComposer board={board} sprint={sprint} />
        </div>
      ) : (
        plans.map((plan) => (
          <div key={plan.id} className="flex flex-col gap-4 border-t border-border pt-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-foreground">Plan</span>
                {plan.approved ? (
                  <VerdictPill verdict="APPROVED" />
                ) : (
                  <Button className="ml-auto" onClick={() => board.approvePlan(plan.id)}>
                    Approve plan
                  </Button>
                )}
              </div>
              {plan.overview && (
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                  {plan.overview}
                </p>
              )}
              {plan.stack.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {plan.stack.map((t, i) => (
                    <Tag key={i}>{t}</Tag>
                  ))}
                </div>
              )}
              {plan.structure && (
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                  {plan.structure}
                </p>
              )}
              {plan.nonGoals.length > 0 && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground/70">Non-goals</span>{' '}
                  {plan.nonGoals.join(', ')}
                </p>
              )}
            </div>
            <IssueDag board={board} planId={plan.id} />
          </div>
        ))
      )}
    </div>
  )
}

function PlanComposer({ board, sprint }: { board: IssueBoardApi; sprint: Sprint }) {
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState('')
  const [stack, setStack] = useState('')
  const [structure, setStructure] = useState('')
  const [nonGoals, setNonGoals] = useState('')

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Draft plan
      </Button>
    )
  }

  const create = (): void => {
    board.createPlan({
      sprintRef: sprint.id,
      overview: overview.trim(),
      stack: csvToList(stack),
      structure: structure.trim(),
      nonGoals: csvToList(nonGoals),
    })
    setOpen(false)
  }

  return (
    <InlineComposer submitLabel="Create plan" onSubmit={create} onCancel={() => setOpen(false)}>
      <Field label="Overview">
        <TextArea
          autoFocus
          value={overview}
          onChange={(e) => setOverview(e.target.value)}
          rows={3}
          placeholder="The blueprint in a sentence or two"
        />
      </Field>
      <Field label="Stack">
        <TextInput
          value={stack}
          onChange={(e) => setStack(e.target.value)}
          placeholder="Comma-separated"
        />
      </Field>
      <Field label="Structure / approach">
        <TextArea
          value={structure}
          onChange={(e) => setStructure(e.target.value)}
          rows={3}
          placeholder="How it's put together"
        />
      </Field>
      <Field label="Non-goals">
        <TextInput
          value={nonGoals}
          onChange={(e) => setNonGoals(e.target.value)}
          placeholder="Comma-separated"
        />
      </Field>
    </InlineComposer>
  )
}
