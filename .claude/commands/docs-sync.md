---
name: docs-sync
description: Analyze uncommitted changes and sync all documentation (CLAUDE.md, types, comments) using parallel subagents
argument-hint: '[scope: all | app | components | staged]'
allowed-tools:
  [Read, Glob, Task, Bash(git status), Bash(git diff*), Bash(git log*), AskUserQuestion]
---

# Documentation Sync Orchestrator

**Scope:** $ARGUMENTS (default: all)

## Auto-loaded Context

### Uncommitted Changes

!`git status --porcelain`

### Recent Commits

!`git log --oneline -5`

---

## Instructions

### Step 1: Validate Changes

If git status shows NO changes:

1. Use AskUserQuestion: "No uncommitted changes. Document recent commits instead?"
   - **Yes** - Ask which commit range
   - **No** - Exit

---

### Step 2: Identify Directories

Parse changed files → extract unique directories where CLAUDE.md should live.

**Scope filtering ($ARGUMENTS):**

- `all` (default): All directories
- `app`: Only `app/*` (screens, layouts, contexts, hooks)
- `components`: Only `components/*`
- `staged`: Only staged files

**Directory mapping:**

```
app/screens/chat.tsx → app/screens/
app/contexts/ThemeContext.tsx → app/contexts/
components/Button.tsx → components/
utils/color-theme.ts → utils/
app/(drawer)/(tabs)/index.tsx → app/(drawer)/(tabs)/
```

Show the user:

```markdown
## Directories to Document

| Directory              | Changed Files |
| ---------------------- | ------------- |
| components             | 3             |
| app/screens            | 2             |
| app/contexts           | 1             |
```

---

### Step 3: Spawn Agents in Parallel

For EACH directory, spawn a `docs-updater` agent.

**CRITICAL:** Use a SINGLE message with multiple Task calls for parallel execution.

```
Task(docs-updater):
Directory: components

Changed files:
- Button.tsx
- Card.tsx
```

```
Task(docs-updater):
Directory: app/screens

Changed files:
- chat.tsx
- settings.tsx
```

---

### Step 4: Report Results

Collect agent responses and summarize:

```markdown
## Documentation Sync Complete

### Results

| Directory     | Action     | Details                       |
| ------------- | ---------- | ----------------------------- |
| components    | Updated    | Added Button variant docs     |
| app/screens   | Created    | New CLAUDE.md                 |
| app/contexts  | Cleaned Up | Removed code examples         |
| utils         | Skipped    | No public API changes         |

### Stats

- Directories processed: X
- Updated: X
- Created: X
- Cleaned up: X
- Skipped: X
```

---

## Notes

- Each `docs-updater` agent is autonomous (analyzes + writes)
- Agents enforce style guidelines - will clean up non-compliant CLAUDE.md files
- This command only orchestrates parallelization
- Agents report their own actions
- Never run the agents in the background (asynchronously).
