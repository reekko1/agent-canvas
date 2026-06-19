import { relativeFromSeconds } from '@shared/time'
import { IssueStatusBadge, KindGlyph, Tag, VerdictPill } from './badges'
import { SectionLabel } from './ui'
import type { Issue } from '@shared/types'

const rel = (ms: number): string => relativeFromSeconds(ms / 1000)

/// The issue dossier — a READ-ONLY record of what the fleet did, surfaced when an
/// orb is selected in the constellation. The brief (description / acceptance), the
/// live facts (status · owner · deps), the audit trail (verdicts the auditor
/// posted), and the worker's notes. No inputs, no controls: the human watches.
/// Rendered inside a `dark`-scoped panel, so the shared atoms read correctly.
export function IssueDossier({ issue, siblings }: { issue: Issue; siblings: Issue[] }) {
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
