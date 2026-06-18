# lib (renderer)

A grab-bag of shared front-end primitives for the React canvas: React contexts for runtime-switchable icon/shape theming, pure layout/animation/selection helpers, and the canonical `cn()` class merger. No business logic lives here — these are the leaf utilities the rest of the renderer imports.

## Files

- **utils.ts** — pure helpers. `cn(...)` is the shadcn class merger (`clsx` + `tailwind-merge`). `basenameOf(path)` returns the last path segment (the card/canvas display name) or `undefined` for empty/root paths so callers supply their own fallback.
- **icon-context.tsx** — React context. Holds the active `IconLibrary`, exposes `IconProvider` plus `useIcon(name)`, `useIcons()`, `useIconLibrary()`. Hooks fall back to Lucide when no provider is mounted. Binds a global `I` key to cycle libraries (ignored in inputs/contenteditable).
- **icon-map.tsx** — the icon registry (not a context). Imports Lucide, Tabler, Phosphor, and HugeIcons; normalizes each behind an `IconComponent` props shape (`size`/`strokeWidth`/`className`) via per-library adapter factories. Exports `iconMap` (library → name → component), the `IconName`/`IconLibrary` unions, `iconLibraryOrder`, and `iconLibraryLabels`.
- **shape-context.tsx** — React context. Switches corner-radius variant (`pill` | `rounded`). `ShapeProvider` exposes `useShape()` (the resolved `ShapeClasses`) and `useShapeContext()` (shape + setter). Each variant maps to Tailwind radius classes plus numeric `bgRadius`/`mergedRadius` (px) for per-corner animated radii. Binds a global `R` key to cycle; toggles add a `transitioning` class on `<html>` for ~200ms.
- **springs.ts** — pure helper. Framer-motion `spring` presets (`fast`/`moderate`/`slow`), each with its own faster `exit` duration.
- **theme.ts** — pure helper. `cssVar(name)` resolves a CSS custom property to its concrete value; `terminalTheme()` reads the resolved `--terminal-*` tokens into an xterm palette (xterm renders to canvas and can't use `var()` references).
- **font-weight.ts** — pure helper. `fontWeights` maps semantic weights to `font-variation-settings` strings pairing `wght` with an optical-size (`opsz`) axis.
- **ask-selection.ts** — pure selection math for the AskUserQuestions component (no React/DOM). `questionKey`/`optionKey` derive stable keys; `computeSelectedIndices` returns selected row indices (including the Other row when it holds text); `computeSelectedGroups` collapses contiguous runs into groups with stable ids so growing/shrinking selections animate instead of remount.

## Conventions & gotchas

- The two `.tsx` files (icon-context, shape-context) are React contexts; everything else is a side-effect-free helper. `ask-selection.ts` is deliberately pure so it stays trivially testable — the component owns refs/state and passes current values in.
- All four context/registry files carry a `"use client"` directive (legacy convention; this is an Electron renderer, not Next.js).
- Icon adapters paper over cross-library prop drift: Tabler maps `strokeWidth`→`stroke`; Phosphor maps numeric `strokeWidth` to a discrete `weight`; HugeIcons wraps untyped icon defs. Several maps are typed `ComponentType<any>` because Lucide/raw fallbacks (e.g. HugeIcons lacks `play`/`pause`) don't satisfy the strict `IconComponent` props.
- Both contexts register `keydown` listeners on `document` and skip when focus is in an `INPUT`/`TEXTAREA`/contenteditable. Hooks degrade gracefully without a provider (Lucide / `pill` defaults).
- `theme.ts` tokens are intentionally hex (not `var()`) for xterm's canvas; re-call `terminalTheme()` after a dark/light flip to re-read them.
- `springs.ts` durations are tuned for framer-motion `transition` props; prefer these presets over inline timings for consistency.
