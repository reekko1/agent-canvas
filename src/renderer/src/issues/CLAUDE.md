# issues (renderer)

The visible face of the **Mastermind issue store** (see `MASTERMIND.md` at the
repo root) — the `Vision → Sprint → Plan → Issue` chain. It is the renderer
projection of a main-owned reactive store; the fleet writes to that same store
over MCP. This sheet is an **observation deck**, not a console.

**Design premise — the human watches; the fleet acts.** The whole point of the
Mastermind is that a self-running org steers the product: the strategist conceives
sprints, the planner writes plans, the lead decomposes, workers execute, auditors
verdict — all over MCP. So the board hosts **no operator chrome**: no "new
sprint / draft plan / new issue", no approve/advance buttons, no status
dropdowns, no verdict or comment composers. Removing all of that is what frees the
layout. The human's only touchpoints are **authoring the vision** (a different
sheet) and **answering an escalation the system raises** (a stranded sprint's
realignment). Everything else is read-only telemetry.

The execution board is **The Frontier**: the plan's issues as a living dependency
DAG laid out as cascading **waves** that drain downward. Landed waves recede and
dim; the **frontier** (first not-fully-done wave — what the fleet works now) sits
lit, breathing, faintly cyan; upcoming waves wait dim below. As issues complete, a
wave collapses up and the frontier advances. Motion is the point (the deliberate
**showpiece** register): the surface breathes even at rest and events land hard,
reusing the app's cyan "AI is doing something" vocabulary (the comet grid-ripple,
the `browser-scan` wavefront, the `orchestrator-glow` breath).

The chain renders as collapsible right-edge **sheets** — split across **two**: a
calm **Vision sheet** (north star + distance; the human IS the sole writer there)
and the **Issues sheet** (the Frontier deck). Both share the diff's width channel
via Canvas's `rightSheet` discriminator, toggled from the right `SheetRail`. One
`useIssueBoard` hook backs both; everything is per-project (per canvas).

## Files

- **useIssueBoard.ts** — the hook: restore-once via `loadIssueStore`,
  subscribe-once via `onIssueUpdate`, filter to the active project. An
  **observation** projection — reads dominate. The fleet's writes arrive over the
  same broadcast from main (MCP). The only renderer-side writes are the human's
  three touchpoints: `commitVisionVersion`, `assessDistance`, `resolveRealignment`
  (the routine create/decompose/status/verdict mutators were removed — they were
  the operator path that no longer exists).
- **useIssuePulses.ts** — derives one-shot "just happened" signals from the
  snapshot stream: diffs prior status + verdict count per issue, flags ids that
  hit `done` (→ the radial `issue-land` ripple) or gained a verdict (→ a
  clear/issues ring), each with a bumped nonce that auto-clears. The first
  snapshot only seeds the baseline (a fresh load never ripples).

### Vision sheet — the north star (the human's canvas)
- **VisionSheet / VisionBoard** — the shell + panel; wears the shared
  `frontier-field` backdrop so it reads as the same world, but stays calm.
- **VisionPanel.tsx** — current vision (static `vision-aura`) + the version
  timeline as a **luminous spine** + the commit composer (the human is the sole
  vision writer — this is the one legitimate human authoring in the whole system).
- **DistancePanel.tsx** — distance to the vision: assessed, never computed; the
  human (later: a recurring auditor) records it.

### Issues sheet — the Frontier observation deck
- **IssueBoard.tsx** — the composition root. A pinned header (the read-only
  `SprintSwitcher` + the `FleetPulse` telemetry strip) over a scrolling body (the
  read-only **plan band**, the realignment escalation, then the `Frontier`). Owns
  selection + the node `Drawer`. The only interactive element it renders is the
  `RealignBanner` (the human escalation); everything else observes. Empty states
  speak in the system's voice ("Awaiting the planner", "the strategist proposes
  the next one") rather than human imperatives.
- **SprintSwitcher.tsx** — pure navigation: the active sprint reads prominently
  (state dot · outcome · `ProgressMeter` · pinned `v{n}`); a portaled base-ui
  popover switches which sprint is observed. Creates nothing.
- **Frontier.tsx** — the living wave-banded DAG. `layerize` (Kahn over `deps`,
  cycle-guarded) gives topology; **live status** classifies each wave
  (`landed`/`frontier`/`upcoming`). The frontier breathes; connectors flow
  (`dag-flow`); a cycle lands in a flagged group. Exports `frontierStats` for the
  fleet-pulse. No composer — issues arrive from the lead over MCP.
- **IssueNode.tsx** — one issue as a living **cell** (kind glyph · title · quiet
  cluster of deps · verdict mark · status · owner), wearing its status motion on
  the frontier. Clicking opens **`IssueDetail`**, a **read-only dossier**: the
  brief (description / acceptance), live facts (status · owner · deps), the
  **audit trail** (verdicts the auditor posted, with a needs-decision escalation
  marker), and the worker's **notes** — all timelines, no inputs.

### Shared
- **ui.tsx** — the primitive vocabulary: `Field`/`TextInput`/`TextArea`/
  `InlineComposer`/`Segmented` (used by the Vision sheet's authoring),
  `SectionLabel`/`EmptyState`/`asIcon`/`csvToList`/`linesToList`, and **`Drawer`**
  (the bottom slide-over node inspector). (The old `Select`/`Chip` editing atoms
  were removed with the issue-board controls.)
- **badges.tsx** — presentational atoms reusing the `--status-*` palette:
  `StatusDot`/`Tag`, the semantic badges (`SprintStateBadge`, `IssueStatusBadge`,
  `ClassTag`, `VerdictPill`/`VerdictMark`, `KindGlyph`) + their `*_META` maps,
  **`ProgressMeter`** (the one honest number — done/total), and
  **`nodeMotionClass`** (ambient motion by live status).

The sheet frame lives one level up — `canvas/SheetShell.tsx` — shared by all
three right-edge sheets so they read as one family.

## Motion vocabulary

All in `renderer/src/index.css`, built like `orchestrator-glow` / `browser-scan`
/ `deck-*`: **compositor-only** (box-shadow / transform / opacity /
background-position), keyed nonces for one-shots, and a `prefers-reduced-motion`
fallback to a static, legible state for **every** effect: `frontier-breathe`,
`node-working` / `node-blocked`, `dag-flow`, `issue-land`, `pulse-ring` (+
`node-land-flash`), `wave-ignite`, the ambient `frontier-field`, `drawer-up`, and
the calm static `vision-aura`.

## Conventions & gotchas

- **No local store writes.** The three human mutators send an `issueAction`; the
  UI re-renders on the `onIssueUpdate` broadcast (single arbiter). **Frontier
  state, wave tones, fleet-pulse counts, and pulses are all _derived_** from the
  snapshot (`status` + `deps` + diffs) — never stored, so there's zero ripple to
  main/preload/`shared/types`.
- **Observation-first.** Don't add create/edit affordances to this sheet — if a
  new capability is the fleet's job, it arrives over MCP and you render it. The
  only human controls are realignment (here) and vision authoring (Vision sheet).
- Both sheets mount in `Canvas.tsx` next to `DiffSheet`, gated by the shared
  `rightSheet` state; the master reserves the sheet width when any is open.
- **Design language.** This sheet deliberately **breaks** the app's "quiet, no
  loud motion" rule — it IS the live system, so it moves. Discipline remains:
  motion is compositor-only and reduced-motion safe; the type scale stays tight
  (`13px` content / `text-xs` body / `text-[11px]` meta, nothing smaller); cyan =
  activity (distinct from the `--status-*` attention palette); never render a fake
  number for "distance to vision" (it is assessed, not computed).
