// The reaction log — the piece the probe stubbed. One append-only JSONL
// (SPINE_DIR/mastermind/reactions.jsonl) recording every handled reaction, from which
// the trigger counters + the skills "episode" / memory "window" session scopes are a
// deterministic projection (mirrors issueStore: replay reconstructs state, emission is
// suppressed during replay). Also computes the recurrence digest the memory reviewer
// uses for "wait for a pattern". Everything is per-project (per canvas).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IssueMilestone } from '../../shared/types'
import { mastermindRoot } from './paths'
import { initTriggers, onReaction, type TriggerState, type MilestoneKind } from './triggers'

const reactionsPath = (): string => join(mastermindRoot(), 'reactions.jsonl')

interface ReactionEvent {
  ts: number
  projectId: string
  kind: MilestoneKind
  sessionId: string
}

interface ProjState {
  trigger: TriggerState
  episode: string[] // sessions since this project's last skill review
  window: string[] // sessions since this project's last memory review
}

export interface ReactionOutcome {
  fireSkill: boolean
  fireMemory: boolean
  episode: string[] // the closed episode's session ids (populated iff fireSkill)
  window: string[] // the window's session ids (populated iff fireMemory)
}

export class ReactionLog {
  private loaded = false
  private byProject = new Map<string, ProjState>()
  private recent: ReactionEvent[] = [] // capped buffer for the recurrence digest

  private proj(projectId: string): ProjState {
    let s = this.byProject.get(projectId)
    if (!s) {
      s = { trigger: initTriggers(), episode: [], window: [] }
      this.byProject.set(projectId, s)
    }
    return s
  }

  /** Replay the log into memory (idempotent). Reviewer side-effects never run here —
   *  the caller ignores the fold's return value during load. */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = readFileSync(reactionsPath(), 'utf8')
    } catch {
      return // first run
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        this.fold(JSON.parse(line) as ReactionEvent)
      } catch {
        console.warn('[mastermind] skipping unparseable reaction line')
      }
    }
  }

  /** Record a handled reaction; returns which reviewers fire + their session scopes. */
  record(milestone: IssueMilestone, sessionId: string): ReactionOutcome {
    this.load()
    const ev: ReactionEvent = { ts: Date.now(), projectId: milestone.projectId, kind: milestone.kind, sessionId }
    const p = reactionsPath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(ev) + '\n')
    return this.fold(ev)
  }

  // Pure projection of one event onto the per-project state. Same path live + replay;
  // the only difference is whether the caller acts on the returned fire flags.
  private fold(ev: ReactionEvent): ReactionOutcome {
    this.recent.push(ev)
    if (this.recent.length > 200) this.recent.shift()
    const s = this.proj(ev.projectId)
    if (ev.sessionId) {
      s.episode.push(ev.sessionId)
      s.window.push(ev.sessionId)
    }
    const res = onReaction(s.trigger, ev.kind)
    s.trigger = res.state
    const out: ReactionOutcome = { fireSkill: res.fireSkill, fireMemory: res.fireMemory, episode: [], window: [] }
    if (res.fireSkill) {
      out.episode = s.episode.slice()
      s.episode = []
    }
    if (res.fireMemory) {
      out.window = s.window.slice()
      s.window = []
    }
    return out
  }

  /** A terse recurrence summary for a project (the memory reviewer's "wait for a
   *  pattern" input) — counts of each milestone kind in the recent buffer. */
  recurrenceDigest(projectId: string): string {
    const counts = new Map<string, number>()
    for (const e of this.recent) {
      if (e.projectId !== projectId) continue
      counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1)
    }
    const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`)
    return parts.join(', ') || '(none)'
  }
}

/** The process-wide singleton (one writer, loaded lazily on first use). */
export const reactionLog = new ReactionLog()
