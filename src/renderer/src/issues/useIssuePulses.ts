import { useEffect, useRef, useState } from 'react'
import type { Issue } from '@shared/types'

/// One-shot "something just happened" signals for the Frontier, derived purely
/// from the snapshot stream — the board never stores them. The board re-renders
/// on whole-snapshot `onIssueUpdate` replaces (same as the diff sheet); this hook
/// holds a ref of each issue's prior status + verdict count, diffs every new
/// snapshot, and flags the issues that just transitioned to `done` (→ the radial
/// `issue-land` ripple + the green settle flash) or gained an audit verdict (→ a
/// clear/issues flash). Each pulse carries a bumped nonce (so a re-fire on the
/// same id replays the animation) and auto-clears after the effect runs out, the
/// same one-shot-by-nonce pattern the browser scan uses on a CardNode. The first
/// snapshot only seeds the baseline — a fresh board load never ripples.

export type IssuePulseKind = 'land' | 'verdict-clear' | 'verdict-issues'
export interface IssuePulse {
  nonce: number
  kind: IssuePulseKind
}

const PULSE_MS = 1800

export function useIssuePulses(issues: Issue[]): (id: string) => IssuePulse | undefined {
  const prev = useRef<Map<string, { status: string; verdicts: number }> | null>(null)
  const [pulses, setPulses] = useState<Map<string, IssuePulse>>(() => new Map())
  const nonce = useRef(0)
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const cur = new Map(
      issues.map((i) => [i.id, { status: i.status, verdicts: i.verdicts.length }] as const),
    )
    const before = prev.current
    prev.current = cur
    if (!before) return // seed only — the initial load must not ripple every node

    const fired: Array<[string, IssuePulseKind]> = []
    for (const i of issues) {
      const b = before.get(i.id)
      if (!b) continue // a brand-new issue isn't a transition
      if (b.status !== 'done' && i.status === 'done') fired.push([i.id, 'land'])
      else if (i.verdicts.length > b.verdicts) {
        const last = i.verdicts[i.verdicts.length - 1]
        fired.push([i.id, last?.verdict === 'ISSUES' ? 'verdict-issues' : 'verdict-clear'])
      }
    }
    if (fired.length === 0) return

    setPulses((m) => {
      const next = new Map(m)
      for (const [id, kind] of fired) next.set(id, { nonce: ++nonce.current, kind })
      return next
    })
    // Schedule each pulse's removal independently of this effect's lifecycle, so
    // a rapid follow-up snapshot can't cut a ripple short or strand it on screen.
    for (const [id] of fired) {
      const existing = timers.current.get(id)
      if (existing) clearTimeout(existing)
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id)
          setPulses((m) => {
            const next = new Map(m)
            next.delete(id)
            return next
          })
        }, PULSE_MS),
      )
    }
  }, [issues])

  useEffect(() => {
    const t = timers.current
    return () => {
      for (const id of t.values()) clearTimeout(id)
      t.clear()
    }
  }, [])

  return (id) => pulses.get(id)
}
