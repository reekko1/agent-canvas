import { AlertTriangle, Check, Circle, GitFork, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { IssueKind, IssueStatus, SprintState, VisionEditClass } from '@shared/types'

/// Presentational atoms for the issue board. Color comes from the canvas
/// `--status-*` palette (index.css) so a work-unit reads in the same language as
/// an agent card — when a real card owns an issue later, the two converge with no
/// new styling. The discipline here is restraint: one quiet dot carries status,
/// tints stay faint, and only the few badges that mean something get color.

/// A 6px status dot — the quietest possible status carrier.
export function StatusDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', className)}
      style={{ backgroundColor: color }}
    />
  )
}

/// A pill. `tint` fills it with a faint wash of `color` and colors the text;
/// without `tint` it's a dot + softened text; without `color` it's a neutral
/// secondary chip (e.g. a stack tag).
export function Tag({
  color,
  tint,
  className,
  children,
}: {
  color?: string
  tint?: boolean
  className?: string
  children: React.ReactNode
}) {
  const tinted = !!color && !!tint
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium',
        !color && 'bg-secondary text-muted-foreground',
        color && !tint && 'text-foreground/80',
        className,
      )}
      style={
        tinted
          ? { color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }
          : undefined
      }
    >
      {color && <StatusDot color={color} />}
      {children}
    </span>
  )
}

// ── Sprint state ────────────────────────────────────────────────────────────

export const SPRINT_STATE_META: Record<SprintState, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'var(--status-idle)' },
  PLAN_REVIEW: { label: 'Plan review', color: 'var(--status-waiting)' },
  APPROVED: { label: 'Approved', color: 'var(--status-running)' },
  DECOMPOSED: { label: 'Decomposed', color: 'var(--status-running)' },
  EXECUTING: { label: 'Executing', color: 'var(--status-running)' },
  OUTCOME_REVIEW: { label: 'Outcome review', color: 'var(--status-stalled)' },
  DONE: { label: 'Done', color: 'var(--status-done)' },
  REALIGNMENT_PENDING: { label: 'Needs realign', color: 'var(--status-blocked)' },
}

export function SprintStateBadge({ state }: { state: SprintState }) {
  // Fall back for an out-of-enum value (e.g. a status from before a schema change)
  // so stale data can never crash the board — show the raw value, don't throw.
  const m = SPRINT_STATE_META[state] ?? { label: String(state), color: 'var(--status-idle)' }
  return (
    <Tag color={m.color} tint>
      {m.label}
    </Tag>
  )
}

// ── Issue status ────────────────────────────────────────────────────────────

export const ISSUE_STATUS_META: Record<IssueStatus, { label: string; color: string }> = {
  backlog: { label: 'Backlog', color: 'var(--status-idle)' },
  ready: { label: 'Ready', color: 'var(--status-running)' },
  claimed: { label: 'Claimed', color: 'var(--status-waiting)' },
  in_progress: { label: 'In progress', color: 'var(--status-running)' },
  blocked: { label: 'Blocked', color: 'var(--status-blocked)' },
  done: { label: 'Done', color: 'var(--status-done)' },
  superseded: { label: 'Retired', color: 'var(--status-idle)' },
}

/// Quiet by design — a dot + muted label, no pill. Status is the one signal a
/// row always shows, so it stays calm; the loud treatments are reserved for the
/// things that interrupt (a failed verdict, a needed realignment).
export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  // Fall back for an out-of-enum value (e.g. a stale status persisted before a
  // schema change) so it renders as the raw value instead of crashing the board.
  const m = ISSUE_STATUS_META[status] ?? { label: String(status), color: 'var(--status-idle)' }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
      <StatusDot color={m.color} />
      {m.label}
    </span>
  )
}

// ── Vision edit class ───────────────────────────────────────────────────────

export const CLASS_META: Record<VisionEditClass, { label: string; color: string; hint: string }> = {
  clarification: {
    label: 'Clarification',
    color: 'var(--status-idle)',
    hint: 'Sharpens wording — invalidates nothing.',
  },
  redirection: {
    label: 'Redirection',
    color: 'var(--status-blocked)',
    hint: 'Changes direction — may strand in-flight sprints.',
  },
  expansion: {
    label: 'Expansion',
    color: 'var(--status-waiting)',
    hint: 'Opens new territory — may spawn sprints.',
  },
}

export function ClassTag({ cls }: { cls: VisionEditClass }) {
  const m = CLASS_META[cls] ?? { label: String(cls), color: 'var(--status-idle)', hint: '' }
  return (
    <Tag color={m.color} tint>
      {m.label}
    </Tag>
  )
}

// ── Audit verdict ───────────────────────────────────────────────────────────

/// The full verdict pill (plan/issue detail). APPROVED clears; ISSUES is loud.
export function VerdictPill({ verdict }: { verdict: 'APPROVED' | 'ISSUES' }) {
  const approved = verdict === 'APPROVED'
  const color = approved ? 'var(--status-done)' : 'var(--status-blocked)'
  const Icon = approved ? Check : AlertTriangle
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      <Icon className="size-3" />
      {approved ? 'Approved' : 'Issues'}
    </span>
  )
}

// ── Issue kind ──────────────────────────────────────────────────────────────

export const KIND_META: Record<
  IssueKind,
  { label: string; color: string; Icon: typeof Circle }
> = {
  task: { label: 'Task', color: 'var(--status-idle)', Icon: Circle },
  'audit-gate': { label: 'Audit gate', color: 'var(--status-done)', Icon: ShieldCheck },
  decision: { label: 'Decision', color: 'var(--status-waiting)', Icon: GitFork },
}

/// The leading glyph on an issue row. `task` (the common case) is a quiet gray
/// circle; the special kinds get color so they stand out from the field of tasks.
export function KindGlyph({ kind }: { kind: IssueKind }) {
  const { Icon, color, label } = KIND_META[kind] ?? {
    label: String(kind),
    color: 'var(--status-idle)',
    Icon: Circle,
  }
  return <Icon className="size-3.5 shrink-0" style={{ color }} strokeWidth={2} aria-label={label} />
}
