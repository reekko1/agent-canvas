# cards

The per-card UI for the canvas. A card is one unit of work on the canvas — an `agent` (a watched `claude` CLI in tmux) or a bare `shell`. Every card always owns a live xterm terminal; the focused/master card shows that terminal, and stacked (unfocused) cards overlay a compact "face" on top of the still-mounted terminal. This folder also holds the held-ask toast stack that lets you answer permission requests and questions from orbit, and the app's auto-update toast.

## Files

- **CardNode.tsx** — The whole card frame: status-tinted chrome (border + window bar with name, task, model, BYPASS flag, live status dot) wrapping a `TerminalView`. Decides agent-vs-shell styling and, when `stacked`, overlays a clickable `PosterFace` (agent) or `ShellFace` (shell) that promotes the card on click.
- **TerminalView.tsx** — Owns the xterm `Terminal` instance and its addons; the one place an agent/shell pty is spawned (via `ensureCard`, after subscribing). Never unmounts across face switches.
- **PosterFace.tsx** — A stacked *agent* card's compact face: a "mission poster" leading with the task, with the active todo step, a state reason line, a progress bar, subagent count, and attention-debt minutes pinned low.
- **ShellFace.tsx** — A stacked *shell* card's header strip: just the running command pinned to the top, monochrome (colour on this canvas always means an agent needs you). The live terminal behind it *is* the preview.
- **AskToasts.tsx** — Held `PermissionAsk` toasts rising from the bottom: who's asking, their task, and an Allow/Deny gate answered from orbit.
- **QuestionToasts.tsx** — Held `AskUserQuestion` asks as a chooser stack (via the design-system `AskUserQuestions`): renders the questions/options instead of an Allow/Deny gate, injecting the choice on answer.
- **UpdateToast.tsx** — The app's own auto-update toast (bottom-left, away from the per-agent toasts): download progress, then Restart/Later.
- **meta.ts** — `CardMeta`/`CardData` types, the `STATUS_COLORS` palette, the `isLoud` predicate, and `applyCardEvent` — the pure reducer that folds spine `CardEvent`s into a card's accumulated meta.

## Architecture / data flow

**Face switching.** `CardNode` always renders one `TerminalView`. The `stacked` prop only toggles which face *composites* over it; the xterm instance is created once on mount and lives for the card's lifetime. A stacked agent hides its terminal (`hidden`) and shows the `PosterFace`; a stacked shell keeps its terminal *visible* as the preview and only lays a `ShellFace` strip on top. Stacked terminals are made inert (`interactive={false}`) so a drag can't start an xterm text selection instead of clicking through to promote.

**xterm mounting (TerminalView).** A single `useEffect` keyed on `cardId`/`folder`/`kind` builds the `Terminal`, loads `FitAddon` and (best-effort) `WebglAddon`, opens it into a ref div, fits once, then subscribes to pty data (`onPtyData`) before calling `ensureCard` so no output byte outruns the listener. A `ResizeObserver` debounces (100 ms) refits so a burst of size changes produces one fit; each fit mirrors cols/rows into the pty via `resize`. A `MutationObserver` on `<html>` re-resolves the terminal theme on dark/light flips. A streaming filter (`makeMouseModeFilter`) strips mouse-tracking DECSET/DECRST sequences from the stream so xterm stays in native-selection mode; the wheel handler synthesizes SGR scroll reports straight to tmux, and typing while scrolled snaps back to live (`leaveScrollback`) before delivering the key.

**Asks/questions → toasts.** Held asks arrive as `PermissionAskInfo` / `QuestionAskInfo` (from `@shared/types`). `AskToasts` and `QuestionToasts` are pure presentational stacks rendered together in a shared bottom overlay (owned by the canvas, not here); each takes a `contextFor(cardId)` to label who's asking. Answering from orbit calls back into the canvas; clicking a toast body flies to the card, which on terminal engage releases the ask to the CLI's native dialog.

**meta.ts.** The canvas owns per-card state and feeds it exclusively through `applyCardEvent` (a stateless, testable reducer). It folds status (stamping `statusSince` on change), detail/task/summary/model/permissionMode, subagent deltas, and todo changes (replace/clear/add/update) into `CardMeta`, which is everything the chrome and poster render.

## Conventions & gotchas

- **Allow/Deny then native dialog.** While an ask is held (toast up), the in-terminal dialog is suppressed. The toast's Allow/Deny answers it remotely; but *engaging the terminal* (`onEngage`, fired on mousedown in `TerminalView`) releases the held ask to the CLI's native on-terminal dialog and clears the toast. Two paths to the same decision.
- **WebGL is best-effort.** `WebglAddon` is tried in a try/catch with a DOM-renderer fallback "fine for a handful of cards" — be mindful of the GL context budget if many terminals mount at once. It disposes on context loss.
- **Resize is debounced for the agent's sake**, not just perf: every fit SIGWINCHes the pty and the `claude` TUI reflows, so an undebounced 60 Hz resize thrashes the agent. The mount-time fit stays immediate so the pty spawns correctly sized.
- **Shells are monochrome and silent.** `kind === 'shell'` uses neutral `var(--border)` chrome, follows its pane's cwd/command (via the `useShellTitles` poll passed as `title`), and the spine never speaks for it — its meta stays idle forever.
- **Toast buttons are plain `<button>`, not the design-system `Button`**, so Allow/Deny keep their go/stop status background colors (the shared Button paints bg from a variant and would mask a `bg-*` class).
- Closing a card kills its tmux session (`onClose`) — it's destructive, not just a hide.
