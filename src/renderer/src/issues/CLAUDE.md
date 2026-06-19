# issues (renderer)

The visible face of the **Mastermind issue store** (see `MASTERMIND.md` at the
repo root) — the `Vision → Sprint → Plan → Issue` chain. It is the renderer
projection of a main-owned reactive store; the other projection (agents over MCP)
is a later milestone. Milestone 1 is **substrate, visible**: the human drives
everything manually, and every spot where an agent will eventually act (gate
verdicts, propagation adjudication, distance assessment) is a manual control here
behind a seam an agent later assumes.

Like the diff sheet, the chain renders as collapsible right-edge **sheets, not
canvas nodes** — and it is split across **two** of them so neither crowds the
other: a **Vision sheet** (the north star + distance) and an **Issues sheet** (the
sprint → plan → issue execution board). Both share one width channel with the diff
via Canvas's `rightSheet` discriminator (`'diff' | 'vision' | 'issues' | null`) —
at most one is expanded. All three are toggled from the floating right `SheetRail`
(the mirror of the left `ActionRail`); none has its own edge tab. One
`useIssueBoard` hook backs both sheets (same store, two faces).

## Files

- **useIssueBoard.ts** — the hook (sibling of `useWorkspace`/`useProjects`),
  shared by both sheets: restore-once via `loadIssueStore`, subscribe-once via
  `onIssueUpdate`, filter to the active project, and thin mutators that each send
  one `issueAction` (truth returns over the broadcast — no local store writes;
  main is the single arbiter). Everything is per-project — each canvas has its own
  vision, sprints, and issues.

### Vision sheet — the north star
- **VisionSheet.tsx** — the overlay shell (copy of `DiffSheet`): right-edge park
  (inset by `RIGHT_GUTTER` to clear the rail), keyed by active project id, renders
  `VisionBoard`. Toggled from `SheetRail`; no edge tab.
- **VisionBoard.tsx** — the panel: the distance assessment up top, then the full
  vision below (it gets the whole sheet now, so no inner fold and no height cap).
- **VisionPanel.tsx** — current vision + the immutable version timeline ("git for
  intent") + the commit composer (rationale + class; the human is the sole writer).
- **DistancePanel.tsx** — distance to the vision: assessed, never computed; a
  manual "Record assessment" slot + timeline (the seam a recurring auditor fills).

### Issues sheet — the execution board
- **IssueSheet.tsx** — the overlay shell (copy of `DiffSheet`): right-edge park
  (inset by `RIGHT_GUTTER` to clear the rail), keyed by active project id, renders
  `IssueBoard`. Toggled from `SheetRail`; no edge tab.
- **IssueBoard.tsx** — the panel (the `DiffNode` analogue): a master-detail split —
  the project's sprints on the left, the selected sprint's plan + issue DAG on the
  right. (Vision + distance moved to the Vision sheet, so this stays a clean board.)
- **SprintList.tsx** — selectable sprint rows with state badge, vision-version
  chip, and the realignment marker + manual adjudication; the "+ sprint" composer.
- **PlanView.tsx** — the selected sprint's detail: state-machine advance, the plan
  (manual "Approve plan" = gate #1), and its `IssueDag`.
- **IssueDag.tsx** — the plan's issues as dependency-ordered waves (Kahn over
  `deps`, cycle-guarded) — wave 0 is the parallel frontier; plus the issue composer.
- **IssueRow.tsx** — one issue: collapsed glyph/title/status/owner/deps/verdicts;
  expanded description/verify, status control, dep editor, verdict composer (manual
  gate #3), comments. `owner` is a first-class chip (the future card-id link).

### Shared
- **ui.tsx** — the board's design vocabulary, so there is exactly ONE definition
  of each repeated piece (it killed ~15 copies of the input className string and
  6 hand-rolled composers). `Field` / `TextInput` / `TextArea` (one `fieldSurface`
  class), `InlineComposer` (the open→fields→Create/Cancel shell every composer
  reuses), `Select` (a thin wrap of base-ui's portaled select — its popup never
  clips against the sheet's scroll container, and each option carries a status
  dot), `Segmented` + `Chip` (for small sets / dep toggles, used instead of native
  selects and checkboxes), `SectionLabel`, `EmptyState`, `asIcon` (Lucide→`Button`
  leadingIcon adapter), and the `csvToList` / `linesToList` parsers.
- **badges.tsx** — presentational atoms + semantic chips. `StatusDot` (the quiet
  6px carrier) and `Tag` (faint-tint or neutral pill) are the atoms; the semantic
  badges (`SprintStateBadge`, `IssueStatusBadge`, `ClassTag`, `VerdictPill` /
  `VerdictMark`, `KindGlyph`) and their `*_META` label/color maps build on them.
  Reuses the `--status-*` palette so a work-unit reads in the same language as an
  agent card. The discipline is restraint: status is a quiet dot + muted label, a
  loud treatment is reserved for what interrupts (a failed verdict, a realignment).

The sheet frame itself lives one level up — `canvas/SheetShell.tsx` — and is
shared by all three right-edge sheets (diff / vision / issues) so they read as one
object family: a hairline border, a single soft shadow for lift, and a flush
header (the title is a node, so the diff keeps its mono path and the boards get a
sans heading) with shared window controls.

## Conventions & gotchas

- **No local store writes.** Mutators send an `issueAction`; the UI re-renders on
  the `onIssueUpdate` broadcast (single arbiter — same shape as DiffNode → gitAction
  → watcher re-push).
- Both sheets mount in `Canvas.tsx` next to `DiffSheet`, gated by the shared
  `rightSheet` state; the master reserves the sheet width when any is open.
- **Electron has no `window.prompt`** — all input is inline composers (like the
  rest of the canvas).
- **Design language (keep it Linear-clean).** Build from the `ui.tsx` primitives
  rather than re-styling inline. The type scale is tight and fixed — `13px`
  content, `text-xs` (12px) body, `text-[11px]` meta/chips, and **nothing
  smaller** (no 9/10px). Hierarchy comes from weight + color, never from heavy
  borders, shouting uppercase, or stacked shadows. Hairline `border-border` only.
  Buttons are `md` (the default) — **don't use `size="sm"`**; `secondary` for
  entry points (New sprint / New issue / Draft plan), `ghost` for Cancel, the
  `icon-xs` window controls live in `SheetShell`. Keep per-row color quiet: one
  status dot, not a row of loud pills.
