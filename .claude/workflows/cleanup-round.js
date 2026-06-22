export const meta = {
  name: 'cleanup-round',
  description:
    'Branch cleanup review: one finder per dimension in parallel, each finding adversarially verified, then synthesized into a single deduped, prioritized list. Finds nothing-to-touch honestly; never manufactures findings.',
  whenToUse:
    'Driven by the /cleanup-round command after the diff has been scouted. Pass args = { base, changedFiles, focus }.',
  phases: [
    { title: 'Scope', detail: 'recover the diff scope if the caller did not supply it (fallback only)' },
    { title: 'Review', detail: 'one reviewer per cleanup dimension, in parallel' },
    { title: 'Verify', detail: 'adversarially confirm each finding (repo-wide search for dupe/dead-code claims)' },
    { title: 'Synthesize', detail: 'dedup findings across dimensions into one prioritized list' },
  ],
}

// In this harness args arrives as a JSON STRING, not a parsed object — parse
// defensively so it works whether the caller passes an object or a string.
function parseArgs(a) {
  if (a == null) return {}
  if (typeof a === 'string') {
    try {
      return JSON.parse(a)
    } catch (e) {
      return {}
    }
  }
  return a
}

const input = parseArgs(args)
let base = (input.base || '').toString().trim()
let changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : []
const focus = (input.focus || '').toString().trim()

const SCOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['base', 'changedFiles'],
  properties: {
    base: { type: 'string', description: 'merge-base sha of HEAD and main' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'changed paths, excluding pure deletions and lockfiles' },
  },
}

// Fallback only: if the command did not hand us a scope, recover it ONCE here
// rather than letting every reviewer recompute it inconsistently.
if (!base || !changedFiles.length) {
  phase('Scope')
  const scout = await agent(
    'Establish the scope of this branch review. Run `git merge-base HEAD main` for the base sha, then `git diff --name-only <base>...HEAD` for the changed files. Drop pure deletions and lockfiles (package-lock.json, etc.). Return the base sha and the changed-file list.',
    { label: 'scout-diff', phase: 'Scope', schema: SCOPE_SCHEMA },
  )
  if (scout) {
    base = base || scout.base
    changedFiles = changedFiles.length ? changedFiles : scout.changedFiles
  }
}
base = base || 'main'

// Shared brief every reviewer and verifier sees: the scope + the bar.
const SCOPE = `
You are reviewing the work done on the current branch — NOT the whole repo.
Base ref = \`${base}\`. The branch diff is \`git diff ${base}...HEAD\`.

Changed files in scope (already filtered of pure deletions and lockfiles —
review only these, do not wander off-branch):
${changedFiles.length ? changedFiles.map((f) => `  - ${f}`).join('\n') : '  (none — report that there is nothing to review)'}
${focus ? `\nWeight this focus area more heavily: ${focus}\n(Focus re-prioritizes attention WITHIN the files above — it never adds out-of-diff files.)\n` : ''}
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

// The cleanup bar — one reviewer per dimension, in rough priority order. The
// cross-cutting reviewer is the one that holds the whole change at once; the
// others are single lenses.
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
    key: 'cross-cutting',
    brief:
      'CROSS-CUTTING / SEAMS — the findings only visible when you hold the WHOLE change at once. Trace each value that crosses a module or process boundary in this diff end-to-end (e.g. shared types -> main producer -> preload bridge -> renderer consumer). Flag where the same shape is redefined on two sides instead of imported from one, where a type is wider at one end than the producer actually emits, or where a contract changed on one side of a boundary but not the other. Read BOTH ends of every boundary you assess, not just one file.',
  },
  {
    key: 'architecture',
    brief:
      'ARCHITECTURE / STRUCTURAL — whole-file and whole-module problems the line-level lenses miss. (1) ORPHANS: for each ADDED file in scope, trace whether it is actually reachable from a real entry point (main/index.ts wiring, the React render tree, server route or MCP registration, a smoke/CLI entry). Flag any added file that nothing imports or mounts — a whole dead file is the highest-value cut; say what currently references it (or that nothing does). (2) NEAR-DUPLICATE / SUPERSEDED FILES: sibling files that are competing or superseded implementations of the same thing (e.g. an earlier UI iteration left beside its replacement). Name BOTH files and which one is actually live in the render/import graph. (3) MISPLACED MODULES: a file in the wrong directory/layer for what it does. Prove reachability with a repo-wide grep before calling a file an orphan; cite the exact search in evidence.',
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
    checked: { type: 'string', description: 'how many files were reviewed and what was searched, so a clean/empty result is self-evidently credible' },
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
  (review, d) => {
    // Searchable dimensions get refute-by-default; judgment dimensions do not,
    // or the skeptic erodes genuine taste-with-cost findings.
    const searchable = d.key === 'duplication' || d.key === 'dead-code'
    const stance = searchable
      ? 'This is a SEARCHABLE claim. Default to REFUTE unless your OWN repo-wide search confirms it — re-run the search yourself; do not take the finder\'s word.'
      : 'This is a JUDGMENT call, not a searchable fact. Do NOT default to refute. Confirm it by reading the code yourself (for a boundary/seam finding, read BOTH ends). Drop it only if it is wrong, already handled, or pure taste with no concrete cost named.'
    return parallel(
      ((review && review.findings) || []).map((f) => () =>
        agent(
          `${SCOPE}\n\nAdversarially verify this ${d.key} finding. ${stance}\n\nFinding:\n${JSON.stringify(f, null, 2)}\n\nDecide: is this REAL and worth fixing? Correct the severity if the finder over- or under-rated it; use "drop" to kill it. Remember: do not change behavior, and respect the no-new-tooling stance.`,
          { label: `verify:${d.key}:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ).then((verdict) => ({ ...f, dimension: d.key, verdict })),
      ),
    )
  },
)

// reviewed = [ [verified...]|null, ... ]. Flatten, drop dead reviewers/verifiers,
// keep only real findings the verifier did not drop.
const confirmed = reviewed
  .flat()
  .filter(Boolean)
  .filter((f) => f.verdict && f.verdict.isReal && f.verdict.correctedSeverity !== 'drop')

log(`reviewed ${changedFiles.length} file(s) across ${DIMENSIONS.length} dimensions → ${confirmed.length} verified finding(s)`)

// Synthesis is a genuine barrier: it needs ALL verified findings at once to
// merge the same code flagged from different angles and order the whole list.
phase('Synthesize')
const report = await agent(
  `${SCOPE}\n\nHere are the verified cleanup findings across all dimensions (each carries its corrected severity in verdict.correctedSeverity):\n${JSON.stringify(confirmed, null, 2)}\n\nProduce the final review:\n- MERGE findings that point at the same code into one entry. Treat as the same code any findings whose file:line match OR fall within the same function/block; a file-level (line 0) finding subsumes line-level findings in the same file about the same concern. List every dimension that flagged a merged entry in "dimensions". When two look mergeable but you are unsure, Read the file to decide.\n- Order by corrected severity. Within a severity, keep findings on the same file/region adjacent. Do NOT re-rank on an "impact" you cannot verify from the findings alone.\n- Format "where" as file_path:line so it is clickable.\n- Write a one-line overall "summary" and a "checked" note stating how many files were reviewed and what was searched. If there is nothing material, say so plainly in the summary and return an empty findings array — do NOT pad the list.`,
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT_SCHEMA },
)

return report
