// Deterministic reviewer triggers (no model). Skills = event-primary (conclusive
// milestones) + count backstop (10, ->5 on friction). Memory = count-based (every 10).
// MilestoneKind is the real IssueMilestone union — single source of truth, not a
// re-declared copy. CONCLUSIVE + FRICTION are all backed by real milestone emissions
// (stalled / retire / amend included).
import type { IssueMilestone } from '../../shared/types'

export type MilestoneKind = IssueMilestone['kind']

const CONCLUSIVE = new Set<MilestoneKind>(['outcome-verified', 'stalled', 'idea-abstained'])
const FRICTION = new Set<MilestoneKind>(['issue-blocked', 'retire', 'amend'])

export interface TriggerState {
  sinceSkill: number // reactions since last skill review
  sinceMemory: number // reactions since last memory review
  frictionSeen: boolean // friction milestone since last skill review
}
export const initTriggers = (): TriggerState => ({ sinceSkill: 0, sinceMemory: 0, frictionSeen: false })

export const SKILL_BACKSTOP = 10
export const SKILL_BACKSTOP_FRICTION = 5
export const MEMORY_EVERY = 10

// Advance the counters for one handled reaction; return which reviewers fire.
export function onReaction(
  s: TriggerState,
  kind: MilestoneKind,
): { fireSkill: boolean; fireMemory: boolean; state: TriggerState } {
  const sinceSkill = s.sinceSkill + 1
  const sinceMemory = s.sinceMemory + 1
  const frictionSeen = s.frictionSeen || FRICTION.has(kind)
  const backstop = frictionSeen ? SKILL_BACKSTOP_FRICTION : SKILL_BACKSTOP

  const fireSkill = CONCLUSIVE.has(kind) || sinceSkill >= backstop
  const fireMemory = sinceMemory >= MEMORY_EVERY

  return {
    fireSkill,
    fireMemory,
    state: {
      sinceSkill: fireSkill ? 0 : sinceSkill,
      sinceMemory: fireMemory ? 0 : sinceMemory,
      frictionSeen: fireSkill ? false : frictionSeen,
    },
  }
}
