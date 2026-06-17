---
description: Cleanup-round review of this branch — anti-patterns, dupes, dead code, separation of concern, DX (multi-agent)
argument-hint: [optional focus area or path]
---

Cleanup round for the current branch. We work in two phases: first we prove
something works, then — now — we clean it up. The feature already works; this
pass is purely about making the code excellent. Do **not** change behavior.

The review fans out across agents: one reviewer per cleanup dimension, each
finding adversarially verified, then synthesized into a single prioritized list.
You drive that with the **Workflow** tool — your only by-hand step is scoping the
diff first. (Calling Workflow is expected here; this command opts you in.)

Optional focus from the user (a path or area to weight more heavily): $ARGUMENTS

## 1. Establish the diff (you do this inline, before the workflow)

The subject of review is the work done on this branch, not the whole repo. Scope
it yourself so the workflow reviews exactly the right files — this is the
work-list the fan-out pipelines over.

- `git fetch` is not needed; work locally.
- Find the base: `git merge-base HEAD main`.
- Get the changed files and the shape of the change:
  `git diff --stat $(git merge-base HEAD main)...HEAD`.
- Build the **changed-file list** (paths relative to repo root). Drop pure
  deletions and lockfiles. A focus may narrow this list to part of the diff, but
  never pull in files outside the branch diff. If `git diff` shows no changes vs
  `main`, there's nothing to review — say so and stop.

## 2. Run the review workflow

Invoke the **Workflow** tool against the saved script and pass the scope as args:

```
Workflow({
  scriptPath: ".claude/workflows/cleanup-round.js",
  args: { base: "<merge-base sha>", changedFiles: ["…"], focus: "$ARGUMENTS" }
})
```

What it does (the cleanup bar lives in that script — edit it there, in one
place, never re-list it here):

1. **Review** — seven reviewers run in parallel, one per dimension, in rough
   priority order: **duplication** (search the repo before calling a helper
   new), **dead code** (search for references before calling it dead),
   **cross-cutting/seams** (trace each value end-to-end across module and
   process boundaries — the findings only visible holding the whole diff at
   once), **anti-patterns**, **separation of concern**, **semantic soundness**,
   **DX**. Each reads the in-scope files in full and returns structured findings.
2. **Verify** — every finding is handed to an independent skeptic that defaults
   to refuting and does its own repo-wide search to confirm dupe/dead-code
   claims. Taste-only, wrong, or already-handled findings are dropped; severity
   is corrected.
3. **Synthesize** — the survivors are merged (same code flagged from two angles
   becomes one entry) and ordered into a single prioritized list.

It returns `{ summary, checked, findings }`. The verify stage is what keeps the
fan-out honest — it will not manufacture findings to look productive.

Scale to the ask: a quick once-over runs as-is; for a deep audit, widen the
finders or add a completeness-critic pass by editing the script. Do not run the
workflow on the whole repo — only the branch diff.

## 3. Report — findings first, before touching anything

Present the workflow's `findings` as a single prioritized list. For each:

- **What & where** — `file_path:line` (clickable), one-line description.
- **Why it matters** — the concrete cost (the bug it invites, the dupe it
  forks, the reader it confuses). Skip anything that's merely taste with no cost.
- **Fix** — the specific change, and whether it's mechanical or needs judgment.
- **Severity** — must-fix / should-fix / optional.

Be honest about confidence. If `summary` says the branch is already clean, say so
plainly — relay the `checked` note so a clean result is credible — rather than
manufacturing findings. A short "nothing material, here's what I checked" is a
valid and valuable outcome. Keep trivially-related findings grouped so the list
stays scannable.

Then **stop and wait for approval.** Do not edit yet.

## 4. Fix on approval

Once the user picks what to act on:

- Apply only the approved findings, inline, yourself — cleanup fixes are usually
  interrelated and coherence-sensitive, so keep them in one hand. Keep each fix
  tightly scoped: no behavior changes, no opportunistic rewrites of untouched
  code. (Only if the approved set is many genuinely independent mechanical fixes
  in disjoint files is a worktree-isolated fix workflow worth it.)
- After editing, run the gate — `npm run typecheck` and `npm run build` — and
  confirm both pass. Report anything that breaks instead of papering over it.
- Summarize what changed, grouped by finding, with the verification result. Do
  not commit or push unless the user asks.
