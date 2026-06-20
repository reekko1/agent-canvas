import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { Conception, Idea } from '@shared/types'

const CYAN = 'rgb(34 211 238)'
const STAR = 'rgb(180 210 255)'

/// The pre-ignition deliberation, made visible — the constellation's missing state.
/// While the strategist's tournament runs, its candidate ideas hang around the
/// vision-sun as **contender proto-stars**: brighter and larger the higher their
/// Bradley-Terry rating, culled ones receded and dim at the rim, and the winner (once
/// decided) ignited and pulled toward the core. Pure observation: hover a star for its
/// headline, click anywhere to open the read-only bracket dossier. The sun + starfield
/// come from <Constellation> beneath (rendered with no issues); this only adds the
/// contenders, so the same gravity well shows the choosing and then the work.
export function ConceptionField({
  conception,
  onOpen,
}: {
  conception: Conception
  onOpen: () => void
}) {
  const [hover, setHover] = useState<Idea | null>(null)
  const cands = conception.candidates
  const maxRating = Math.max(0.0001, ...cands.map((c) => c.rating ?? 0))
  const winnerId = conception.winnerIdeaRef

  return (
    <>
      <div className="constellation-in pointer-events-none absolute inset-0">
        {cands.map((c, i) => {
          const angle = (i / Math.max(1, cands.length)) * Math.PI * 2 - Math.PI / 2
          const norm = Math.min(1, (c.rating ?? 0) / maxRating) // 0..1 within this field
          const isWinner = c.id === winnerId
          const culled = c.eliminatedRound != null && !isWinner
          // Winner pulled to the core (ignition); culled pushed to the rim; the rest
          // sit mid-field, the stronger drawn a little inward.
          const radius = isWinner ? 15 : culled ? 41 : 32 - norm * 7 // vmin from centre
          const x = 50 + Math.cos(angle) * radius
          const y = 50 + Math.sin(angle) * radius
          const size = isWinner ? 20 : 7 + norm * 9 // px
          const opacity = culled ? 0.26 : 0.5 + norm * 0.5
          const color = isWinner ? CYAN : STAR
          const glow = isWinner ? 30 : 5 + norm * 15
          return (
            <button
              key={c.id}
              className={cn(
                'pointer-events-auto absolute rounded-full',
                isWinner ? 'proto-winner' : culled ? 'proto-culled' : 'proto-star',
              )}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                width: size,
                height: size,
                transform: 'translate(-50%, -50%)',
                opacity,
                backgroundColor: color,
                boxShadow: `0 0 ${glow}px ${color}`,
              }}
              onMouseEnter={() => setHover(c)}
              onMouseLeave={() => setHover((h) => (h === c ? null : h))}
              onClick={onOpen}
              aria-label={c.idea}
            />
          )
        })}
      </div>

      {/* Hover caption — the contender's headline, lens, and rating. */}
      {hover && (
        <div className="pointer-events-none absolute bottom-20 left-1/2 z-10 flex max-w-[60vw] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-black/50 px-3 py-1.5 text-xs text-white/85 backdrop-blur-md">
          <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: CYAN }} />
          <span className="truncate font-medium">{hover.idea}</span>
          <span className="shrink-0 text-white/40">{hover.lens}</span>
          {hover.rating != null && (
            <span className="shrink-0 tabular-nums text-white/40">· {hover.rating.toFixed(2)}</span>
          )}
        </div>
      )}
    </>
  )
}
