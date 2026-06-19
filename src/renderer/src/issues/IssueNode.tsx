import { CircleDashed, Link2 } from 'lucide-react'
import { relativeFromSeconds } from '@shared/time'
import { cn } from '@/lib/utils'
import {
  IssueStatusBadge,
  KindGlyph,
  Tag,
  VerdictMark,
  VerdictPill,
  nodeMotionClass,
} from './badges'
import { SectionLabel } from './ui'
import type { IssuePulse } from './useIssuePulses'
import type { Issue } from '@shared/types'

/// A wave on the Frontier: `frontier` is the lit, breathing band the fleet works
/// right now; `landed` waves have receded (every issue done); `upcoming` waves
/// wait dim below. The tone drives both the node's brightness and whether its
/// status-driven ambient motion runs (only the frontier moves, so a stalled board
/// never fakes activity).
export type WaveTone = 'frontier' | 'landed' | 'upcoming'

/// One issue as a living cell — pure observation, never a control. Calm by
/// default: a kind glyph, the title, a quiet right cluster (deps · last verdict ·
/// status · owner). On the frontier it wears its status motion (in-progress
/// breathes cyan, blocked pulses amber); a fresh `done` fires the radial
/// `issue-land` ripple + a green settle; a fresh verdict flashes a coloured ring.
/// Clicking opens the read-only dossier — nothing here is edited by hand.
export function IssueNode({
  issue,
  tone,
  pulse,
  onOpen,
}: {
  issue: Issue
  tone: WaveTone
  pulse: IssuePulse | undefined
  onOpen: () => void
}) {
  const motion = tone === 'frontier' ? nodeMotionClass(issue.status) : ''
  const lastVerdict = issue.verdicts[issue.verdicts.length - 1]
  const ringColor = pulse
    ? pulse.kind === 'verdict-issues'
      ? 'var(--status-blocked)'
      : 'var(--status-done)'
    : null

  return (
    <button
      onClick={onOpen}
      className={cn(
        'group relative flex w-full items-center gap-2 rounded-lg border bg-card px-2.5 py-2 text-left transition-[opacity,box-shadow] duration-300 hover:border-ring/40',
        tone === 'frontier' ? 'border-border' : 'border-border/60',
        tone === 'landed' && 'opacity-55 hover:opacity-90',
        tone === 'upcoming' && 'opacity-65 hover:opacity-95',
        motion,
      )}
    >
      {pulse?.kind === 'land' && <span key={pulse.nonce} className="issue-land" />}
      {ringColor && (
        <span
          key={`ring-${pulse!.nonce}`}
          aria-hidden
          className="pulse-ring-anim pointer-events-none absolute inset-0 rounded-lg"
          style={{
            boxShadow: `0 0 0 1.5px ${ringColor}, 0 0 16px 1px color-mix(in srgb, ${ringColor} 45%, transparent)`,
            animation: 'pulse-ring 1.4s ease-out both',
          }}
        />
      )}

      <KindGlyph kind={issue.kind} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{issue.title}</span>
      {issue.deps.length > 0 && (
        <span
          className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground/80"
          title={`depends on ${issue.deps.length}`}
        >
          <Link2 className="size-3" />
          {issue.deps.length}
        </span>
      )}
      {lastVerdict && <VerdictMark verdict={lastVerdict.verdict} />}
      <IssueStatusBadge status={issue.status} />
      <OwnerAvatar owner={issue.owner} />
    </button>
  )
}

/// The owner is first-class: a faint dashed ring when unclaimed, a compact chip
/// once a worker card owns it (the link from an issue — WHAT — to a card — WHO).
function OwnerAvatar({ owner }: { owner: string | null }) {
  if (!owner)
    return (
      <CircleDashed className="size-4 shrink-0 text-muted-foreground/40" aria-label="unassigned" />
    )
  return (
    <span
      className="inline-flex max-w-[88px] items-center truncate rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground"
      title={`owner: ${owner}`}
    >
      {owner}
    </span>
  )
}

const rel = (ms: number): string => relativeFromSeconds(ms / 1000)

/// The issue dossier (rendered inside the bottom `Drawer`): a READ-ONLY record of
/// what the fleet did — the brief (description / acceptance), the live facts
/// (status · owner · deps), the audit trail (verdicts the auditor posted), and
/// the worker's notes. No inputs, no controls: the human watches, the agents act.
export function IssueDetail({ issue, siblings }: { issue: Issue; siblings: Issue[] }) {
  const titleOf = (id: string): string =>
    siblings.find((s) => s.id === id)?.title ?? id.slice(0, 8)
  const deps = issue.deps.map(titleOf)
  const needsDecision = issue.verdicts.some(
    (v) => v.verdict === 'ISSUES' && v.disposition === 'needs-decision',
  )

  return (
    <div className="space-y-3">
      {needsDecision && (
        <div className="rounded-md border border-status-blocked/40 bg-status-blocked/10 px-2.5 py-1.5 text-[11px] font-medium text-status-blocked">
          Escalated — an audit needs a human decision.
        </div>
      )}

      {issue.description && (
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
          {issue.description}
        </p>
      )}
      {issue.verify && (
        <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/70">Verify</span> {issue.verify}
        </p>
      )}

      {/* Live facts — observed, not set. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <IssueStatusBadge status={issue.status} />
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          owner
          <span className="text-foreground/70">{issue.owner ?? 'unassigned'}</span>
        </span>
        <KindGlyph kind={issue.kind} />
      </div>

      {deps.length > 0 && (
        <div className="space-y-1">
          <SectionLabel>Depends on</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {deps.map((t, i) => (
              <Tag key={i}>
                <span className="max-w-[180px] truncate">{t}</span>
              </Tag>
            ))}
          </div>
        </div>
      )}

      {issue.verdicts.length > 0 && (
        <div className="space-y-1.5">
          <SectionLabel count={issue.verdicts.length}>Audit trail</SectionLabel>
          <div className="space-y-1.5">
            {issue.verdicts.map((v) => (
              <div key={v.id} className="space-y-1 rounded-md border border-border bg-muted/20 p-2">
                <div className="flex items-center gap-2">
                  <VerdictPill verdict={v.verdict} />
                  {v.disposition && (
                    <span
                      className="text-[11px] font-medium"
                      style={{
                        color:
                          v.disposition === 'needs-decision'
                            ? 'var(--status-blocked)'
                            : 'var(--muted-foreground)',
                      }}
                    >
                      {v.disposition}
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground/70">
                    {v.author} · {rel(v.postedAt)}
                  </span>
                </div>
                {v.findings && (
                  <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                    {v.findings}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {issue.comments.length > 0 && (
        <div className="space-y-1.5">
          <SectionLabel count={issue.comments.length}>Notes</SectionLabel>
          <div className="space-y-1.5">
            {issue.comments.map((c) => (
              <p key={c.id} className="text-xs leading-relaxed">
                <span className="font-medium text-foreground/70">{c.author}</span>{' '}
                <span className="text-muted-foreground/60">{rel(c.postedAt)}</span>{' '}
                <span className="text-foreground/80">{c.body}</span>
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
