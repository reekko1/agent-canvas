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
  /** The target card's viewport rect — when present, a grid ripple energizes the
   *  window as the comet lands. Omitted for targets we can't resolve to a card. */
  rect?: { x: number; y: number; w: number; h: number }
  /** The card's corner radius, so the ripple clips to the same rounded frame. */
  radius?: number
}

const TRAVEL = TRACER_TRAVEL_MS / 1000 // seconds for the comet to travel the arc
const LINGER = 0.35 // ring bloom + fade after it lands
const TRAIL = 7 // tail dots behind the head
const RIPPLE = 0.62 // grid wavefront sweep across the landed-on window

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

/** A futuristic grid wavefront that energizes the window the comet lands on: a
 *  fine grid, lit only in an expanding ring that sweeps out from the impact point,
 *  over a brief radial flash — all clipped to the card's rounded frame. */
function GridRipple({
  rect,
  radius,
  color,
}: {
  rect: { x: number; y: number; w: number; h: number }
  radius: number
  color: string
}): React.JSX.Element {
  const cx = rect.w / 2
  const cy = rect.h / 2
  const max = Math.hypot(rect.w, rect.h) / 2 + 8 // reach the far corner, then some
  const BAND = 70 // thickness of the lit wavefront
  // `--rip` (a unitless number framer-motion interpolates) is the wavefront radius;
  // the mask reveals only a band of grid around it, so the grid streaks outward.
  const mask =
    `radial-gradient(circle at ${cx}px ${cy}px,` +
    ` rgba(0,0,0,0) calc(var(--rip) * 1px - ${BAND}px),` +
    ` #000 calc(var(--rip) * 1px - ${BAND * 0.45}px),` +
    ` #000 calc(var(--rip) * 1px),` +
    ` rgba(0,0,0,0) calc(var(--rip) * 1px + 8px))`
  const common = { duration: RIPPLE, delay: TRAVEL - 0.05 }
  return (
    <motion.div
      className="pointer-events-none fixed overflow-hidden"
      style={
        {
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          borderRadius: radius,
          zIndex: 54, // above the card, below the comet (z-55)
          '--rip': 0,
        } as React.CSSProperties
      }
      initial={{ '--rip': 0 } as Record<string, number>}
      animate={{ '--rip': max } as Record<string, number>}
      transition={{ ...common, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* The grid, masked to the wavefront band so it reads as an expanding pulse. */}
      <motion.div
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`,
          backgroundSize: '24px 24px',
          filter: `drop-shadow(0 0 4px ${color})`,
          maskImage: mask,
          WebkitMaskImage: mask,
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.85, 0.85, 0] }}
        transition={{ ...common, times: [0, 0.12, 0.7, 1] }}
      />
      {/* A soft radial flash at the impact point — the window "charging" on contact. */}
      <motion.div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(circle at ${cx}px ${cy}px, ${color}, transparent 55%)`,
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.28, 0] }}
        transition={{ duration: 0.45, delay: TRAVEL - 0.05, ease: 'easeOut' }}
      />
    </motion.div>
  )
}

function Tracer({
  from,
  to,
  color,
  rect,
  radius,
  onDone,
}: TracerSpec & { onDone: () => void }): React.JSX.Element {
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
    <>
      {rect && <GridRipple rect={rect} radius={radius ?? 16} color={color} />}
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
    </>
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
