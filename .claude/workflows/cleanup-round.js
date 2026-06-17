export const meta = {
  name: 'cleanup-round',
  description:
    'Branch cleanup review: one finder per dimension in parallel, each finding adversarially verified, then synthesized into a single deduped, prioritized list. Finds nothing-to-touch honestly; never manufactures findings.',
  whenToUse:
    'Driven by the /cleanup-round command after the diff has been scouted. Pass args = { base, changedFiles, focus }.',
  phases: [
    { title: 'Review', detail: 'one reviewer per cleanup dimension, in parallel' },
    { title: 'Verify', detail: 'adversarially confirm each finding (repo-wide search for dupe/dead-code claims)' },
    { title: 'Synthesize', detail: 'dedup findings across dimensions into one prioritized list' },
  ],
}

// args is supplied by the /cleanup-round command after it scouts the diff.
const base = (args && args.base) || 'main'
const changedFiles = (args && args.changedFiles) || []
const focus = (args && args.focus) || ''

// Shared brief every reviewer and verifier sees. This is the scope + the bar.
const SCOPE = `
You are reviewing the work done on the current branch — NOT the whole repo.
Base ref = \`${base}\`. The branch diff is \`git diff ${base}...HEAD\`.

Changed files in scope:
${changedFiles.length ? changedFiles.map((f) => `  - ${f}`).join('\n') : '  (none reported — recompute from git diff yourself)'}
${focus ? `\nWeight this focus area more heavily: ${focus}\n` : ''}
Ground rules:
- Read the changed files relevant to your dimension IN FULL (not just the diff
  hunks) — anti-patterns and poor separation live in the surrounding code. Also
  read the immediate neighbors a changed file imports from or is imported by.
- This branch ALREADY WORKS. This pass is purely about making the code
  excellent. Do NOT propose behavior changes.
- Respect existing conventions — match the surrounding idiom, comment density,
  and naming. The project has a no-new-tooling stance: \`tsc\` + build is the only
  gate. Never propose linters/formatters or reformat untouched code.
- Skip anything that is merely taste with no concrete cost.
- If you find nothing material for your dimension, return an empty findings
  array. Do NOT manufacture findings to look productive.
`

// The cleanup bar — one reviewer per dimension, in rough priority order.
const DIMENSIONS = [
  {
    key: 'duplication',
    brief:
      'DUPLICATION — logic, types, or constants re-implemented when an equivalent already exists elsewhere in the codebase and should be reused. This is the most common and most important finding. Before reporting, grep the WHOLE repo to prove the original exists and is genuinely reusable here; name it in evidence.',
  },
  {
    key: 'dead-code',
    brief:
      'DEAD CODE — unused exports, functions, vars, params, branches, or whole files left behind from the prove-it-works phase. Before reporting, grep the WHOLE repo for references to prove it is unused (mind re-exports, dynamic access, and string keys); cite the search in evidence.',
  },
  {
    key: 'anti-patterns',
    brief:
      'ANTI-PATTERNS — error swallowing, leaky abstractions, prop drilling, god functions/modules, stringly-typed interfaces, race-prone async, mutation where immutability is expected, re-deriving state that already exists.',
  },
  {
    key: 'separation',
    brief:
      'SEPARATION OF CONCERN — logic in the wrong layer (UI doing IO, business logic in the renderer, the main loop knowing view concerns, etc.). Name the seam it crosses and where it belongs.',
  },
  {
    key: 'semantics',
    brief:
      "SEMANTIC SOUNDNESS — names that lie about what they do, types wider than reality, modules whose contents don't match their name, abstraction boundaries that don't carve the problem at its joints.",
  },
  {
    key: 'dx',
    brief:
      'DX — what makes the next change harder than it should be: confusing naming, missing-but-warranted types, surprising control flow, comments that contradict the code, awkward call sites.',
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'line', 'what', 'why', 'fix', 'mechanical', 'severity', 'evidence'],
        properties: {
          title: { type: 'string', description: 'short label for the finding' },
          file: { type: 'string', description: 'path relative to repo root' },
          line: { type: 'integer', description: 'best single line, or 0 if file-level' },
          what: { type: 'string', description: 'one-line description of the issue' },
          why: { type: 'string', description: 'the concrete cost — the bug it invites, the dupe it forks, the reader it confuses' },
          fix: { type: 'string', description: 'the specific change to make' },
          mechanical: { type: 'boolean', description: 'true if rote, false if it needs judgment' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'optional'] },
          evidence: { type: 'string', description: 'the search/reference that confirms it (required for dupe/dead-code claims)' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isReal', 'confidence', 'reason', 'correctedSeverity'],
  properties: {
    isReal: { type: 'boolean', description: 'true if this is a real, worth-fixing issue (not taste, not wrong, not already handled)' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'why it survives or is refuted, citing what you checked' },
    correctedSeverity: {
      type: 'string',
      enum: ['must-fix', 'should-fix', 'optional', 'drop'],
      description: "the finder's severity, corrected if over/under-rated; 'drop' to kill it",
    },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'checked', 'findings'],
  properties: {
    summary: { type: 'string', description: 'one-line overall verdict; say plainly if nothing material was found' },
    checked: { type: 'string', description: 'short note on what was reviewed and searched, so a clean result is credible' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'where', 'why', 'fix', 'mechanical', 'severity', 'dimensions'],
        properties: {
          title: { type: 'string' },
          where: { type: 'string', description: 'file_path:line (clickable)' },
          why: { type: 'string' },
          fix: { type: 'string' },
          mechanical: { type: 'boolean' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'optional'] },
          dimensions: { type: 'array', items: { type: 'string' }, description: 'the dimension(s) that flagged this code' },
        },
      },
    },
  },
}

// Phase 1+2 as a pipeline: each dimension's findings start verifying the moment
// that dimension's reviewer returns — no barrier idling fast reviewers while a
// slow one finishes. Verify runs inside the pipeline stage with an explicit
// phase so the progress groups stay stable.
phase('Review')
const reviewed = await pipeline(
  DIMENSIONS,
  (d) =>
    agent(
      `${SCOPE}\n\nYou are the ${d.key} reviewer.\n${d.brief}\n\nReturn every finding with: a short title, the file and best line, a one-line "what", the concrete "why it matters", the specific "fix", whether it is mechanical, a severity (must-fix/should-fix/optional), and the evidence that confirms it.`,
      { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA },
    ),
  (review, d) =>
    parallel(
      ((review && review.findings) || []).map((f) => () =>
        agent(
          `${SCOPE}\n\nAdversarially verify this ${d.key} finding. Your default is to REFUTE if you are not convinced. Do the work yourself — if it claims duplication or dead code, run the repo-wide search and confirm or refute it; do not take the finder's word.\n\nFinding:\n${JSON.stringify(f, null, 2)}\n\nDecide: is this REAL and worth fixing, or is it taste / wrong / already handled? Correct the severity if the finder over- or under-rated it; use "drop" to kill it. Remember: do not change behavior, and respect the no-new-tooling stance.`,
          { label: `verify:${d.key}:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ).then((verdict) => ({ ...f, dimension: d.key, verdict })),
      ),
    ),
)

// reviewed = [ [verified...]|null, ... ]. Flatten, drop dead reviewers/verifiers,
// keep only real findings the verifier did not drop.
const confirmed = reviewed
  .flat()
  .filter(Boolean)
  .filter((f) => f.verdict && f.verdict.isReal && f.verdict.correctedSeverity !== 'drop')

log(`${confirmed.length} verified finding(s) across ${DIMENSIONS.length} dimensions`)

// Synthesis is a genuine barrier: it needs ALL verified findings at once to
// merge the same code flagged from different angles and order the whole list.
phase('Synthesize')
const report = await agent(
  `${SCOPE}\n\nHere are the verified cleanup findings across all dimensions (each carries its corrected severity in verdict.correctedSeverity):\n${JSON.stringify(confirmed, null, 2)}\n\nProduce the final review:\n- Merge findings that point at the SAME code from different angles into one entry, listing every angle in "dimensions".\n- Use each finding's corrected severity. Order by severity, then by impact.\n- Format "where" as file_path:line so it is clickable.\n- Write a one-line overall "summary" and a short "checked" note (what was reviewed and searched). If there is nothing material, say so plainly in the summary and return an empty findings array — do NOT pad the list.`,
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT_SCHEMA },
)

return report
