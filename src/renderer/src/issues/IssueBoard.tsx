import { useMemo, useState } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SheetShell } from '../canvas/SheetShell'
import { KindGlyph, ProgressMeter, SprintStateBadge, Tag, VerdictPill } from './badges'
import { Drawer, EmptyState } from './ui'
import { SprintSwitcher } from './SprintSwitcher'
import { Frontier, frontierStats } from './Frontier'
import { IssueDetail } from './IssueNode'
import { useIssuePulses } from './useIssuePulses'
import type { IssueBoardApi } from './useIssueBoard'
import type { Plan, Sprint } from '@shared/types'

const CYAN = 'rgb(34 211 238)'

/// The Issues sheet — an observation deck for a self-running fleet, not a console.
/// Nothing here is created or flipped by hand: the strategist conceives sprints,
/// the planner writes plans, the lead decomposes, workers execute and auditors
/// verdict — all over MCP. The human watches. A pinned header (the read-only
/// sprint selector + fleet-pulse) sits over the scrolling body: the demoted plan
/// band (read-only) and the living **Frontier**. The only thing the human ever
/// touches is an escalation the system raises (a stranded sprint's realignment) —
/// and authoring the vision, which lives on the other sheet.
export function IssueBoard({
  projectId,
  board,
  onCollapse,
}: {
  projectId: string | null
  board: IssueBoardApi
  onCollapse: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openIssueId, setOpenIssueId] = useState<string | null>(null)

  const selected = useMemo(
    () => board.sprints.find((s) => s.id === selectedId) ?? board.sprints[0] ?? null,
    [board.sprints, selectedId],
  )

  const allPlans = useMemo(
    () => (selected ? board.plansBySprint(selected.id) : []),
    [selected, board.plansBySprint],
  )
  // Gate #1 decides the plan: while every draft is unapproved they all show on the
  // board; the moment one is approved the losing drafts stop being surfaced.
  const visiblePlans = useMemo(() => {
    const approved = allPlans.filter((p) => p.approved)
    return approved.length ? approved : allPlans
  }, [allPlans])

  const sprintIssues = useMemo(
    () => visiblePlans.flatMap((p) => board.issuesByPlan(p.id)),
    [visiblePlans, board.issuesByPlan],
  )
  const stats = useMemo(() => frontierStats(sprintIssues), [sprintIssues])
  const pulseFor = useIssuePulses(sprintIssues)

  const openIssue = openIssueId ? sprintIssues.find((i) => i.id === openIssueId) ?? null : null

  return (
    <SheetShell
      title={<span className="text-[13px] font-semibold text-foreground">Issues</span>}
      onCollapse={onCollapse}
    >
      {!projectId ? (
        <EmptyState>Open a canvas — each one keeps its own sprints and issues.</EmptyState>
      ) : (
        <div className="frontier-field relative flex h-full flex-col">
          {/* Pinned header: which outcome am I watching, and how is the fleet doing. */}
          <div className="relative z-10 shrink-0 space-y-2 border-b border-border bg-card/80 px-3 pb-2.5 pt-3 backdrop-blur-sm">
            <SprintSwitcher board={board} selected={selected} onSelect={setSelectedId} />
            {selected && (
              <div className="flex items-center gap-2">
                <SprintStateBadge state={selected.state} />
                <FleetPulse stats={stats} distance={board.latestDistance?.note} />
              </div>
            )}
          </div>

          {/* The body: the plan band + the living Frontier. */}
          <div className="relative z-10 min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {selected ? (
              <>
                {selected.state === 'REALIGNMENT_PENDING' && selected.realignment && (
                  <RealignBanner board={board} sprint={selected} />
                )}
                {selected.gapRationale && (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground/70">Closes</span>{' '}
                    {selected.gapRationale}
                  </p>
                )}
                {allPlans.length === 0 ? (
                  <p className="px-0.5 py-1 text-xs text-muted-foreground">
                    Awaiting the planner — no plan delivered for this sprint yet.
                  </p>
                ) : (
                  visiblePlans.map((p, i) => (
                    <div key={p.id} className="space-y-3">
                      <PlanBand plan={p} label={visiblePlans.length > 1 ? `Plan ${i + 1}` : 'Plan'} />
                      <Frontier
                        board={board}
                        planId={p.id}
                        onOpenIssue={(iss) => setOpenIssueId(iss.id)}
                        pulseFor={pulseFor}
                      />
                    </div>
                  ))
                )}
              </>
            ) : (
              <EmptyState>
                No sprint in flight yet — the strategist proposes the next one toward the vision.
              </EmptyState>
            )}
          </div>

          {/* The node inspector — a read-only dossier of what the fleet did. */}
          <Drawer
            open={!!openIssue}
            onClose={() => setOpenIssueId(null)}
            title={
              openIssue && (
                <span className="flex items-center gap-2">
                  <KindGlyph kind={openIssue.kind} />
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {openIssue.title}
                  </span>
                </span>
              )
            }
          >
            {openIssue && (
              <IssueDetail issue={openIssue} siblings={board.issuesByPlan(openIssue.planRef)} />
            )}
          </Drawer>
        </div>
      )}
    </SheetShell>
  )
}

/// The fleet-pulse readout — the live telemetry strip. Counts are honest; the
/// distance reading is the latest qualitative assessment (truncated), never a
/// fake number (distance to the vision is assessed, not computed).
function FleetPulse({
  stats,
  distance,
}: {
  stats: ReturnType<typeof frontierStats>
  distance?: string
}) {
  return (
    <div className="ml-auto flex items-center gap-2.5 text-[11px] text-muted-foreground/80">
      <span className="inline-flex items-center gap-1" title="issues on the frontier (active now)">
        <span className="size-1.5 rounded-full" style={{ backgroundColor: CYAN }} />
        {stats.frontierWidth} live
      </span>
      <span className="text-muted-foreground/40">·</span>
      <span title="waves landed / total">
        {stats.landed}/{stats.waveCount} waves
      </span>
      {stats.total > 0 && <ProgressMeter done={stats.done} total={stats.total} />}
      {distance && (
        <span
          className="hidden max-w-[120px] truncate sm:inline"
          title={`distance to vision: ${distance}`}
        >
          · {distance}
        </span>
      )}
    </div>
  )
}

/// A stranded sprint (a vision bump moved past it) — the one routine escalation
/// the system raises to the human (later: the propagation-pass auditor). This and
/// vision authoring are the only places a human acts on the issue board.
function RealignBanner({ board, sprint }: { board: IssueBoardApi; sprint: Sprint }) {
  const versionN = (id: string): number | undefined => board.versions.find((v) => v.id === id)?.n
  const r = sprint.realignment!
  return (
    <div className="space-y-2 rounded-lg border border-status-blocked/30 bg-status-blocked/10 p-2.5">
      <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-status-blocked">
        <AlertTriangle className="mt-px size-3 shrink-0" />
        <span>
          The vision moved v{versionN(r.fromVisionVersion) ?? '?'} → v
          {versionN(r.toVisionVersion) ?? '?'}. This sprint needs your call.
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => board.resolveRealignment(sprint.id, 'aligned')}>
          Still aligned
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            if (confirm('Drop this sprint and its plan + issues?'))
              board.resolveRealignment(sprint.id, 'remove')
          }}
        >
          Drop
        </Button>
      </div>
    </div>
  )
}

/// The plan band — a READ-ONLY blueprint header above each plan's Frontier (the
/// issues are the hero; the plan folds away). Its approval (gate #1) is shown as
/// state, not a button: the planner self-audits and the lead approves over MCP.
function PlanBand({ plan, label }: { plan: Plan; label: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0 text-[13px] font-medium text-foreground">{label}</span>
        {plan.approved ? (
          <VerdictPill verdict="APPROVED" />
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">in review</span>
        )}
        {!open && plan.overview && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80">
            {plan.overview}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
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
      )}
    </div>
  )
}
