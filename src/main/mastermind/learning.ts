// Learning coordinator: funnels ALL reviewer work — both reaction-completions
// (recordReaction) and the operator's direct conversation (recordConversation, any mode) —
// through ONE serialized worker (the "298s lesson") so concurrent completions never race on
// the memory / skill files. On the design's schedule it advances the triggers and runs the
// reviewers to grow memory + skills; the reviewers RUN even when the reactor only observes
// (only the reactor's *actions* are withheld).
import type { IssueMilestone } from '../../shared/types'
import { episodeSource, windowSource } from '../../shared/provenance'
import type { Reaction } from './reactor'
import { reactionLog } from './reactions'
import { runSkillReviewer, runMemoryReviewer, reviewMemory } from './reviewers'
import { applySkill } from './skills'
import { applyMemoryOps } from './memory'

let chain: Promise<void> = Promise.resolve()
function enqueue(job: () => Promise<void>): void {
  chain = chain.then(job).catch((e) => console.warn('[mastermind-learn] reviewer job failed:', e))
}

// Fired after the skill reviewer creates/patches ≥1 skill. The host wires this to recycle
// the orchestrator session so it reloads the library (the SDK can't hot-swap skills).
let onSkillsChanged: (() => void) | null = null
export function setSkillsChangedListener(fn: (() => void) | null): void {
  onSkillsChanged = fn
}

/** Await all currently-queued reviewer work (for tests / shutdown). */
export function drainLearning(): Promise<void> {
  return chain
}

// The operator model grows from the user's DIRECT conversation with the orchestrator —
// in ANY mode (this is the mastermind-as-assistant, not the coding fleet). Coalesced: a
// burst of messages collapses into one review over the latest window (no per-message
// cost blowup), serialized on the same worker as the fleet reviewers.
let convoQueued = false
let convoLatest: { transcript: string; projectId?: string } | null = null

export function recordConversation(transcript: string, projectId?: string): void {
  convoLatest = { transcript, projectId }
  if (convoQueued) return // a review is already queued; it will pick up the latest window
  convoQueued = true
  enqueue(async () => {
    convoQueued = false // clear before the review so messages arriving during it re-queue once
    const job = convoLatest
    if (!job) return
    const plan = await reviewMemory(job.transcript, job.projectId)
    if (!plan || plan.nothing_to_save || !plan.memory_writes?.length) return
    // operator facts always apply; product facts need an active canvas to land on
    const writes = job.projectId ? plan.memory_writes : plan.memory_writes.filter((w) => w.store === 'operator')
    if (!writes.length) return
    const r = applyMemoryOps(writes, 'conversation', job.projectId)
    console.log(
      r.ok
        ? `[mastermind] learned ${writes.length} fact(s) about you from the conversation`
        : `[mastermind] conversation memory rejected: ${r.error}`,
    )
  })
}

/** Record one handled reaction and fire the reviewers on schedule. Returns immediately;
 *  reviewer work runs in the background on the serialized worker. */
export function recordReaction(milestone: IssueMilestone, reaction: Reaction): void {
  const out = reactionLog.record(milestone, reaction.sessionId)
  const projectId = milestone.projectId

  if (out.fireSkill && out.episode.length) {
    const episode = out.episode
    enqueue(async () => {
      const plan = await runSkillReviewer(episode)
      if (!plan || plan.nothing_to_save) return
      let n = 0
      for (const a of plan.skill_actions ?? []) {
        const r = applySkill(a, episodeSource(projectId, milestone.kind))
        if (r.ok) n++
        else console.warn(`[mastermind-learn] skill ${a.op} "${a.name}" rejected: ${r.error}`)
      }
      if (n) {
        console.log(`[mastermind-learn] skills: applied ${n} action(s) from a ${episode.length}-reaction episode`)
        onSkillsChanged?.() // recycle the orchestrator session so it loads the new skills
      }
    })
  }

  if (out.fireMemory && out.window.length) {
    const window = out.window
    const digest = reactionLog.recurrenceDigest(projectId)
    enqueue(async () => {
      const plan = await runMemoryReviewer(window, projectId, digest)
      if (!plan || plan.nothing_to_save || !plan.memory_writes?.length) return
      const r = applyMemoryOps(plan.memory_writes, windowSource(projectId), projectId)
      console.log(
        r.ok
          ? `[mastermind-learn] memory: applied ${plan.memory_writes.length} write(s) from a ${window.length}-reaction window`
          : `[mastermind-learn] memory writes rejected: ${r.error}`,
      )
    })
  }
}
