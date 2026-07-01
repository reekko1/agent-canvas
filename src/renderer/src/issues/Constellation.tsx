import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { ISSUE_STATUS_META } from './badges'
import { layerize, frontierIndexOf, toneOf, type WaveTone } from './dag'
import type { IssuePulse } from './useIssuePulses'
import type { Issue } from '@shared/types'

const CYAN = 'rgb(var(--accent-ai))'

interface Placed {
  issue: Issue
  x: number
  y: number
  tone: WaveTone
  cycle?: boolean
}

/// Measure the element so the polar layout tracks the real viewport.
function useSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

/// The gravity well — the vision as a sun, the sprint's issue-DAG orbiting it as
/// concentric wave-rings. Wave 0 (foundations) sits at the outer rim; the final
/// wave touches the sun. Work flows inward: the bright frontier ring is the live
/// wave, landed waves recede outward and dim, upcoming waves wait dim inside it.
/// The whole field drifts as one slow rigid body so edges stay joined; the sun
/// breathes and charges with progress. Pure observation — orbs only, titles on
/// demand (hover → readout, click → dossier).
export function Constellation({
  issues,
  pulseFor,
  charge,
  visionEssence,
  selectedId,
  onSelect,
  onHover,
}: {
  issues: Issue[]
  pulseFor: (id: string) => IssuePulse | undefined
  charge: number
  visionEssence?: string
  selectedId: string | null
  onSelect: (issue: Issue) => void
  onHover: (issue: Issue | null) => void
}) {
  const [ref, { w, h }] = useSize()

  const layout = useMemo(() => {
    const cx = w / 2
    const cy = h / 2
    const R = Math.min(w, h)
    const rOuter = R * 0.4
    const rInner = R * 0.13
    const { waves, cycle } = layerize(issues)
    const fi = frontierIndexOf(waves)
    const W = waves.length
    const radiusAt = (wv: number): number =>
      W <= 1 ? (rInner + rOuter) / 2 : rOuter - (rOuter - rInner) * (wv / (W - 1))

    const placed: Placed[] = []
    const pos = new Map<string, { x: number; y: number }>()
    waves.forEach((wave, wv) => {
      const radius = radiusAt(wv)
      const n = wave.length
      const ringOffset = wv * 0.7
      wave.forEach((issue, i) => {
        const theta =
          (n === 1 ? 0 : (i / n) * Math.PI * 2) + ringOffset - Math.PI / 2
        const x = cx + radius * Math.cos(theta)
        const y = cy + radius * Math.sin(theta)
        placed.push({ issue, x, y, tone: toneOf(wv, fi) })
        pos.set(issue.id, { x, y })
      })
    })
    // A dependency cycle (hand-entered) rides an extra ring beyond the rim.
    cycle.forEach((issue, i) => {
      const theta = (i / Math.max(1, cycle.length)) * Math.PI * 2 - Math.PI / 2
      const x = cx + rOuter * 1.16 * Math.cos(theta)
      const y = cy + rOuter * 1.16 * Math.sin(theta)
      placed.push({ issue, x, y, tone: 'upcoming', cycle: true })
      pos.set(issue.id, { x, y })
    })

    // Edges: dep (outer) → dependent (inner), so the flow animation runs inward.
    const edges = placed.flatMap((p) =>
      p.issue.deps
        .map((d) => pos.get(d))
        .filter((from): from is { x: number; y: number } => !!from)
        .map((from) => ({
          x1: from.x,
          y1: from.y,
          x2: p.x,
          y2: p.y,
          live: p.tone === 'frontier' || p.tone === 'upcoming',
        })),
    )

    return { cx, cy, placed, edges, frontierRadius: fi >= 0 ? radiusAt(fi) : null }
  }, [issues, w, h])

  const ready = w > 0 && h > 0

  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden">
      {ready && (
        <>
          {/* The frontier ring — a concentric band of light at the live wave's
              radius. Rotation-invariant, so it stays still and crisp. */}
          {layout.frontierRadius && (
            <svg className="pointer-events-none absolute inset-0" width={w} height={h}>
              <circle
                className="frontier-ring"
                cx={layout.cx}
                cy={layout.cy}
                r={layout.frontierRadius}
                fill="none"
                strokeWidth={1}
                strokeOpacity={0.5}
                // stroke rides `style`, not the SVG attribute — CSS var() only
                // resolves in CSS contexts, and CYAN is now var(--accent-ai).
                style={{ stroke: CYAN, filter: `drop-shadow(0 0 6px ${CYAN})` }}
              />
            </svg>
          )}

          {/* The orbiting field: edges + orbs drift together as one rigid body. */}
          <div className="constellation-spin absolute inset-0">
            <svg className="pointer-events-none absolute inset-0 overflow-visible" width={w} height={h}>
              {layout.edges.map((e, i) => (
                <line
                  key={i}
                  className={cn(e.live && 'edge-flow')}
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  style={{ stroke: CYAN }}
                  strokeWidth={e.live ? 1.4 : 0.7}
                  strokeOpacity={e.live ? 0.5 : 0.16}
                />
              ))}
            </svg>
            {layout.placed.map((p) => (
              <Orb
                key={p.issue.id}
                p={p}
                selected={p.issue.id === selectedId}
                pulse={pulseFor(p.issue.id)}
                onSelect={() => onSelect(p.issue)}
                onHover={onHover}
              />
            ))}
          </div>

          {/* The vision-sun — the gravitational centre; brighter as the sprint
              charges toward its outcome. Static (rotation-invariant). */}
          <div
            className="sun-breathe absolute rounded-full"
            style={{
              left: layout.cx,
              top: layout.cy,
              width: 132,
              height: 132,
              background:
                'radial-gradient(circle, rgba(200,244,255,0.95), rgb(var(--accent-ai) / 0.5) 40%, rgb(var(--accent-ai) / 0) 70%)',
              boxShadow: `0 0 ${60 + charge * 120}px ${18 + charge * 56}px rgb(var(--accent-ai) / ${0.14 + charge * 0.4})`,
            }}
          />
          {visionEssence && (
            <div
              className="pointer-events-none absolute -translate-x-1/2 text-center"
              style={{ left: layout.cx, top: layout.cy + 86, width: 320 }}
            >
              <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-accent-ai/70">
                the vision
              </div>
              <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-white/55">
                {visionEssence}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Orb({
  p,
  selected,
  pulse,
  onSelect,
  onHover,
}: {
  p: Placed
  selected: boolean
  pulse: IssuePulse | undefined
  onSelect: () => void
  onHover: (issue: Issue | null) => void
}) {
  const status = p.issue.status
  const color = p.cycle ? 'var(--status-error)' : ISSUE_STATUS_META[status]?.color ?? CYAN
  const size = p.tone === 'frontier' ? 13 : p.tone === 'landed' ? 8 : 10
  const glow = status === 'in_progress' ? 18 : p.tone === 'frontier' ? 12 : 7
  const dim = status === 'done' ? 0.5 : p.tone === 'upcoming' ? 0.82 : 1
  const motion =
    status === 'in_progress'
      ? 'node-working'
      : status === 'blocked'
        ? 'node-blocked'
        : status === 'done'
          ? ''
          : 'orb-twinkle'

  return (
    <button
      className="absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
      style={{ left: p.x, top: p.y }}
      onClick={onSelect}
      onMouseEnter={() => onHover(p.issue)}
      onMouseLeave={() => onHover(null)}
      aria-label={p.issue.title}
    >
      {pulse?.kind === 'land' && <span key={pulse.nonce} className="issue-land" />}
      {selected && (
        <span
          className="absolute rounded-full"
          style={{
            width: size + 12,
            height: size + 12,
            border: `1.5px solid ${CYAN}`,
            boxShadow: `0 0 10px ${CYAN}`,
          }}
        />
      )}
      <span
        className={cn('block rounded-full', motion)}
        style={{
          width: size,
          height: size,
          backgroundColor: color,
          opacity: dim,
          boxShadow:
            motion === 'node-working' || motion === 'node-blocked'
              ? undefined
              : `0 0 ${glow}px ${glow / 2.4}px color-mix(in srgb, ${color} 60%, transparent)`,
        }}
      />
    </button>
  )
}
