import { useState } from 'react'
import { ChevronRight, CircleDashed, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  IssueStatusBadge,
  KindGlyph,
  VerdictMark,
} from './badges'
import { Chip, SectionLabel, Segmented, Select, TextInput } from './ui'
import type { IssueBoardApi } from './useIssueBoard'
import type { Issue } from '@shared/types'

/// One issue. Collapsed, it's a calm line — kind glyph, title, then a quiet
/// right cluster (deps · last verdict · status · owner) where only the status dot
/// carries color. Expanded, it reveals description/verify, the status control,
/// dependency chips, the audit-verdict composer (manual gate #3), and comments.
/// `owner` is a first-class avatar — the seam for a future tmux-card identity link.
export function IssueRow({
  board,
  issue,
  siblings,
}: {
  board: IssueBoardApi
  issue: Issue
  siblings: Issue[]
}) {
  const [open, setOpen] = useState(false)
  const others = siblings.filter((s) => s.id !== issue.id)
  const lastVerdict = issue.verdicts[issue.verdicts.length - 1]

  const toggleDep = (id: string): void => {
    const next = issue.deps.includes(id)
      ? issue.deps.filter((d) => d !== id)
      : [...issue.deps, id]
    board.setIssueDeps(issue.id, next)
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <KindGlyph kind={issue.kind} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{issue.title}</span>
        {issue.deps.length > 0 && (
          <span
            className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground/80"
            title={`blocked by ${issue.deps.length}`}
          >
            <Link2 className="size-3" />
            {issue.deps.length}
          </span>
        )}
        {lastVerdict && <VerdictMark verdict={lastVerdict.verdict} />}
        <IssueStatusBadge status={issue.status} />
        <OwnerAvatar owner={issue.owner} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
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

          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">Status</span>
            <Select
              ariaLabel="Issue status"
              value={issue.status}
              onChange={(s) => board.setIssueStatus(issue.id, s)}
              options={ISSUE_STATUSES.map((s) => ({
                value: s,
                label: ISSUE_STATUS_META[s].label,
                color: ISSUE_STATUS_META[s].color,
              }))}
            />
          </div>

          {others.length > 0 && (
            <div className="space-y-1.5">
              <SectionLabel>Depends on</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {others.map((s) => (
                  <Chip
                    key={s.id}
                    active={issue.deps.includes(s.id)}
                    onClick={() => toggleDep(s.id)}
                  >
                    <span className="max-w-[160px] truncate">{s.title}</span>
                  </Chip>
                ))}
              </div>
            </div>
          )}

          <VerdictComposer board={board} issueId={issue.id} />
          <Comments board={board} issue={issue} />
        </div>
      )}
    </div>
  )
}

/// The owner is always shown (it's first-class): a faint dashed ring when
/// unclaimed, a compact chip once a worker card owns it.
function OwnerAvatar({ owner }: { owner: string | null }) {
  if (!owner)
    return (
      <CircleDashed
        className="size-4 shrink-0 text-muted-foreground/40"
        aria-label="unassigned"
      />
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

function VerdictComposer({ board, issueId }: { board: IssueBoardApi; issueId: string }) {
  const [verdict, setVerdict] = useState<'APPROVED' | 'ISSUES'>('APPROVED')
  const [findings, setFindings] = useState('')
  const [disposition, setDisposition] = useState<'clear-fix' | 'needs-decision'>('clear-fix')

  const post = (): void => {
    board.postVerdict(
      issueId,
      verdict,
      findings.trim(),
      verdict === 'ISSUES' ? disposition : undefined,
    )
    setFindings('')
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-muted/30 p-3">
      <SectionLabel>Audit verdict</SectionLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={verdict}
          onChange={setVerdict}
          options={[
            { value: 'APPROVED', label: 'Approved' },
            { value: 'ISSUES', label: 'Issues' },
          ]}
        />
        {verdict === 'ISSUES' && (
          <Segmented
            value={disposition}
            onChange={setDisposition}
            options={[
              { value: 'clear-fix', label: 'Clear fix' },
              { value: 'needs-decision', label: 'Needs decision' },
            ]}
          />
        )}
      </div>
      {verdict === 'ISSUES' && (
        <TextInput
          value={findings}
          onChange={(e) => setFindings(e.target.value)}
          placeholder="Findings"
        />
      )}
      <Button onClick={post}>Post verdict</Button>
    </div>
  )
}

function Comments({ board, issue }: { board: IssueBoardApi; issue: Issue }) {
  const [body, setBody] = useState('')
  const add = (): void => {
    if (!body.trim()) return
    board.comment(issue.id, body.trim())
    setBody('')
  }
  return (
    <div className="space-y-2">
      {issue.comments.length > 0 && (
        <div className="space-y-1.5">
          {issue.comments.map((c) => (
            <p key={c.id} className="text-xs leading-relaxed">
              <span className="font-medium text-foreground/70">{c.author}</span>{' '}
              <span className="text-foreground/80">{c.body}</span>
            </p>
          ))}
        </div>
      )}
      <TextInput
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add()
        }}
        placeholder="Add a comment…"
      />
    </div>
  )
}
