# src/shared

Cross-process code imported by BOTH the main process and the renderer (and the
bundled mobile/remote panel, which aliases `@shared`). Because it is loaded on
every side of the build split, keep it strictly **dependency-free and
side-effect-free**: no Electron, no Node, no DOM, no module-level work — just
types and pure functions. Types are erased at build; helpers must run anywhere.

## Files

- **types.ts** — the canonical cross-process type definitions. The most
  important shapes:
  - `CardStatus` — the agent/shell lifecycle states (`idle` → `running` →
    `waiting`/`done`/`stalled`/`blocked`/`error`).
  - `CardEvent` + `TodoChange`/`AgentTodo` — one semantic update extracted from a
    CLI lifecycle event (status flip, metadata, feed line, plan delta).
  - `PermissionAskInfo` / `AskDecision` — a held permission gate (allow/deny/
    release); `QuestionAskInfo` / `Question` / `QuestionOption` /
    `QuestionAnswers` — a held AskUserQuestion (choose options, not allow/deny).
  - `CardRecord` / `Project` / `MultiProjectSnapshot` — multi-project
    persistence (global card registry + per-project layout).
  - Git: `GitChange` / `GitSnapshot` / `RepoIdentity` / `GitActionRequest` /
    `GitActionResult`.
  - Remote panel: `RemoteState` / `AttentionLevel` + readiness shapes
    (`AppReadiness`, `RemoteReadiness`), `UpdateStatus`.
  - Orchestrator: `OrchestratorMode` / `OrchestratorEvent` /
    `OrchestratorCommand` / `OrchestratorTarget` and their result types.
  - `CanvasApi` — the full interface the preload bridge implements and the
    renderer consumes (the IPC contract in one place).
- **time.ts** — relative-time formatting helpers (`relativeFromSeconds`, the
  `MINUTE`/`HOUR`/`DAY` thresholds). Epoch-seconds in, `"now"`/`"5m"`/`"2h"`/`"Nd"`
  out, with an `overflow` hook for past-a-day formatting.

## Conventions & gotchas

- This is the **source of truth for IPC payload shapes**. `CanvasApi` here is the
  contract that `src/preload` implements and the renderer calls.
- Changing a type here **ripples to main + preload + renderer** at once — update
  all three ends of the seam (and the remote panel if a `@shared` type changes).
- Add nothing with a runtime dependency. If it can't be imported safely from both
  main and renderer, it doesn't belong here.
