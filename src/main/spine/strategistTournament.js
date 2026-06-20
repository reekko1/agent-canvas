// The PINNED strategist idea tournament — bundled into the canvas-skills plugin
// and invoked by the mastermind-strategist skill via the Workflow tool by absolute
// scriptPath (never authored by the model, so it is byte-identical every run; only
// `args` varies). It runs in the strategist CARD's session, whose cwd is the product
// repo — so the generators/judges perceive the REAL codebase. The canvas vision is
// passed in `args.vision` (the card assembles it from get_vision + get_vision_history).
//
// Shape of the result (consumed directly by the issue MCP):
//   { gapRead, candidates: [{idea, why, outcome, visionLink, lens, rating, eliminatedRound?}],
//     winnerLens: string|null, abstainReason: string|null }
// The card then calls record_conception(gapRead, candidates) and either
// set_conception_winner(id, winnerLens) or abstain_conception(id, abstainReason).
//
// The engine is the one validated by dogfood (agent-canvas + a cold-repo hard test):
// 10 lensed generators -> pairwise round-robin aggregated by Bradley-Terry -> cull +
// refine 10->6->3->1 (refinement RE-READS the code: accuracy over bravado) -> an
// absolute-bar gate (does even the winner genuinely serve the vision? else abstain).
export const meta = {
  name: 'strategist-tournament',
  description:
    'Pinned strategist idea tournament: 10 lensed generators -> pairwise round-robin (Bradley-Terry) -> cull+refine 10->6->3->1 (refinement re-reads the code) -> absolute-bar gate -> a winning next-sprint idea or an abstention, judged against this canvas vision (args.vision).',
  phases: [
    { title: 'Generate' },
    { title: 'Round 1' },
    { title: 'Round 2' },
    { title: 'Round 3' },
    { title: 'Refine' },
    { title: 'Gate' },
  ],
}

// args may arrive structured or (older runtimes) JSON-stringified — handle both.
const ARGS = typeof args === 'string' ? JSON.parse(args || '{}') : args || {}
const VISION = ARGS.vision ? String(ARGS.vision) : 'No vision was provided for this canvas.'

const LENSES = [
  { key: 'capability-gap', label: 'Capability gap', desc: 'The most important capability the product is missing ENTIRELY.' },
  { key: 'foundational', label: 'Foundational leverage', desc: 'The single piece of work that would UNBLOCK the most other future work.' },
  { key: 'quality', label: 'Quality vs principle', desc: "Where something EXISTS but falls short of the product's stated principles/taste." },
  { key: 'anti-drift', label: 'Anti-vision drift', desc: 'Where the product is drifting toward something the vision REJECTS, and the move that corrects it.' },
  { key: 'user-journey', label: 'Next user-journey', desc: 'The next thing a user of this product would reach for and NOT find.' },
  { key: 'trajectory', label: 'Trajectory', desc: 'Given the recent direction of the work, the natural and most valuable NEXT step that continues the arc.' },
  { key: 'reliability', label: 'Reliability / risk', desc: 'The biggest fragility or failure mode that undermines trust, and the move that hardens it.' },
  { key: 'delight', label: 'Delight / polish', desc: 'The experience/polish gap whose closing would most ELEVATE how the product feels.' },
  { key: 'reach', label: 'Reach / distribution', desc: 'What most limits the product from reaching or being adopted by more users, and the move that widens it.' },
  { key: 'coherence', label: 'Coherence / integration', desc: "Two already-shipped capabilities that don't yet compose well, where unifying them is the highest-value move." },
]

const IDEA_SCHEMA = {
  type: 'object',
  properties: {
    idea: { type: 'string', description: 'The move, one line, intent not implementation.' },
    why: { type: 'string', description: 'The gap it closes + why it is the highest-leverage move now.' },
    outcome: { type: 'string', description: 'What is observably different once done (intent altitude).' },
    visionLink: { type: 'string', description: 'The principle / anti-vision / capability it serves.' },
  },
  required: ['idea', 'why', 'outcome', 'visionLink'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    winner: { type: 'string', enum: ['1', '2'] },
    reasoning: { type: 'string' },
  },
  required: ['winner', 'reasoning'],
}

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    clears: { type: 'boolean', description: 'Does the winner genuinely clear the absolute bar?' },
    reason: { type: 'string' },
    gapRead: { type: 'string', description: 'One line: the vision-vs-reality gap this addresses.' },
  },
  required: ['clears', 'reason'],
}

function genPrompt(lens) {
  return `You are one of several INDEPENDENT idea-generators proposing the NEXT sprint for a software product. Your job: through ONE specific lens, propose the single highest-leverage "next move."

YOUR LENS - ${lens.label}: ${lens.desc}

First, ground yourself in CURRENT REALITY: use Read/Grep/Glob to do a FOCUSED (not exhaustive) survey of the repository you are working in (your current working directory) as it bears on your lens. Read its CLAUDE.md / README / design docs and skim the relevant source. Notice what exists, what is recent, and what is missing. Read the actual CODE, not just the docs — gaps hide in the code.

Then propose ONE idea that, through your lens, best closes the gap between the product AS IT IS and the VISION below.

VISION:
${VISION}

RULES:
- An "idea" is INTENT, not a technical plan. Keep "idea" to one line (it MAY name an approach, but NO implementation detail — that is a later role's job).
- Win on LEVERAGE toward the vision, not sophistication. A simple, foundational move is often the strongest.
- "visionLink" must cite the SPECIFIC principle / anti-vision / capability your idea serves.

Return the idea object.`
}

function judgePrompt(first, second) {
  return `You are an impartial judge in a PAIRWISE comparison. Two candidate "next sprint ideas" for a product are below, anonymized as Idea 1 and Idea 2. Decide which one, if built next, would move the product FURTHER toward its VISION.

VISION:
${VISION}

Idea 1:
- idea: ${first.idea}
- why: ${first.why}
- outcome: ${first.outcome}
- visionLink: ${first.visionLink}

Idea 2:
- idea: ${second.idea}
- why: ${second.why}
- outcome: ${second.outcome}
- visionLink: ${second.visionLink}

JUDGE ON: leverage toward the vision, foundational impact (does it unblock more?), feasibility on the current product, and respect for the anti-vision. Do NOT reward an idea for being longer, fancier, or more technical-sounding — a short, humble, high-leverage idea should beat an elaborate low-leverage one. Pick exactly one winner ("1" or "2") and give a one-paragraph reasoning.`
}

function refinePrompt(s, reasons) {
  const crit = reasons.length ? reasons.map((r, i) => `(${i + 1}) ${r}`).join('\n') : '(no recorded criticism — sharpen it anyway)'
  return `You earlier proposed this "next sprint idea", viewed through the lens of ${s.lens}:
- idea: ${s.idea}
- why: ${s.why}
- outcome: ${s.outcome}
- visionLink: ${s.visionLink}

It ADVANCED in the competition, but independent judges raised these criticisms in the matchups it lost:
${crit}

Do TWO things, IN ORDER:

1) RE-GROUND IN REALITY. Re-read the relevant parts of the repository you are working in (Read/Grep/Glob on your current working directory) to VERIFY every factual claim your idea rests on: does the thing you call missing actually not exist? does the thing you call "already built" actually work as you say? Where a judge's criticism turns on a fact, CHECK it against the code rather than merely conceding or asserting it. Correct any wording that is inaccurate or overstated against what the code actually shows. Do NOT go hunting for a different gap and do NOT change your lens (${s.lens}) — you are verifying and tightening THIS idea, not replacing it.

2) SHARPEN. Using what you re-read, revise YOUR idea to answer the criticism and make it both stronger AND more accurate — claims that hold against the code, a tighter outcome, sharper framing. Do NOT adopt or drift toward other ideas; improve your OWN. Keep "idea" to one line, intent not implementation. Do NOT inflate it into a sweeping overclaim to win the argument — accuracy beats bravado; an idea whose wording is exactly true to the codebase is stronger than one that merely sounds impressive.

VISION:
${VISION}

Return the revised idea object.`
}

function gatePrompt(winner, runnerUp) {
  return `A strategist tournament has chosen a WINNING "next sprint idea" for this product. Before it becomes real work, judge it against an ABSOLUTE bar (not relative to other ideas): is it genuinely worth a sprint right now?

VISION:
${VISION}

WINNER:
- idea: ${winner.idea}
- why: ${winner.why}
- outcome: ${winner.outcome}
- visionLink: ${winner.visionLink}
${runnerUp ? `\nFor context, the runner-up was: "${runnerUp.idea}"` : ''}

Set clears=true ONLY if this idea CLEARLY serves the vision, is worth the whole fleet's effort (not busywork or trivial), is not premature (its prerequisites plausibly exist), and does not violate the anti-vision. If it is marginal, ambiguous, premature, or the kind of thing a human should decide, set clears=false — abstaining is better than manufacturing a mediocre sprint. Also return a one-line gapRead: the vision-vs-reality gap this idea addresses.`
}

function bradleyTerry(ids, beat) {
  const p = {}
  for (let i = 0; i < ids.length; i++) p[ids[i]] = 1.0
  const SMOOTH = 0.15
  for (let it = 0; it < 200; it++) {
    const np = {}
    for (let a = 0; a < ids.length; a++) {
      const I = ids[a]
      let num = 0, den = 0
      for (let b = 0; b < ids.length; b++) {
        if (a === b) continue
        const J = ids[b]
        const wij = (beat[I] && beat[I][J] ? beat[I][J] : 0) + SMOOTH
        const wji = (beat[J] && beat[J][I] ? beat[J][I] : 0) + SMOOTH
        num += wij
        den += (wij + wji) / (p[I] + p[J])
      }
      np[I] = num / den
    }
    let logsum = 0
    for (let a = 0; a < ids.length; a++) logsum += Math.log(np[ids[a]])
    const g = Math.exp(logsum / ids.length)
    for (let a = 0; a < ids.length; a++) p[ids[a]] = np[ids[a]] / g
  }
  return p
}

// ================= RUN =================
phase('Generate')
log('Generating 10 lensed candidate ideas against this canvas vision...')
const gen = await parallel(
  LENSES.map((lens, idx) => () =>
    agent(genPrompt(lens), { label: `gen:${lens.key}`, phase: 'Generate', effort: 'medium', schema: IDEA_SCHEMA }).then((o) =>
      o ? { id: 'i' + (idx + 1), lens: lens.key, idea: o.idea, why: o.why, outcome: o.outcome, visionLink: o.visionLink } : null,
    ),
  ),
)
let field = gen.filter(Boolean)
if (field.length < 2) {
  return { gapRead: '', candidates: field.map((c) => ({ idea: c.idea, why: c.why, outcome: c.outcome, visionLink: c.visionLink, lens: c.lens })), winnerLens: null, abstainReason: 'The tournament could not assemble a field of ideas.' }
}
log(`Field: ${field.length} ideas. Beginning the tournament.`)

// Track each lens's latest idea text + final rating + the round it was culled in.
const byLens = {}
for (const c of field) byLens[c.lens] = { idea: c.idea, why: c.why, outcome: c.outcome, visionLink: c.visionLink, lens: c.lens }

const CULL = [6, 3, 1]
const RIGOR = [
  { ord: 1, K: 1, model: 'sonnet', effort: 'low' },
  { ord: 1, K: 1, model: 'sonnet', effort: 'medium' },
  { ord: 2, K: 3, effort: 'high' },
]

let winner = null
let runnerUp = null

for (let r = 0; r < CULL.length; r++) {
  const rig = RIGOR[r] || { ord: 1, K: 1 }
  const phaseName = 'Round ' + (r + 1)

  const matches = []
  for (let i = 0; i < field.length; i++) {
    for (let j = i + 1; j < field.length; j++) {
      for (let k = 0; k < rig.K; k++) {
        matches.push({ i, j, order: 'ab' })
        if (rig.ord === 2) matches.push({ i, j, order: 'ba' })
      }
    }
  }

  const results = await parallel(
    matches.map((m) => () => {
      const A = field[m.i], B = field[m.j]
      const firstC = m.order === 'ab' ? A : B
      const secondC = m.order === 'ab' ? B : A
      const opts = { label: `judge:${A.id}v${B.id}`, phase: phaseName, schema: VERDICT_SCHEMA, effort: rig.effort }
      if (rig.model) opts.model = rig.model
      return agent(judgePrompt(firstC, secondC), opts).then((v) => {
        if (!v) return null
        const winId = v.winner === '1' ? firstC.id : secondC.id
        const loseId = v.winner === '1' ? secondC.id : firstC.id
        return { winId, loseId, reasoning: v.reasoning }
      })
    }),
  )

  const beat = {}
  const lossReasons = {}
  for (const f of field) { beat[f.id] = {}; lossReasons[f.id] = [] }
  for (const x of results.filter(Boolean)) {
    beat[x.winId][x.loseId] = (beat[x.winId][x.loseId] || 0) + 1
    lossReasons[x.loseId].push(x.reasoning)
  }

  const ids = field.map((f) => f.id)
  const strength = bradleyTerry(ids, beat)
  const ranked = field.map((f) => ({ ...f, rating: strength[f.id] })).sort((a, b) => b.rating - a.rating)
  for (const c of ranked) byLens[c.lens].rating = Number(c.rating.toFixed(3))
  log(`Round ${r + 1}: ${field.length} ideas, ${matches.length} matches. Leader: "${ranked[0].idea}" [${ranked[0].lens}] (${ranked[0].rating.toFixed(2)})`)

  const target = CULL[r]
  if (target <= 1) {
    winner = ranked[0]
    runnerUp = ranked[1] || null
    // Tag the final-round losers too (the break skips the cull step) so the bracket
    // shows them as cut, not as un-culled survivors beside the winner.
    for (const c of ranked.slice(1)) byLens[c.lens].eliminatedRound = r + 1
    break
  }

  const survivors = ranked.slice(0, target)
  for (const c of ranked.slice(target)) byLens[c.lens].eliminatedRound = r + 1
  log(`Culling ${field.length} -> ${target}; refining survivors (with codebase re-read) against their own critique.`)
  field = await parallel(
    survivors.map((s) => () =>
      agent(refinePrompt(s, lossReasons[s.id]), { label: `refine:${s.id}`, phase: 'Refine', effort: 'medium', schema: IDEA_SCHEMA }).then((o) =>
        o
          ? { id: s.id, lens: s.lens, idea: o.idea, why: o.why, outcome: o.outcome, visionLink: o.visionLink }
          : { id: s.id, lens: s.lens, idea: s.idea, why: s.why, outcome: s.outcome, visionLink: s.visionLink },
      ),
    ),
  )
  for (const c of field) {
    byLens[c.lens].idea = c.idea
    byLens[c.lens].why = c.why
    byLens[c.lens].outcome = c.outcome
    byLens[c.lens].visionLink = c.visionLink
  }
}

// Absolute-bar gate (gate #0): does even the winner genuinely clear the bar?
phase('Gate')
let clears = true
let abstainReason = null
let gapRead = winner ? winner.why : ''
if (winner) {
  const gate = await agent(gatePrompt(winner, runnerUp), { label: 'gate:absolute-bar', phase: 'Gate', effort: 'high', schema: GATE_SCHEMA })
  if (gate) {
    clears = !!gate.clears
    if (gate.gapRead) gapRead = gate.gapRead
    if (!clears) abstainReason = gate.reason || 'No idea cleared the absolute bar.'
  }
  log(clears ? `Gate: winner clears the bar — "${winner.idea}"` : `Gate: ABSTAIN — ${abstainReason}`)
}

const candidates = Object.keys(byLens).map((k) => byLens[k])
return {
  gapRead,
  candidates,
  winnerLens: clears && winner ? winner.lens : null,
  abstainReason: clears ? null : abstainReason || 'No idea cleared the absolute bar.',
}
