// "Your whole world" — a terse, cross-canvas synthesis the mastermind gets each turn
// so it reasons over everything Rakan is building, not just the open canvas. PURE
// synthesis from state already held in memory (RemoteState canvases + the IssueSnapshot
// + per-canvas product memory) — NO new store, by the scope fence. The open canvas is
// rendered in full elsewhere (bus.openCanvas); this is the wide-angle companion to it.
import type { IssueSnapshot, Sprint } from '../../shared/types'

export interface WorldCanvasInput {
  id: string
  name: string
}

/** Collapse a sprint's lifecycle enum to one plain-English phase word. */
function sprintPhase(s: Sprint): string {
  switch (s.state) {
    case 'DONE':
      return 'done'
    case 'EXECUTING':
    case 'DECOMPOSED':
      return 'building'
    case 'PLAN_REVIEW':
    case 'OUTCOME_REVIEW':
      return 'in review'
    case 'REALIGNMENT_PENDING':
      return 'needs realignment'
    default: // DRAFT, APPROVED
      return 'planning'
  }
}

/** The first meaningful line of a canvas's current vision body (markdown heading
 *  markers stripped), clipped — the canvas's north star in a phrase. '' if none. */
function visionHeadline(snap: IssueSnapshot, projectId: string): string {
  const vision = snap.visions.find((v) => v.projectId === projectId)
  if (!vision?.currentVersion) return ''
  const ver = snap.versions.find((v) => v.id === vision.currentVersion)
  if (!ver) return ''
  const line =
    ver.body
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l.length > 0) ?? ''
  return line.length > 100 ? `${line.slice(0, 100)}…` : line
}

/** A one-line state summary for a canvas's sprints — "2 building, 1 in review", or a
 *  terminal phrase when there's nothing live. */
function sprintSummary(snap: IssueSnapshot, projectId: string): string {
  const sprints = snap.sprints.filter((s) => s.projectId === projectId)
  if (!sprints.length) return 'no sprint yet'
  const live = sprints.filter((s) => s.state !== 'DONE')
  if (!live.length) return 'all sprints done'
  const counts = new Map<string, number>()
  for (const s of live) counts.set(sprintPhase(s), (counts.get(sprintPhase(s)) ?? 0) + 1)
  return [...counts.entries()].map(([phase, n]) => `${n} ${phase}`).join(', ')
}

/** Render the cross-canvas world view. One line per canvas: name · vision headline ·
 *  sprint state · a clip of what the mastermind knows about that product. '' when there
 *  are no canvases (the orchestrator falls back to just the open-canvas snapshot). */
export function computeWorldView(
  canvases: WorldCanvasInput[],
  issueSnapshot: IssueSnapshot,
  getProductSnapshot: (projectId: string) => string,
): string {
  if (!canvases.length) return ''
  const lines = canvases.map((c) => {
    const headline = visionHeadline(issueSnapshot, c.id) || 'no vision set'
    const state = sprintSummary(issueSnapshot, c.id)
    const product = getProductSnapshot(c.id).trim()
    const note = product ? ` · you know: ${product.split('\n')[0].slice(0, 80)}` : ''
    return `- ${c.name}: ${headline} — ${state}${note}`
  })
  const head = `[Your world] ${canvases.length} canvas${canvases.length === 1 ? '' : 'es'} you're building:`
  return `${head}\n${lines.join('\n')}`
}

// [WORLD_INFLUENCE_HOOK] Future: the world view is the natural place to surface
// cross-canvas, operator-level patterns ("you keep stalling on auth across repos") —
// bidirectional influence between what Rakan is building and what the mastermind learns
// about him. Note only; not built.
