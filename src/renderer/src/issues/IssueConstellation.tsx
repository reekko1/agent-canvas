import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  ISSUE_STATUS_META,
  KindGlyph,
  SPRINT_STATE_META,
  SprintStateBadge,
  StatusDot,
} from './badges'
import { Constellation } from './Constellation'
import { ConceptionField } from './ConceptionField'
import { ConceptionDossier } from './ConceptionDossier'
import { IssueDossier } from './IssueDossier'
import { frontierStats } from './dag'
import { useIssuePulses } from './useIssuePulses'
import type { IssueBoardApi } from './useIssueBoard'
import type { Conception, Sprint } from '@shared/types'

const CYAN = 'rgb(34 211 238)'

/// The issues takeover — the view breaks out of the side sheet into a full-
/// viewport gravity well. The master-stack dims and recedes behind a dark space;
/// the vision burns at the centre as a sun, the selected sprint's issue-DAG
/// orbits it, and the bright frontier ring sweeps inward as the fleet works. Pure
/// observation: hover an orb for a readout, click it for the read-only dossier,
/// Esc to return to the fleet. The only human control is a realignment escalation.
export function IssueConstellation({
  projectId,
  board,
  onClose,
}: {
  projectId: string | null
  board: IssueBoardApi
  onClose: () => void
}) {
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(null)
  const [openIssueId, setOpenIssueId] = useState<string | null>(null)
  const [conceptionOpen, setConceptionOpen] = useState(false)
  const [hovered, setHovered] = useState<{ title: string; status: string; owner: string | null } | null>(null)

  // A live deliberation takes the centre stage unless you've clicked into a specific
  // sprint; otherwise the selected sprint (or the first).
  const explicitSprint = useMemo(
    () => (selectedSprintId ? board.sprints.find((s) => s.id === selectedSprintId) ?? null : null),
    [board.sprints, selectedSprintId],
  )
  // A live tournament OR a lingering abstention takes the centre stage — BOTH must
  // override defaulting into an (old/done) sprint, else the abstention "needs you" is
  // hidden behind a stale completed sprint. Selecting a sprint via the rail still wins.
  const pendingConception = useMemo(
    () => board.liveConception ?? board.conceptions.find((c) => c.state === 'abstained') ?? null,
    [board.liveConception, board.conceptions],
  )
  const selected = useMemo(
    () => explicitSprint ?? (pendingConception ? null : board.sprints[0] ?? null),
    [explicitSprint, pendingConception, board.sprints],
  )
  const conception: Conception | null = selected ? null : pendingConception
  // The dossier always shows the latest deliberation — including a DECIDED one that is
  // now hidden behind its sprint. (`conception` is the live/abstained centre-stage
  // field; this is newest-of-any-state, so a finished tournament's bracket — the
  // "why this sprint?" record — stays one click away.)
  const latestConception = board.conceptions[0] ?? null
  const dossierConception = conception ?? latestConception

  const visiblePlans = useMemo(() => {
    if (!selected) return []
    const plans = board.plansBySprint(selected.id)
    const approved = plans.filter((p) => p.approved)
    return approved.length ? approved : plans
  }, [selected, board])

  const issues = useMemo(
    () => visiblePlans.flatMap((p) => board.issuesByPlan(p.id)),
    [visiblePlans, board],
  )
  const stats = useMemo(() => frontierStats(issues), [issues])
  const pulseFor = useIssuePulses(issues)

  const openIssue = openIssueId ? issues.find((i) => i.id === openIssueId) ?? null : null
  const visionEssence = board.currentVersion?.body?.trim() || undefined

  // Esc steps back: close the dossier first, then the whole takeover.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (openIssueId) setOpenIssueId(null)
      else if (conceptionOpen) setConceptionOpen(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openIssueId, conceptionOpen, onClose])

  // Drop the dossier flag only when there's NO deliberation left to show at all, so a
  // stale Esc isn't swallowed by an invisible panel (a decided bracket stays openable).
  useEffect(() => {
    if (!dossierConception) setConceptionOpen(false)
  }, [dossierConception])

  return (
    <div className="dark fixed inset-0 z-[60] text-white" style={{ WebkitAppRegion: 'no-drag' }}>
      {/* The fleet recedes: dim + blur the canvas behind into a faint ghost, then
          deep space over it (stars are transparent, so the ghost shows through). */}
      <div className="takeover-in absolute inset-0 bg-[#04050a]/92 backdrop-blur-2xl" />
      <div className="starfield absolute inset-0" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#05060c]/55" />

      {/* Draggable top strip (the window has no title bar). */}
      <div className="absolute inset-x-0 top-0 h-11" style={{ WebkitAppRegion: 'drag' }} />

      {!projectId ? (
        <Centered>Open a canvas — each one keeps its own vision and sprints.</Centered>
      ) : (
        <div className="constellation-in absolute inset-0">
          {/* The spatial field — sun + orbiting waves. Always rendered: the vision
              sun persists even with no sprint/plan/issues. */}
          <Constellation
            issues={issues}
            pulseFor={pulseFor}
            charge={stats.charge}
            visionEssence={visionEssence}
            selectedId={openIssueId}
            onSelect={(i) => setOpenIssueId(i.id)}
            onHover={(i) =>
              setHovered(i ? { title: i.title, status: i.status, owner: i.owner } : null)
            }
          />

          {/* The pre-ignition deliberation — contender proto-stars over the sun. */}
          {conception && (
            <ConceptionField conception={conception} onOpen={() => setConceptionOpen(true)} />
          )}

          {/* A decided deliberation is hidden behind its sprint (or sits in the gap
              before the sprint forms) — keep its bracket one click away. */}
          {latestConception && !conception && (
            <button
              onClick={() => setConceptionOpen(true)}
              className="pointer-events-auto absolute bottom-6 left-6 z-10 flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/60 backdrop-blur-md transition-colors hover:bg-white/10 hover:text-white/90"
              title="View the strategist's deliberation — the idea tournament behind this canvas"
            >
              <Sparkles className="size-3.5" />
              <span>Deliberation</span>
              <span className="text-white/35">{latestConception.candidates.length} ideas</span>
            </button>
          )}

          {/* Hero — the outcome headline + fleet-pulse, the typographic anchor. */}
          {selected ? (
            <div className="pointer-events-none absolute left-8 top-16 max-w-[40%]">
              <div className="pointer-events-auto mb-2 flex items-center gap-2">
                <SprintStateBadge state={selected.state} />
                <span className="font-mono text-[11px] text-white/40">
                  v{board.versions.find((v) => v.id === selected.visionVersionRef)?.n ?? '?'}
                </span>
              </div>
              <h1 className="text-[28px] font-semibold leading-[1.1] tracking-tight text-white drop-shadow-[0_0_24px_rgba(34,211,238,0.25)]">
                {selected.title || selected.outcome || 'Untitled sprint'}
              </h1>
              {selected.outcome && (
                <p className="mt-2 max-w-md text-sm leading-relaxed text-white/70">
                  {selected.outcome}
                </p>
              )}
              {selected.gapRationale && (
                <p className="mt-2 max-w-md text-xs leading-relaxed text-white/45">
                  {selected.gapRationale}
                </p>
              )}
              <div className="mt-4">
                <FleetPulse stats={stats} distance={board.latestDistance?.note} />
              </div>
            </div>
          ) : conception ? (
            <ConceptionHero conception={conception} />
          ) : (
            <Centered>
              No sprint in flight — the strategist charts the next course toward the vision.
            </Centered>
          )}

          {/* Awaiting states sit under the sun (the vision still burns). */}
          {selected && visiblePlans.length === 0 && (
            <UnderSun>Awaiting the planner — no plan delivered for this sprint yet.</UnderSun>
          )}
          {selected && visiblePlans.length > 0 && issues.length === 0 && (
            <UnderSun>Awaiting the lead — this plan hasn't been decomposed yet.</UnderSun>
          )}

          {/* The sprint rail — switch which constellation you watch. */}
          {board.sprints.length > 0 && (
            <SprintRail
              board={board}
              sprints={board.sprints}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedSprintId}
            />
          )}

          {/* The one human control: a stranded sprint's realignment escalation. */}
          {selected?.state === 'REALIGNMENT_PENDING' && selected.realignment && (
            <RealignEscalation board={board} sprint={selected} />
          )}

          {/* Hover readout — the instrument's live caption. */}
          <HoverReadout hovered={hovered} />
        </div>
      )}

      {/* Return-to-fleet. */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        title="Return to the fleet (Esc)"
        aria-label="Close"
        className="absolute right-3 top-3 z-30 text-white/60 hover:text-white"
      >
        <X />
      </Button>

      {/* The dossier — a read-only record when an orb is selected. */}
      {openIssue && (
        <aside className="takeover-in absolute right-0 top-0 z-20 flex h-full w-[360px] flex-col border-l border-white/10 bg-[#0a0c14]/85 backdrop-blur-xl">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-3">
            <KindGlyph kind={openIssue.kind} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white">
              {openIssue.title}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setOpenIssueId(null)}
              aria-label="Close dossier"
              className="text-white/60 hover:text-white"
            >
              <X />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <IssueDossier issue={openIssue} siblings={board.issuesByPlan(openIssue.planRef)} />
          </div>
        </aside>
      )}

      {/* The deliberation's read-only bracket — why the fleet is building what it is. */}
      {conceptionOpen && dossierConception && (
        <aside className="takeover-in absolute right-0 top-0 z-20 flex h-full w-[360px] flex-col border-l border-white/10 bg-[#0a0c14]/85 backdrop-blur-xl">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-3">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white">
              Strategist deliberation
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setConceptionOpen(false)}
              aria-label="Close deliberation"
              className="text-white/60 hover:text-white"
            >
              <X />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <ConceptionDossier conception={dossierConception} />
          </div>
        </aside>
      )}
    </div>
  )
}

/// The conception hero — the deliberation's headline, mirroring the sprint hero: the
/// live tournament, the idea forming, or the abstention (the one "needs you" moment).
function ConceptionHero({ conception }: { conception: Conception }) {
  // This view only ever receives a live (deliberating) or abstained conception — a
  // decided one becomes the orbiting sprint, so there is no "decided" state here.
  const abstained = conception.state === 'abstained'
  return (
    <div className="pointer-events-none absolute left-8 top-16 max-w-[40%]">
      <div className="pointer-events-auto mb-2 flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
            abstained ? 'bg-status-blocked/15 text-status-blocked' : 'bg-cyan-400/15 text-cyan-300',
          )}
        >
          <span
            className={cn('size-1.5 rounded-full', abstained ? 'needs-you' : 'proto-star')}
            style={{ backgroundColor: 'currentColor' }}
          />
          {abstained ? 'Needs you' : 'Deliberating'}
        </span>
      </div>
      <h1 className="text-[28px] font-semibold leading-[1.1] tracking-tight text-white drop-shadow-[0_0_24px_rgba(34,211,238,0.25)]">
        {abstained ? 'No clear next sprint' : 'Choosing the next sprint'}
      </h1>
      {conception.gapRead && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-white/70">{conception.gapRead}</p>
      )}
      {abstained ? (
        <p className="mt-2 max-w-md text-xs leading-relaxed text-status-blocked/90">
          {conception.abstainReason ||
            'The strategist found nothing that clearly serves the vision. Edit the vision, or start a sprint yourself.'}
        </p>
      ) : (
        <p className="mt-2 max-w-md text-xs leading-relaxed text-white/45">
          {conception.candidates.length} ideas competing — the field brightens as the tournament resolves.
        </p>
      )}
    </div>
  )
}

function FleetPulse({
  stats,
  distance,
}: {
  stats: ReturnType<typeof frontierStats>
  distance?: string
}) {
  return (
    <div className="pointer-events-auto flex flex-col gap-1.5 text-white/70">
      <div className="flex items-center gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5" title="issues on the frontier (active now)">
          <span className="size-1.5 rounded-full" style={{ backgroundColor: CYAN, boxShadow: `0 0 8px ${CYAN}` }} />
          <span className="tabular-nums text-white">{stats.frontierWidth}</span> live
        </span>
        <span className="text-white/25">·</span>
        <span className="tabular-nums">
          {stats.landed}/{stats.waveCount} waves
        </span>
        {stats.total > 0 && (
          <span className="tabular-nums">{Math.round(stats.charge * 100)}%</span>
        )}
      </div>
      {distance && (
        <div className="max-w-xs text-[11px] leading-relaxed text-white/40">
          <span className="uppercase tracking-wider text-white/30">distance</span> {distance}
        </div>
      )}
    </div>
  )
}

/// The sprint rail — every sprint as a chip you can switch to (the fleet's slate
/// of outcomes, at a glance). The stranded ones pulse amber.
function SprintRail({
  board,
  sprints,
  selectedId,
  onSelect,
}: {
  board: IssueBoardApi
  sprints: Sprint[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="absolute bottom-6 left-1/2 z-10 flex max-w-[70vw] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-full border border-white/10 bg-white/5 px-2 py-1.5 backdrop-blur-md">
      {sprints.map((s) => {
        const meta = SPRINT_STATE_META[s.state]
        const issues = board.plansBySprint(s.id).flatMap((p) => board.issuesByPlan(p.id))
        const done = issues.filter((i) => i.status === 'done').length
        const active = s.id === selectedId
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition-colors',
              active ? 'bg-white/15 text-white' : 'text-white/55 hover:bg-white/10 hover:text-white/85',
            )}
            title={s.outcome || s.title}
          >
            <StatusDot
              color={meta?.color ?? 'var(--status-idle)'}
              className={s.state === 'REALIGNMENT_PENDING' ? 'node-blocked' : undefined}
            />
            <span className="max-w-[160px] truncate">{s.title || s.outcome || 'Untitled sprint'}</span>
            {issues.length > 0 && (
              <span className="tabular-nums text-white/35">
                {done}/{issues.length}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function RealignEscalation({ board, sprint }: { board: IssueBoardApi; sprint: Sprint }) {
  const versionN = (id: string): number | undefined => board.versions.find((v) => v.id === id)?.n
  const r = sprint.realignment!
  return (
    <div className="absolute left-1/2 top-16 z-20 w-[380px] -translate-x-1/2 space-y-2.5 rounded-xl border border-status-blocked/40 bg-[#1a1206]/80 p-3.5 backdrop-blur-md shadow-[0_0_40px_rgba(229,142,0,0.2)]">
      <div className="flex items-start gap-2 text-xs leading-relaxed text-status-blocked">
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
        <span>
          The vision moved v{versionN(r.fromVisionVersion) ?? '?'} → v
          {versionN(r.toVisionVersion) ?? '?'}. This sprint needs your call.
        </span>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => board.resolveRealignment(sprint.id, 'aligned')}>
          Still aligned
        </Button>
        <Button
          variant="ghost"
          className="text-white/60 hover:text-white"
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

function HoverReadout({
  hovered,
}: {
  hovered: { title: string; status: string; owner: string | null } | null
}) {
  if (!hovered) return null
  const meta = ISSUE_STATUS_META[hovered.status as keyof typeof ISSUE_STATUS_META]
  return (
    <div className="pointer-events-none absolute bottom-20 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-black/50 px-3 py-1.5 text-xs text-white/85 backdrop-blur-md">
      <StatusDot color={meta?.color ?? CYAN} />
      <span className="font-medium">{hovered.title}</span>
      <span className="text-white/40">{meta?.label ?? hovered.status}</span>
      {hovered.owner && <span className="text-white/40">· {hovered.owner}</span>}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-white/50">
      {children}
    </div>
  )
}

/// A whisper just beneath the sun — the awaiting states, where the vision still burns.
function UnderSun({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 mt-[120px] w-[320px] -translate-x-1/2 text-center text-xs leading-relaxed text-white/45">
      {children}
    </div>
  )
}
