import type { Issue } from '@shared/types'

/// Pure topology for the issue DAG — shared by the constellation renderer and the
/// fleet-pulse. No React, no DOM: just the wave decomposition and the honest
/// counts derived from it.

/// A wave's place in the drain: `frontier` is the live wave the fleet works now;
/// `landed` waves are fully done (spent, receding); `upcoming` waves wait, dim,
/// nearer the goal. Only the frontier carries motion, so a stalled board never
/// fakes activity.
export type WaveTone = 'frontier' | 'landed' | 'upcoming'

/// Lay the plan's issues out as dependency-ordered waves (Kahn over `deps`).
/// Deps pointing outside this set are treated as satisfied; a true cycle (a human
/// can hand-enter one) lands in a flagged group instead of looping forever.
export function layerize(issues: Issue[]): { waves: Issue[][]; cycle: Issue[] } {
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

/// The frontier is the first wave still carrying unfinished work; -1 once every
/// wave has landed (the whole plan is done — the constellation has reached the sun).
export function frontierIndexOf(waves: Issue[][]): number {
  return waves.findIndex((w) => w.some((i) => i.status !== 'done'))
}

export function toneOf(wave: number, frontierIndex: number): WaveTone {
  if (frontierIndex === -1 || wave < frontierIndex) return 'landed'
  if (wave === frontierIndex) return 'frontier'
  return 'upcoming'
}

/// Fleet-pulse telemetry — honest counts. `landed` waves are fully done;
/// `frontierWidth` is the unfinished work on the live wave (what a fleet runs at
/// once); `charge` is overall progress (0..1), which drives how bright the
/// vision-sun burns.
export function frontierStats(issues: Issue[]): {
  waveCount: number
  landed: number
  frontierWidth: number
  done: number
  total: number
  charge: number
} {
  const { waves } = layerize(issues)
  const frontierIndex = frontierIndexOf(waves)
  const landed = frontierIndex === -1 ? waves.length : frontierIndex
  const frontierWidth =
    frontierIndex === -1 ? 0 : waves[frontierIndex].filter((i) => i.status !== 'done').length
  const total = issues.length
  const done = issues.filter((i) => i.status === 'done').length
  return {
    waveCount: waves.length,
    landed,
    frontierWidth,
    done,
    total,
    charge: total > 0 ? done / total : 0,
  }
}
