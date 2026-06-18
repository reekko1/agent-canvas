import { useEffect, useMemo } from 'react'
import { motion } from 'framer-motion'
import { TRACER_TRAVEL_MS, type OrchestratorTarget } from '@shared/types'

// A short tracer the orchestrator fires at an agent when it acts on one: a faint
// arc draws from the chat bar to the target card, a bright pulse rides along it,
// and a ring blooms on the card as the pulse lands — then it all fades. Color is
// keyed to the action so the gesture also says what happened.
export const TRACER_COLOR: Record<OrchestratorTarget['kind'], string> = {
  spawn: 'rgb(34 211 238)', // cyan — the orchestrator identity
  send: 'rgb(34 211 238)',
  rename: 'rgb(34 211 238)',
  approve: 'rgb(251 191 36)', // amber — clearing a block
  kill: 'rgb(248 113 113)', // red — destructive
}

export interface TracerSpec {
  id: number
  from: { x: number; y: number }
  to: { x: number; y: number }
  color: string
}

const TRAVEL = TRACER_TRAVEL_MS / 1000 // seconds for the comet to travel the arc
const LINGER = 0.35 // ring bloom + fade after it lands
const TRAIL = 7 // tail dots behind the head

/** Sample a quadratic bezier into keyframe arrays, so the pulse can ride the same
 *  arc the line draws — no CSS motion-path needed. */
function arcSamples(
  from: { x: number; y: number },
  ctrl: { x: number; y: number },
  to: { x: number; y: number },
  n = 24,
): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (let k = 0; k <= n; k++) {
    const t = k / n
    const u = 1 - t
    xs.push(u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x)
    ys.push(u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y)
  }
  return { xs, ys }
}

function Tracer({ from, to, color, onDone }: TracerSpec & { onDone: () => void }): React.JSX.Element {
  // Bow the arc above the higher endpoint so it reads as reaching up and over.
  const ctrl = useMemo(
    () => ({ x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 80 }),
    [from.x, from.y, to.x, to.y],
  )
  const { xs, ys } = useMemo(() => arcSamples(from, ctrl, to), [from, ctrl, to])

  // Self-remove once the whole gesture has played out.
  useEffect(() => {
    const id = setTimeout(onDone, (TRAVEL + LINGER + 0.3) * 1000)
    return () => clearTimeout(id)
  }, [onDone])

  return (
    <svg className="pointer-events-none fixed inset-0 z-[55]" width="100%" height="100%" style={{ overflow: 'visible' }}>
      {/* The tail: dots riding the same arc as the head but each launched a beat
          later, so they lag behind it; shrinking and dimming down the tail. Each
          stays invisible until its delayed start, so the comet streaks rather than
          bunching at the origin. */}
      {Array.from({ length: TRAIL }).map((_, k) => {
        const lag = (k + 1) * 0.028
        const r = Math.max(1, 4.5 * (1 - (k + 1) / (TRAIL + 1)))
        const op = 0.5 * (1 - k / TRAIL)
        return (
          <motion.circle
            key={k}
            r={r}
            fill={color}
            style={{ filter: `drop-shadow(0 0 ${Math.max(1.5, 4 - k * 0.4)}px ${color})` }}
            initial={{ cx: from.x, cy: from.y, opacity: 0 }}
            animate={{ cx: xs, cy: ys, opacity: [0, op, op, 0] }}
            transition={{
              duration: TRAVEL,
              ease: 'easeInOut',
              delay: lag,
              opacity: { duration: TRAVEL, times: [0, 0.12, 0.85, 1], delay: lag },
            }}
          />
        )
      })}
      {/* The head: bright, glowing, fading out as it lands. */}
      <motion.circle
        r={5}
        fill={color}
        style={{ filter: `drop-shadow(0 0 9px ${color})` }}
        initial={{ cx: from.x, cy: from.y, opacity: 1 }}
        animate={{ cx: xs, cy: ys, opacity: [1, 1, 0] }}
        transition={{
          duration: TRAVEL,
          ease: 'easeInOut',
          opacity: { duration: TRAVEL, times: [0, 0.85, 1] },
        }}
      />
      {/* The ring blooming on the card as the comet lands. */}
      <motion.circle
        cx={to.x}
        cy={to.y}
        fill="none"
        stroke={color}
        strokeWidth={2}
        style={{ filter: `drop-shadow(0 0 5px ${color})` }}
        initial={{ r: 4, opacity: 0 }}
        animate={{ r: [4, 30], opacity: [0, 0.75, 0] }}
        transition={{ duration: LINGER + 0.25, delay: TRAVEL - 0.05, ease: 'easeOut' }}
      />
    </svg>
  )
}

/** Renders the live tracers; each removes itself via onDone when its gesture ends. */
export function OrchestratorTracers({
  tracers,
  onDone,
}: {
  tracers: TracerSpec[]
  onDone: (id: number) => void
}): React.JSX.Element {
  return (
    <>
      {tracers.map((t) => (
        <Tracer key={t.id} {...t} onDone={() => onDone(t.id)} />
      ))}
    </>
  )
}
