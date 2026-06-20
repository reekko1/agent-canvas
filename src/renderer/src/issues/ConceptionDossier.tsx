import { cn } from '@/lib/utils'
import type { Conception } from '@shared/types'

/// The read-only record of a strategist deliberation — the recorded bracket. The
/// gap it read, the winner (or the abstention), and the full field ranked by final
/// Bradley-Terry rating with each idea's lens and the round it was culled in. This
/// is the answer to "why is the fleet building this?" — and, on an abstention, the
/// trail of what the unattended head considered before asking you to steer.
export function ConceptionDossier({ conception }: { conception: Conception }) {
  const ranked = [...conception.candidates].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
  const winner = conception.candidates.find((c) => c.id === conception.winnerIdeaRef)
  const heading =
    conception.state === 'decided' ? 'Winner' : conception.state === 'abstained' ? 'Abstained' : 'Leading'

  return (
    <div className="space-y-4 text-sm">
      {conception.gapRead && (
        <section>
          <H>The gap</H>
          <p className="leading-relaxed text-white/70">{conception.gapRead}</p>
        </section>
      )}

      <section>
        <H>{heading}</H>
        {conception.state === 'abstained' ? (
          <p className="leading-relaxed text-status-blocked">
            {conception.abstainReason || 'No idea cleared the bar — this canvas needs your steering.'}
          </p>
        ) : winner ? (
          <div className="rounded-lg border border-cyan-400/30 bg-cyan-400/5 p-2.5">
            <div className="font-medium text-white">{winner.idea}</div>
            <div className="mt-1 text-xs leading-relaxed text-white/55">{winner.why}</div>
          </div>
        ) : (
          <p className="text-white/50">The tournament is still running.</p>
        )}
      </section>

      <section>
        <H>The field · {ranked.length}</H>
        <ul className="space-y-1.5">
          {ranked.map((c) => {
            const isWinner = c.id === conception.winnerIdeaRef
            const culled = c.eliminatedRound != null && !isWinner
            return (
              <li key={c.id} className="flex items-baseline gap-2 text-xs">
                <span className="w-9 shrink-0 tabular-nums text-white/35">{(c.rating ?? 0).toFixed(2)}</span>
                <span className="min-w-0 flex-1">
                  <span className={cn(isWinner ? 'text-white' : culled ? 'text-white/40' : 'text-white/70')}>
                    {c.idea}
                  </span>
                  <span className="ml-1 text-white/30">
                    {c.lens}
                    {culled ? ` · cut R${c.eliminatedRound}` : ''}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

function H({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[11px] uppercase tracking-wider text-white/35">{children}</div>
}
