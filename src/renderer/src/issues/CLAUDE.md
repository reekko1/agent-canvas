# issues (renderer)

The visible face of the **Mastermind issue store** (see `MASTERMIND.md` at the
repo root) — the `Vision → Sprint → Plan → Issue` chain. It is the renderer
projection of a main-owned reactive store; the fleet writes to that same store
over MCP. This is an **observation deck**, not a console: the human watches a
self-running org (strategist conceives sprints, planner writes plans, lead
decomposes, workers execute, auditors verdict) and only acts on escalations.

The chain renders as **two faces**, both per-project (per canvas):

- a calm right-edge **Vision sheet** (north star + distance) — the human IS the
  sole writer there (authoring the vision);
- the immersive **Issues constellation** — a full-viewport **takeover**, not a
  side sheet.

Both are toggled from the right `SheetRail` via Canvas's `rightSheet`
discriminator (`'diff' | 'vision' | 'issues' | null`). Diff + vision are right
sheets that reserve master width; **issues reserves none** — it overlays the
whole viewport (Canvas: `diffCollapsed: rightSheet === null || === 'issues'`).
One `useIssueBoard` hook backs both faces.

## The constellation — the gravity well

The issues view breaks out of the side sheet into a full-viewport **gravity
well**: the **vision is a sun** at the centre, and the selected sprint's issue-DAG
**orbits it as concentric wave-rings**. The mapping is the metaphor, exactly:

- **Wave 0 (foundations) sits at the outer rim; the final wave touches the sun.**
  Work flows *inward*, from the rim toward the vision/outcome at the centre.
- The **frontier** (first not-fully-done wave) is a **bright ring of light** that
  sweeps inward as waves land. Landed waves recede outward and dim (spent fuel);
  upcoming waves wait dim inside it, nearer the goal.
- The **sun charges with progress** (its glow ∝ done/total) — you watch the system
  contract toward its north star (the asymptote, made visible).

Deep space, luminous orbs (status = colour + motion), glowing dependency edges
that flow inward, the whole field drifting as one slow rigid body. Pure
observation: orbs only — titles on demand (hover → a readout caption, click → the
read-only dossier). Esc returns to the fleet.

## Files

- **useIssueBoard.ts** — the hook: an **observation projection** (restore-once +
  subscribe-once + per-project filter). Reads dominate; the fleet's writes arrive
  over the same `onIssueUpdate` broadcast from main (MCP). The only renderer
  writes are the human's three touchpoints: `commitVisionVersion`,
  `assessDistance`, `resolveRealignment`.
- **useIssuePulses.ts** — derives one-shot "just happened" signals from the
  snapshot stream (status → `done` fires the `issue-land` ripple; a new verdict
  flashes), keyed by a nonce that auto-clears. The first snapshot only seeds the
  baseline.
- **dag.ts** — pure topology: `layerize` (Kahn over `deps`, cycle-guarded),
  `frontierIndexOf` / `toneOf` (landed/frontier/upcoming), and `frontierStats`
  (honest counts + `charge`, the sun's brightness). No React/DOM.

### Issues constellation — the takeover
- **IssueConstellation.tsx** — the takeover shell: the dark space (the canvas
  dims + blurs behind into a ghost), the hero outcome **headline** + fleet-pulse
  readouts (the typographic dynamic range), the **sprint rail** (every sprint as a
  switchable chip), the realignment **escalation** (the one human control), the
  hover readout, the dossier panel, and Esc-to-return. Scoped `dark` so the shared
  theme atoms read correctly regardless of the app's theme.
- **Constellation.tsx** — the spatial renderer: measures the viewport, lays the
  waves out in polar coordinates (radius decreases with wave index → inward
  drain), draws the vision-sun, the frontier ring, the orbs, and the SVG edges,
  and drifts the whole field. DOM orbs + SVG edges (no canvas/WebGL — stays clear
  of the WebGL budget). `Orb` colours/sizes/animates by live status.
- **IssueDossier.tsx** — the read-only record surfaced on orb-select: the brief
  (description / acceptance), live facts (status · owner · deps), the audit trail
  (verdicts), and the worker's notes. All timelines, no inputs.
- **ConceptionField.tsx** — the **pre-ignition deliberation** (the constellation's
  missing state): while the strategist's tournament runs (no sprint yet), its candidate
  ideas hang around the sun as contender **proto-stars** — brighter/larger by Bradley-Terry
  rating, culled ones receded and dim, the winner ignited toward the core. Reuses the
  `<Constellation>` sun beneath (empty issues); hover for a headline, click for the bracket.
- **ConceptionDossier.tsx** — the read-only **bracket**: the gap it read, the winner
  (or the abstention — the "needs you" trail), and the full field ranked by final rating
  with each idea's lens + the round it was culled in.

### Vision sheet — the north star (the human's canvas)
- **VisionSheet / VisionBoard** — the right-edge sheet shell + panel (wears the
  shared `frontier-field` backdrop; stays calm).
- **VisionPanel.tsx** — current vision (static `vision-aura`) + the version
  timeline as a luminous spine + the commit composer (the human is the sole vision
  writer — the one legitimate human authoring in the whole system).
- **DistancePanel.tsx** — distance to the vision: assessed, never computed.

### Shared
- **ui.tsx** — primitives for the Vision sheet's authoring (`Field`/`TextInput`/
  `TextArea`/`InlineComposer`/`Segmented`/`SectionLabel`/`EmptyState`/`asIcon`/
  parsers) + `Drawer`.
- **badges.tsx** — atoms reusing the `--status-*` palette: `StatusDot`/`Tag`, the
  semantic badges + `*_META` maps, `ProgressMeter`, and `nodeMotionClass`.

## Motion vocabulary

All in `renderer/src/index.css`, built like `orchestrator-glow` / `browser-scan`:
**compositor-only**, with a `prefers-reduced-motion` static fallback for **every**
effect. The Frontier set (`frontier-breathe`, `node-working`/`node-blocked`,
`issue-land`, `pulse-ring`, …) plus the constellation set: `starfield` (drifting
stars), `constellation-spin` (the rigid slow drift), `sun-breathe` (+ inline
charge halo), `frontier-ring`, `edge-flow` (inward dash), `orb-twinkle`,
`takeover-in` / `constellation-in`, and the calm static `vision-aura`.

## Conventions & gotchas

- **No local store writes.** The three human mutators send an `issueAction`; the
  UI re-renders on the broadcast. **Constellation geometry, wave tones, fleet-pulse
  counts, and pulses are all _derived_** from the snapshot — never stored, zero
  ripple to main/preload/`shared/types`.
- **Observation-first.** Don't add create/edit affordances. New capability is the
  fleet's job (it arrives over MCP and you render it). The only human controls are
  realignment (in the takeover) and vision authoring (the Vision sheet).
- The takeover is **always dark** (space) regardless of app theme — its root is
  `dark`-scoped so reused theme atoms resolve their dark values. It reserves no
  master width; it's `fixed inset-0`, above the canvas.
- **Design language.** This view deliberately **breaks** the app's "quiet" rule —
  it IS the live system, so it moves, and it leans on **dynamic range** (a huge
  luminous outcome headline ↔ whispered mono meta; the bright sun ↔ deep space).
  Discipline remains: motion is compositor-only + reduced-motion safe; cyan =
  activity; never render a fake number for "distance to vision" (it is assessed,
  not computed) — it stays a qualitative reading.
