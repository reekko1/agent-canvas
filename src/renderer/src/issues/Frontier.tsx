import { useMemo } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IssueNode, type WaveTone } from './IssueNode'
import type { IssueBoardApi } from './useIssueBoard'
import type { IssuePulse } from './useIssuePulses'
import type { Issue } from '@shared/types'

const CYAN = 'rgb(34 211 238)'

/// Lay the plan's issues out as dependency-ordered waves (Kahn over `deps`), not
/// a node-edge canvas — legible at the sheet's narrow width with zero
/// graph-layout dependency. Deps pointing outside this plan are treated as
/// satisfied; a true cycle (a human can hand-enter one) lands in a flagged group
/// instead of looping.
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

/// Fleet-pulse telemetry for a plan's issues — the numbers the board header
/// reads. `landed` waves are fully done; `frontierWidth` is the unfinished work
/// on the live wave (what a fleet would run at once). All honest counts.
export function frontierStats(issues: Issue[]): {
  waveCount: number
  landed: number
  frontierWidth: number
  done: number
  total: number
} {
  const { waves } = layerize(issues)
  const frontierIndex = waves.findIndex((w) => w.some((i) => i.status !== 'done'))
  const landed = frontierIndex === -1 ? waves.length : frontierIndex
  const frontierWidth =
    frontierIndex === -1 ? 0 : waves[frontierIndex].filter((i) => i.status !== 'done').length
  return {
    waveCount: waves.length,
    landed,
    frontierWidth,
    done: issues.filter((i) => i.status === 'done').length,
    total: issues.length,
  }
}

/// The Frontier — the plan's issue DAG as a living column of waves that drains
/// downward. Topology comes from `layerize`; LIVE status decides each wave's
/// tone: a wave whose issues are all `done` has landed (receded, dim); the first
/// not-fully-done wave is THE frontier (lit, breathing — what the fleet works
/// now); the rest wait dim below. As issues complete, a wave collapses up and the
/// frontier advances onto the next — the board's core motion. The frontier band
/// breathes even at rest (the showpiece register); the connectors flow always.
export function Frontier({
  board,
  planId,
  onOpenIssue,
  pulseFor,
}: {
  board: IssueBoardApi
  planId: string
  onOpenIssue: (issue: Issue) => void
  pulseFor: (id: string) => IssuePulse | undefined
}) {
  const issues = board.issuesByPlan(planId)
  const { waves, cycle } = useMemo(() => layerize(issues), [issues])
  // The frontier is the first wave still carrying unfinished work; -1 once every
  // wave has landed (the whole plan is done).
  const frontierIndex = useMemo(
    () => waves.findIndex((w) => w.some((i) => i.status !== 'done')),
    [waves],
  )

  const toneOf = (w: number): WaveTone => {
    if (frontierIndex === -1 || w < frontierIndex) return 'landed'
    if (w === frontierIndex) return 'frontier'
    return 'upcoming'
  }

  return (
    <div className="space-y-2">
      {issues.length === 0 && (
        <p className="px-0.5 py-1 text-xs text-muted-foreground">
          Awaiting the lead — this plan hasn't been decomposed into a wave yet.
        </p>
      )}

      {waves.map((wave, w) => {
        const tone = toneOf(w)
        const doneCount = wave.filter((i) => i.status === 'done').length
        return (
          <div key={w}>
            <WaveBand
              index={w}
              tone={tone}
              doneCount={doneCount}
              total={wave.length}
              // Replay the ignite when the frontier ADVANCES onto this wave.
              igniteKey={tone === 'frontier' ? frontierIndex : undefined}
            >
              {wave.map((issue) => (
                <IssueNode
                  key={issue.id}
                  issue={issue}
                  tone={tone}
                  pulse={pulseFor(issue.id)}
                  onOpen={() => onOpenIssue(issue)}
                />
              ))}
            </WaveBand>
            {w < waves.length - 1 && <Connector live={w >= (frontierIndex === -1 ? Infinity : frontierIndex)} />}
          </div>
        )
      })}

      {cycle.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-status-error/30 bg-status-error/10 p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] text-status-error">
            <AlertTriangle className="size-3" /> Dependency cycle — fix deps to order these.
          </div>
          <div className="space-y-1.5">
            {cycle.map((issue) => (
              <IssueNode
                key={issue.id}
                issue={issue}
                tone="upcoming"
                pulse={pulseFor(issue.id)}
                onOpen={() => onOpenIssue(issue)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/// One wave: a header naming its place in the drain, then its nodes. The frontier
/// wave is wrapped in a breathing, faintly cyan-tinted band so it reads as the
/// live edge; landed/upcoming waves are bare.
function WaveBand({
  index,
  tone,
  doneCount,
  total,
  igniteKey,
  children,
}: {
  index: number
  tone: WaveTone
  doneCount: number
  total: number
  igniteKey?: number
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <WaveHeader index={index} tone={tone} doneCount={doneCount} total={total} />
      {tone === 'frontier' ? (
        <div
          key={igniteKey}
          className="wave-ignite frontier-breathe space-y-1.5 rounded-xl p-1.5"
          style={{ backgroundColor: 'rgb(34 211 238 / 0.04)' }}
        >
          {children}
        </div>
      ) : (
        <div className="space-y-1.5">{children}</div>
      )}
    </div>
  )
}

function WaveHeader({
  index,
  tone,
  doneCount,
  total,
}: {
  index: number
  tone: WaveTone
  doneCount: number
  total: number
}) {
  if (tone === 'frontier') {
    return (
      <div className="flex items-center gap-1.5 text-[11px] font-medium">
        <span className="inline-flex items-center gap-1.5" style={{ color: CYAN }}>
          <span className="size-1.5 rounded-full" style={{ backgroundColor: CYAN }} />
          NOW
        </span>
        <span className="text-muted-foreground/70">· the frontier</span>
        {doneCount > 0 && (
          <span className="text-muted-foreground/50">
            · {doneCount}/{total} landed
          </span>
        )}
      </div>
    )
  }
  if (tone === 'landed') {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
        <Check className="size-3" style={{ color: 'var(--status-done)' }} />
        <span className="font-medium">Wave {index + 1}</span>
        <span>· landed</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/55">
      <span className="font-medium">Wave {index + 1}</span>
      <span>· queued</span>
    </div>
  )
}

/// The dependency connector between two waves — a short centred channel. Live
/// (at or past the frontier) it flows downward (data travelling the DAG); behind
/// the frontier it's a quiet settled rule.
function Connector({ live }: { live: boolean }) {
  return (
    <div className="flex justify-center py-1" aria-hidden>
      <span className={cn('h-3.5 w-px', live ? 'dag-flow' : 'bg-border')} />
    </div>
  )
}
