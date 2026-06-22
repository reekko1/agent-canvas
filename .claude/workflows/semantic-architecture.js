export const meta = {
  name: 'semantic-architecture',
  description:
    'Whole-branch semantic + architecture audit: deep-read each module group for naming-truth, mix-of-concern, and placement; cross-cutting passes for ambiguous/duplicate naming, module boundaries, and structural duplication; every finding adversarially verified, then synthesized.',
  whenToUse: 'Driven after a branch is functionally done and cleanup-reviewed, to confirm the file architecture is sound and every name tells the truth.',
  phases: [
    { title: 'Map', detail: 'one reader per module group — naming-truth, mix-of-concern, placement, + a symbol inventory' },
    { title: 'Crosscut', detail: 'whole-tree passes that need the full inventory: naming coherence, architecture/placement, structural duplication' },
    { title: 'Verify', detail: 'adversarially confirm every finding against the real code' },
    { title: 'Synthesize', detail: 'dedup + prioritize into one list' },
  ],
}

// ── Scope: the branch's source files, grouped into coherent review units ──────
// CSS/HTML/docs/package.json are excluded as primary targets (this pass audits
// code semantics + module shape); finders may still read them for context.
const GROUPS = [
  { key: 'mastermind-core', desc: 'the mastermind learning substrate — on-disk paths, event-sourced memory, reaction log, deterministic triggers, curator, model split, world view, reviewer constitutions',
    files: ['src/main/mastermind/paths.ts','src/main/mastermind/memory.ts','src/main/mastermind/reactions.ts','src/main/mastermind/triggers.ts','src/main/mastermind/curator.ts','src/main/mastermind/models.ts','src/main/mastermind/world.ts','src/main/mastermind/constitutions.ts'] },
  { key: 'mastermind-reactor', desc: 'the mastermind reactor + learning loop — per-milestone reaction query, the two reviewers, the learning coordinator, the skill library, the deterministic edge suite, the smokes',
    files: ['src/main/mastermind/reactor.ts','src/main/mastermind/reviewers.ts','src/main/mastermind/learning.ts','src/main/mastermind/skills.ts','src/main/mastermind/edges.ts','src/main/mastermind/learn-smoke.ts','src/main/mastermind/live-smoke.ts','src/main/mastermind/operator-smoke.ts'] },
  { key: 'orchestrator-bus', desc: 'the orchestrator CommandBus seam + the in-process canvas MCP — contract types, the canvas MCP server, the live mainBus, the offline stubBus',
    files: ['src/main/orchestrator/contract.ts','src/main/orchestrator/canvasServer.ts','src/main/orchestrator/mainBus.ts','src/main/orchestrator/stubBus.ts'] },
  { key: 'orchestrator-loop', desc: 'the orchestrator loop + driver — the long-lived Agent SDK query and the Orchestrator class that owns session/queue/gate/modes/cascade',
    files: ['src/main/orchestrator/manager.ts','src/main/orchestrator/orchestrator.ts'] },
  { key: 'issue-substrate', desc: 'the issue store substrate (main side) — the append-only IssueStore and the agent-facing, role-gated issue MCP server',
    files: ['src/main/orchestrator/agentIssueMcp.ts','src/main/issueStore.ts'] },
  { key: 'main-entry', desc: 'the Electron main entrypoint, the preload IPC bridge, and the phone/remote panel server',
    files: ['src/main/index.ts','src/preload/index.ts','src/main/remote/remoteServer.ts'] },
  { key: 'spine', desc: 'the spine — launches/supervises claude in tmux, the claude adapter, the staged skill library, the pinned strategist tournament workflow + its ?raw type shim',
    files: ['src/main/spine/spine.ts','src/main/spine/claudeAdapter.ts','src/main/spine/skills.ts','src/main/spine/strategistTournament.js','src/main/spine/raw-modules.d.ts'] },
  { key: 'issues-constellation', desc: 'the issues constellation takeover — the shell, the spatial renderer, the read-only dossiers, the pre-ignition conception field, the DAG topology, the pulse derivations',
    files: ['src/renderer/src/issues/IssueConstellation.tsx','src/renderer/src/issues/Constellation.tsx','src/renderer/src/issues/IssueDossier.tsx','src/renderer/src/issues/ConceptionField.tsx','src/renderer/src/issues/ConceptionDossier.tsx','src/renderer/src/issues/dag.ts','src/renderer/src/issues/useIssuePulses.ts'] },
  { key: 'issues-vision', desc: 'the vision sheet (the human authoring face) + the shared issue-board atoms — the sheet/board/panel/distance, the board hook, the badges and ui primitives',
    files: ['src/renderer/src/issues/VisionSheet.tsx','src/renderer/src/issues/VisionBoard.tsx','src/renderer/src/issues/VisionPanel.tsx','src/renderer/src/issues/DistancePanel.tsx','src/renderer/src/issues/useIssueBoard.ts','src/renderer/src/issues/badges.tsx','src/renderer/src/issues/ui.tsx'] },
  { key: 'canvas-core', desc: 'the canvas master-stack composition root + its core hooks — the board, layout geometry, the orchestrator command bridge, remote publish, workspace persistence',
    files: ['src/renderer/src/canvas/Canvas.tsx','src/renderer/src/canvas/useMasterStackLayout.ts','src/renderer/src/canvas/useOrchestratorCommands.ts','src/renderer/src/canvas/useRemotePublish.ts','src/renderer/src/canvas/useWorkspace.ts','src/renderer/src/canvas/layout.ts'] },
  { key: 'canvas-sheets', desc: 'the canvas sheets + renderer glue — the right rail, sheet shell, diff sheet + diff node, skills sheet/panel/hook, card meta reducer, the chat bar, renderer voice glue',
    files: ['src/renderer/src/canvas/DiffSheet.tsx','src/renderer/src/canvas/SheetRail.tsx','src/renderer/src/canvas/SheetShell.tsx','src/renderer/src/canvas/SkillsPanel.tsx','src/renderer/src/canvas/SkillsSheet.tsx','src/renderer/src/canvas/useSkillsPanel.ts','src/renderer/src/diff/DiffNode.tsx','src/renderer/src/cards/meta.ts','src/renderer/src/orchestrator/ChatBar.tsx','src/renderer/src/orchestrator/voice.ts'] },
  { key: 'remote-app', desc: 'the standalone phone web client — the chat view, the entry/main wiring, the net layer, the orchestrator socket, the supervise view, the terminal view, utils, voice',
    files: ['src/remote-app/chat.ts','src/remote-app/main.ts','src/remote-app/net.ts','src/remote-app/orch.ts','src/remote-app/supervise.ts','src/remote-app/term.ts','src/remote-app/util.ts','src/remote-app/voice.ts'] },
  { key: 'shared', desc: 'the cross-process source of truth — the canonical type definitions and the new provenance helpers',
    files: ['src/shared/types.ts','src/shared/provenance.ts'] },
]

const TREE = `src/main, src/main/git, src/main/mastermind, src/main/orchestrator, src/main/remote, src/main/spine, src/main/voice, src/preload, src/remote-app, src/renderer/src/{assets,canvas,cards,components/ui,diff,hooks,issues,lib,orchestrator,remote,setup}, src/shared`

// The shared bar every reader and verifier sees.
const BAR = `
You are auditing the work on the current branch (base \`main\`) for SEMANTIC SOUNDNESS and ARCHITECTURE — NOT bugs, NOT dead code.

Context you MUST respect (or you will produce noise):
- This branch ALREADY WORKS and was JUST cleanup-reviewed (dead code, unused exports, and obvious dupes were already removed and fixed). Do NOT re-report dead code, unused symbols, missing guards, or anything a cleanup pass would catch. This pass is ONLY about: does every NAME tell the truth, does every FILE hold one concern, is every file in the RIGHT place, and does the whole thing read COHERENTLY (no two-words-for-one-thing, no one-word-for-two-things).
- The codebase has a DELIBERATE, DOCUMENTED, evocative voice: mastermind, reactor, constellation, gravity well, comet, spine, frontier, conception, sprint, fly-in. These are INTENTIONAL and are explained in each directory's CLAUDE.md. An evocative name that is used CONSISTENTLY and documented is CORRECT — do NOT flag it as "unclear" or suggest a blander name. Taste is not a finding.
- The directory's \`CLAUDE.md\` is the STATED intent. A name LIES when the code's actual behavior contradicts the name AND/OR the CLAUDE.md's claim. A mismatch between what CLAUDE.md says a symbol does and what it actually does is itself a finding (the doc or the name is wrong).
- No behavior changes. No new tooling/linters/formatters (tsc + build is the only gate). Match the surrounding idiom.

Only report something with a CONCRETE COST: a real misread the next developer would make, a wrong mental model the name plants, a file whose mixed concerns make the next change touch two things. If it is merely taste, or you cannot name the cost, DROP it.
`

const FINDING_PROPS = {
  title: { type: 'string', description: 'short label' },
  file: { type: 'string', description: 'path relative to repo root (best single file)' },
  line: { type: 'integer', description: 'best single line, or 0 if file-level' },
  category: { type: 'string', enum: ['naming', 'concern', 'placement', 'duplication', 'ambiguity', 'coherence'] },
  what: { type: 'string', description: 'one-line description of the issue' },
  why: { type: 'string', description: 'the concrete cost — the misread it invites, the wrong model it plants' },
  fix: { type: 'string', description: 'the specific rename/move/split, and the better name if a rename' },
  mechanical: { type: 'boolean', description: 'true if a rote rename/move, false if it needs judgment' },
  severity: { type: 'string', enum: ['must-fix', 'should-fix', 'optional'] },
  evidence: { type: 'string', description: 'what proves it — the behavior vs the name, both sites of a dupe/ambiguity (with paths), or the CLAUDE.md claim it contradicts' },
}
const FINDING_ITEM = { type: 'object', additionalProperties: false, required: Object.keys(FINDING_PROPS), properties: FINDING_PROPS }

const MAP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings', 'inventory'],
  properties: {
    findings: { type: 'array', items: FINDING_ITEM },
    inventory: {
      type: 'array',
      description: 'one entry per file in the group — fuel for the cross-file naming/duplication pass',
      items: {
        type: 'object', additionalProperties: false, required: ['file', 'purpose', 'exports'],
        properties: {
          file: { type: 'string' },
          purpose: { type: 'string', description: 'the file\'s ONE true purpose, in <=15 words (what it ACTUALLY does)' },
          exports: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['name', 'does'],
              properties: {
                name: { type: 'string', description: 'exported symbol name' },
                does: { type: 'string', description: '<=10 words: what it ACTUALLY does (real behavior, not intended)' },
              },
            },
          },
        },
      },
    },
  },
}

const FINDINGS_ONLY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: FINDING_ITEM } },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['isReal', 'confidence', 'reason', 'correctedSeverity'],
  properties: {
    isReal: { type: 'boolean', description: 'true if real and worth fixing (not taste, not wrong, not a deliberate documented name, not already-handled)' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'why it survives or is refuted, citing what you read/searched' },
    correctedSeverity: { type: 'string', enum: ['must-fix', 'should-fix', 'optional', 'drop'] },
  },
}

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'checked', 'findings'],
  properties: {
    summary: { type: 'string', description: 'one-line overall verdict; say plainly if the architecture is sound and names tell the truth' },
    checked: { type: 'string', description: 'how many files/groups were read and what cross-cutting passes ran, so a clean result is credible' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'where', 'why', 'fix', 'mechanical', 'severity', 'categories'],
        properties: {
          title: { type: 'string' },
          where: { type: 'string', description: 'file_path:line (clickable); for a cross-file finding, both sites' },
          why: { type: 'string' },
          fix: { type: 'string' },
          mechanical: { type: 'boolean' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'optional'] },
          categories: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

// ── Phase 1: Map — one deep reader per group (barrier; the crosscut needs every inventory) ──
phase('Map')
const maps = (await parallel(
  GROUPS.map((g) => () =>
    agent(
      `${BAR}\n\nYou are the reader for module group "${g.key}": ${g.desc}.\n\nRead EVERY file below IN FULL, plus the CLAUDE.md of each file's directory, plus any immediate neighbor you need to judge a name's truth:\n${g.files.map((f) => `  - ${f}`).join('\n')}\n\nFor each file judge three things and report any finding with a concrete cost:\n1. NAMING TRUTH — does the file name and EACH exported symbol's name accurately describe what it does? Flag a name that LIES (claims X, does Y), and any place CLAUDE.md describes a symbol differently than the code behaves.\n2. MIX-OF-CONCERN — does the file hold exactly ONE concern, or does it mix layers (IO + view, control + presentation, data + rendering, two unrelated responsibilities)? Name the concern that doesn't belong and where it should live.\n3. PLACEMENT — is the file in the right directory/layer for what it actually does?\n\nThen produce the INVENTORY: for every file, its one true purpose (<=15 words) and each exported symbol with a <=10-word description of what it ACTUALLY does. Be precise about real behavior — this feeds a cross-file pass that hunts two-names-for-one-thing and one-name-for-two-things, so an imprecise "does" will hide a real collision.`,
      { label: `map:${g.key}`, phase: 'Map', schema: MAP_SCHEMA },
    ).then((m) => ({ g, m })),
  ),
)).filter((x) => x && x.m)

const inventory = maps.map(({ g, m }) => ({ group: g.key, files: m.inventory || [] }))
const groupFindings = maps.flatMap(({ g, m }) => (m.findings || []).map((f) => ({ ...f, source: `map:${g.key}` })))
const invJson = JSON.stringify(inventory, null, 1)
log(`mapped ${maps.length}/${GROUPS.length} group(s); ${inventory.reduce((n, x) => n + x.files.length, 0)} files inventoried → ${groupFindings.length} per-file finding(s)`)

// ── Phase 2: Crosscut — whole-tree passes that only make sense holding the full inventory ──
const CROSSCUTS = [
  { key: 'naming-coherence',
    brief: `Using the symbol inventory, find naming INCOHERENCE across the WHOLE branch:\n(a) the SAME concept named DIFFERENTLY in different files (a reader must learn two words for one thing);\n(b) ONE name used for DIFFERENT things in different files (a collision that plants a wrong link);\n(c) near-identical names that differ subtly enough to be confused at a call site.\nName BOTH sites (with paths) for each. IGNORE deliberate, documented evocative names used CONSISTENTLY — those are correct. Read the actual code at both sites to confirm the concepts truly are same/different before reporting.` },
  { key: 'architecture',
    brief: `Using the inventory + this directory tree, assess FILE PLACEMENT and MODULE BOUNDARIES across the whole tree:\nTREE: ${TREE}\nIs any file in the wrong directory/layer for what it actually does? Do the modules (mastermind / orchestrator / spine / issues / remote-app / shared / canvas) carve the problem at its joints, or does one concern leak across them (e.g. the same responsibility split across two dirs, or two responsibilities fused in one)? Is any module a god-module that should split, or two that should merge? For each, name the seam and where the code belongs. Read the files you cite — placement claims must be grounded, not guessed from names.` },
  { key: 'structural-duplication',
    brief: `Using the inventory, find logic, types, or constants genuinely RE-IMPLEMENTED in two+ places that should have ONE home. The prior cleanup pass already removed dead code and the obvious dupes — hunt the SUBTLER structural ones the per-file readers could not see because each saw only its own group (e.g. two modules independently encoding the same state machine, the same shape redefined on two sides of a boundary instead of imported, parallel helper pairs). Name every site; the fix must point at the single home. grep the repo to confirm both copies exist and are truly equivalent before reporting.` },
]
phase('Crosscut')
const crosscutFindings = (await parallel(
  CROSSCUTS.map((c) => () =>
    agent(
      `${BAR}\n\nYou are the cross-cutting "${c.key}" reviewer. You hold the symbol inventory for the WHOLE branch (below). You have full read/grep tools — USE them to confirm against real code before reporting.\n\n${c.brief}\n\nSYMBOL INVENTORY (group → files → exports):\n${invJson}`,
      { label: `crosscut:${c.key}`, phase: 'Crosscut', schema: FINDINGS_ONLY_SCHEMA },
    ).then((r) => (r && r.findings ? r.findings.map((f) => ({ ...f, source: `crosscut:${c.key}` })) : [])),
  ),
)).filter(Boolean).flat()
log(`crosscut: ${crosscutFindings.length} whole-tree finding(s)`)

// ── Phase 3: Verify — adversarially confirm every finding against the real code ──
const allRaw = [...groupFindings, ...crosscutFindings]
phase('Verify')
const verified = (await parallel(
  allRaw.map((f) => () => {
    const searchable = f.category === 'duplication' || f.category === 'ambiguity'
    const stance = searchable
      ? 'This is a SEARCHABLE claim. Default to REFUTE unless your OWN repo-wide grep confirms BOTH sites exist and are truly equivalent/colliding — re-run the search yourself.'
      : 'This is a JUDGMENT call. Do NOT default to refute. Read the cited code yourself (for a placement/boundary finding, read both ends). DROP it if: the name is a deliberate, documented evocative term used consistently; it is pure taste with no concrete cost; it is wrong; or it is a dead-code/bug finding that belongs to a different pass.'
    return agent(
      `${BAR}\n\nAdversarially verify this ${f.category} finding. ${stance}\n\nFinding:\n${JSON.stringify(f, null, 2)}\n\nIs it REAL and worth fixing? Correct the severity if over/under-rated; use "drop" to kill it. A rename/move that ripples widely for a small clarity gain should be downgraded, not inflated.`,
      { label: `verify:${f.category}:${(f.file || 'x').split('/').pop()}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((verdict) => ({ ...f, verdict }))
  }),
)).filter(Boolean)
const confirmed = verified.filter((f) => f.verdict && f.verdict.isReal && f.verdict.correctedSeverity !== 'drop')
log(`verified ${allRaw.length} finding(s) → ${confirmed.length} survived`)

// ── Phase 4: Synthesize — merge, dedup, prioritize (barrier; needs all survivors at once) ──
phase('Synthesize')
const report = await agent(
  `${BAR}\n\nHere are the verified semantic/architecture findings across every module group + the cross-cutting passes (each carries verdict.correctedSeverity):\n${JSON.stringify(confirmed, null, 2)}\n\nProduce the final review:\n- MERGE findings that point at the same code/name into one entry; list every category that flagged it in "categories". A file-level finding subsumes line-level ones about the same concern.\n- Order by corrected severity; within a severity keep same-file/region findings adjacent.\n- "where" = file_path:line (clickable); for a cross-file naming/dup finding, name BOTH sites.\n- Write a one-line "summary" and a "checked" note (groups read, files inventoried, crosscuts run). If the architecture is sound and the names tell the truth, SAY SO plainly and return few/no findings — do NOT manufacture taste findings to look productive.`,
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT_SCHEMA },
)
return report
