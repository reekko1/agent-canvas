# Mastermind Learning Map — Skills & Memory (pre-design reference)

A pure structural/factual map of two systems in the open-source **hermes-agent** (Python) — its self-authored **Skills** subsystem and its **Memory** subsystem — plus a snapshot of **Agent Canvas as it stands today**. Scope is "how it works, completely": on-disk formats, schema fields, char budgets, DB tables, tool signatures, ABC methods, state-machine thresholds, config defaults, and ordered control flow. No design proposals, no matching to our stack, no recommendations — matching role cards and the TS/Electron port are a later phase. All facts are drawn faithfully from the source maps (with `file:line` citations preserved); the few low-confidence/ambiguous points are surfaced inline and in **Open / uncertain**.

---

# Part 1 — Hermes Skills system

## 1.1 Data model & on-disk storage

A skill is a **directory package** rooted at a `SKILL.md` (YAML frontmatter + markdown body) plus optional support dirs. The canonical store is `~/.hermes/skills/` (= `HERMES_HOME/skills`, `SKILLS_DIR`), seeded once from the repo's bundled `skills/` tree by a manifest-based sync. Agent-created, hub-installed, and bundled skills all coexist there (`tools/skills_tool.py:9-67`).

### SKILL.md format
- Optional YAML frontmatter delimited by a leading `---` and a `\n---\n` terminator, then the markdown body. Parsed by `parse_frontmatter` using `CSafeLoader`; on parse failure it falls back to naive `key:value` splitting. No frontmatter ⇒ the whole file is body (`skills_tool.py:73`, `skill_utils.py`).

### Frontmatter fields (all optional unless noted)
| Field | Type / constraints | Notes |
|---|---|---|
| `name` | string, max 64 (`MAX_NAME_LENGTH`); truncated in index | REQUIRED in practice; defaults to dir name if absent |
| `description` | string, max 1024 (`MAX_DESCRIPTION_LENGTH`); truncated with `...` | Authoring HARDLINE caps it at ≤60 chars, one sentence, ends with a period |
| `version` | e.g. `1.0.0` | |
| `author` OR `authors` | string / list | |
| `license` | e.g. MIT, agentskills.io | |
| `platforms` | list: `macos`\|`linux`\|`windows` → `darwin`\|`linux`\|`win32`; absent = all | HARD OS gate |
| `environments` | list: `kanban`\|`docker`\|`s6`; absent = all | SOFT, offer-time only |
| `compatibility` | free string (agentskills.io) | Surfaced in `skill_view` output |
| `prerequisites` | legacy dict `{env_vars:[NAMES], commands:[cmds]}` | `env_vars` normalized into `required_environment_variables`; `commands` ADVISORY only (never block, never reported missing) |
| `required_environment_variables` | list of str OR dict | dict keys `{name\|env_var (req), prompt, help\|provider_url\|url, required_for, optional:bool}`; names must match `^[A-Za-z_][A-Za-z0-9_]*$`; deduped by name; `optional:true` never counts toward `setup_needed` |
| `setup` | dict `{help:str, collect_secrets:[{env_var(req), prompt, provider_url\|url, secret:bool=true}]}` | `collect_secrets` folded into `required_environment_variables` at load (`env_var`→name, `provider_url`→help) |
| `required_credential_files` | list of str or `{path\|name, description}` | Host files mounted into remote sandboxes; missing → `missing_credential_files` + `setup_needed` |
| `metadata.hermes.*` | agentskills.io arbitrary-metadata convention | `tags` (list/CSV), `related_skills`, `category`, `homepage`, `config` (list of `{key, description, default, prompt}` stored under `skills.config.<key>`), and conditional-activation: `fallback_for_toolsets`, `requires_toolsets`, `fallback_for_tools`, `requires_tools`. Top-level `tags:`/`category:` also accepted and mirrored. |

(Field detail: `skills_tool.py:73-79`, `skills_tool.py:204-335`.)

### Body section order (authoring HARDLINE)
`# <Skill> Skill` title → 2-3 sentence intro → `## When to Use` → `## Prerequisites` → `## How to Run` → `## Quick Reference` → `## Procedure` → `## Pitfalls` → `## Verification`. Target ~200 lines complex / ~100 simple (`skills_tool.py:80`, `AGENTS.md:824-931`).

### Directory layout
`<skill>/SKILL.md` (required) plus four `SKILL_SUPPORT_DIRS`:
- `references/` (*.md docs)
- `templates/` (*.md, *.py, *.yaml, *.yml, *.json, *.tex, *.sh — globbed recursively)
- `assets/` (any file, recursive — agentskills.io standard)
- `scripts/` (*.py, *.sh, *.bash, *.js, *.ts, *.rb)

When these four names sit directly inside a `SKILL.md` dir they are progressive-disclosure data, **not** scanned as standalone skills (so an archived `references/old-package/SKILL.md` is ignored) (`skill_utils.py:27-50`, `skills_tool.py:81`).

### Category = directory nesting
`~/.hermes/skills/<category>/<skill>/SKILL.md` gives `category=<category>` (parts[0] when ≥3 path parts); deeper nesting joins with `/`. A category dir may hold a `DESCRIPTION.md` (frontmatter `description` only) used as the category header line in the prompt index — there is **no** `SKILL.md` at the category root (verified: `skills/apple/` has `DESCRIPTION.md`, no `SKILL.md`) (`skills_tool.py:82`).

### Storage roots
- `~/.hermes/skills` (`HERMES_HOME/skills`) — canonical R/W.
- `skills.external_dirs` (config.yaml; `~` and `${VAR}` expanded, relative resolved against `HERMES_HOME`, must exist, dedup, local dir excluded) — read-only; local names win on collision.
- Plugin in-memory registry `namespace:skill`.
- Repo `skills/` (bundled source) and `optional-skills/` (hub source) are **not** runtime roots.

### Sidecars / indexes under `~/.hermes/skills/`
- `.bundled_manifest` — sync MD5s (`name:hash` per line).
- `.usage.json` — per-skill counters (file-locked).
- `.hub/lock.json` — hub install lock + provenance `{installed:{name:{install_path,...}}}`.
- `.no-bundled-skills` — sync opt-out marker (`NO_BUNDLED_SKILLS_MARKER`).
- `.curator_suppressed` — pruned-built-in durability list.
- `.curator_state` — curator scheduling state.
- `.archive/` — flat archive layout.
- Prompt snapshot at `HERMES_HOME/.skills_prompt_snapshot.json`.
- (Repo `skills/index-cache/` holds external-hub index JSON: anthropics/openai/lobehub/claude_marketplace.)

### Module constants (`skills_tool.py:90-98`)
`SKILLS_DIR = HERMES_HOME/skills`, `MAX_NAME_LENGTH=64`, `MAX_DESCRIPTION_LENGTH=1024`, `_PLATFORM_MAP`, `_INJECTION_PATTERNS`, `_REMOTE_ENV_BACKENDS={docker,singularity,modal,ssh,daytona}`.

## 1.2 Discovery, loading & progressive disclosure

Three-tier progressive disclosure:
1. **Tier 1** — a compact name+description index injected into the system prompt by `build_skills_system_prompt` (also surfaced by `skills_list`).
2. **Tier 2** — full SKILL.md body via `skill_view(name)`.
3. **Tier 3** — linked support files via `skill_view(name, file_path=...)`.

### Install / update (`skills_sync.py:3-50`)
`skills_sync` copies repo `skills/` → `~/.hermes/skills/` using `.bundled_manifest` (per-skill origin MD5). On update: unmodified user copies refreshed if bundled changed; **user-modified copies skipped** (origin-MD5 mismatch); removed-from-bundle entries cleaned. No-op if `.no-bundled-skills` present. Category `DESCRIPTION.md` also copied.

### System-prompt injection (Tier 1) — `build_skills_system_prompt` (`prompt_builder.py:1244-1511`)
Builds the `## Skills (mandatory)` block. Two-layer cache:
- **Layer 1** in-process LRU keyed by `(skills_dir, external_dirs, tools, toolsets, platform_hint, disabled-set, compact_categories)`.
- **Layer 2** disk snapshot `.skills_prompt_snapshot.json` validated against an mtime/size manifest of all `SKILL.md` + `DESCRIPTION.md`.

Cold path: full scan via `iter_skill_index_files`, parse each, apply gates, write snapshot. External dirs scanned every time (no snapshot); local names win on collision.

**Per-skill index gate order:** `skill_matches_platform` (hard) → `skill_matches_environment` (offer-time soft) → name in disabled? → `_skill_should_show(conditions, tools, toolsets)` (the `requires_/fallback_for_` gates). Passing skills grouped by category, rendered as `- name: desc`. `compact_categories` demotes a category to a names-only line (`<cat> [names only]: a, b`) — **never hides names**.

### `skills_list(category?, task_id?)` (`skills_tool.py:602-679,687-752`)
mkdir `SKILLS_DIR` if missing; `_find_all_skills` scans local then external dirs (local precedence via `seen_names`), reading **only first 4000 bytes** of each `SKILL.md`, applying platform+environment+disabled gates, deriving description from frontmatter or first non-heading body line; sort by `(category,name)`. Returns JSON `{success, skills:[{name,description,category}], categories, count, hint}`.

### `skill_view(name,...)` dispatch (`skills_tool.py:114-138,758-859,903-1104,1192-1291,1296-1507`)
1. `_skill_lookup_path_error` rejects absolute / `..` / Windows-drive names **before** the `:` split.
2. If name has `:` → plugin path: validate namespace, `discover_plugins()`, `find_plugin_skill`; serve via `_serve_plugin_skill` (disabled-plugin check, platform check, injection scan log-only, sibling-bundle banner, preprocess). If plugin missing, fall through and remember categorized `namespace/bare` form for local lookup.
3. **Local resolution** collects ALL candidates across local+external dirs via 4 strategies: (1) direct `<dir>/<name>/SKILL.md` or `<name>.md`; (1b) categorized `namespace/bare`; (2) recursive by parent-dir-name match AND by frontmatter `name:` match; (3) legacy flat `<name>.md` anywhere (excluding support paths). **>1 distinct candidate ⇒ refuse** with "Ambiguous skill name" + matches list (no silent shadowing). 0 ⇒ not-found with first 20 available names.
4. On a resolved local skill: read; warn if outside trusted dirs OR injection patterns present (log-only, still serves); platform check (⇒ unsupported); disabled check (⇒ error). If `file_path` given: traversal guard + `validate_within_dir`, return file content or list `available_files` grouped by type on miss.
5. **Main-body load:** enumerate references/templates/assets/scripts; read tags/related (metadata.hermes first, top-level fallback); compute `required_environment_variables` (required_env_vars + legacy env_vars + setup.collect_secrets); detect missing (not in `HERMES_HOME/.env` or `os.environ`); `_capture_required_environment_variables` may invoke a registered secret-capture callback (interactive surfaces / `HERMES_INTERACTIVE` only; gateway surfaces short-circuit to `gateway_setup_hint`); `register_env_passthrough` for satisfied vars; `register_credential_files` for required creds; preprocess content; assemble `readiness_status`; build `setup_note` (remote-backend suffix for docker/modal/ssh/etc.).

### Load-time preprocessing (`skill_preprocessing.py:10-141`)
`preprocess_skill_content` substitutes `${HERMES_SKILL_DIR}` and `${HERMES_SESSION_ID}` (default ON via `skills.template_vars`), and expands ``!`cmd` `` inline-shell snippets (default OFF via `skills.inline_shell`; timeout `skills.inline_shell_timeout=10s`; output capped 4000 chars). Unresolved tokens left in place.

### Environment / explicit-load invariant
`skill_matches_environment` is enforced **only** in index/offer surfaces (`skills_list`, prompt index). `skill_view` and `--skills` preloading **bypass** it — explicit load = explicit consent (e.g. kanban dispatcher force-loading `--skills kanban-worker`).

### Plugin skills (`hermes_cli/plugins.py:1040-1102,1772-1788`)
`PluginContext.register_skill(name, path, description)` → qualified `<plugin_name>:<name>` stored in `PluginManager._plugin_skills` (dict qualified → `{path, plugin, bare_name, description}`). Namespace derived from manifest `name`; name must not contain `:` and must match `[a-zA-Z0-9_-]+`. NOT in the flat tree, NOT in the system-prompt index — explicit-load-only.

## 1.3 Read-side tools

| Tool / fn | Signature | Returns |
|---|---|---|
| `skills_list` | `skills_list(category: str\|None=None, task_id: str\|None=None)` | JSON `{success, skills:[{name,description,category}], categories, count, hint}`. Toolset=`skills`, emoji 📚. Schema params `{category?:string}` |
| `skill_view` | `skill_view(name: str, file_path: str\|None=None, task_id: str\|None=None, preprocess: bool=True)` | Full SKILL.md JSON (below). Schema params `{name:string (REQUIRED; bare or 'plugin:skill'), file_path?:string}`. Registered handler is `_skill_view_with_bump` |
| `check_skills_requirements` | `()` | bool (always True; dir created on first use) |
| `skill_matches_platform` / `skill_matches_environment` | `(frontmatter: dict)` | bool (re-exported from `skill_utils`) |
| `parse_frontmatter` | `(content: str)` | `(dict, str)` |
| `iter_skill_index_files` | `(skills_dir: Path, filename: str)` | sorted Iterator[Path], prunes EXCLUDED + support dirs when a SKILL.md is present |
| `get_external_skills_dirs` / `get_all_skills_dirs` | `()` | List[Path] (local first) |
| `get_disabled_skill_names` | `(platform=None)` | Set[str] |
| `extract_skill_conditions` | `(fm)` | `{fallback_for_toolsets, requires_toolsets, fallback_for_tools, requires_tools}` |
| `extract_skill_config_vars` | `(fm)` | `[{key, description, default?, prompt}]` |
| `build_skills_system_prompt` | `(available_tools, available_toolsets, compact_categories)` | str |
| `preprocess_skill_content` | `(content, skill_dir, session_id=None, skills_cfg=None)` | str |
| `register_credential_files` | `(entries, container_base='/root/.hermes')` | List[str] missing |
| `register_env_passthrough` | `(var_names)` | None |
| `bump_view` / `bump_use` | `(name)` | None |
| `set_secret_capture_callback` | `(cb)` | cb(env_name, prompt, metadata)→`{success, stored_as, validated, skipped}` |
| `OptionalSkillSource` (hub) | identifier `official/<category>/<skill>` | installs into `~/.hermes/skills/` |

### `skill_view` success payload
`{success, name, description, tags, related_skills, content (preprocessed), path (rel to SKILLS_DIR), skill_dir, linked_files:{references,templates,assets,scripts} (or null), usage_hint, required_environment_variables:[{name,prompt,help?,required_for?,optional?}], required_commands:[] (always empty), missing_required_environment_variables:[names], missing_credential_files:[paths], missing_required_commands:[] (always empty), setup_needed:bool, setup_skipped:bool, readiness_status: available|setup_needed|unsupported, +optional setup_help, gateway_setup_hint, setup_note, compatibility, metadata}` (`skills_tool.py:85`).

### `skill_view` linked-file payload
`{success,name,file,content,file_type}` or binary `{success,name,file,content:'[Binary file: ...]',is_binary:true}` (`skills_tool.py:86`).

### Telemetry (`skill_usage.py:86,155-169,463-465,587`)
`.usage.json` per-skill `{use_count, view_count, patch_count, last_used_at, last_viewed_at, last_patched_at}`. The registry wraps `skill_view` as `_skill_view_with_bump` — on success it bumps **both** `view_count` and `use_count` (a view counts as use, because the Curator's stale timer keys off `last_used_at`). File-locked read-modify-write, best-effort.

## 1.4 Authoring & write path

Two write paths into `~/.hermes/skills/`: (1) the foreground `skill_manage` tool the model calls during a turn (user-directed), and (2) an autonomous **self-improvement review** fork spawned after a turn finishes.

### `skill_manage` tool (`skill_manager_tool.py:1002-1092`)
Signature: `skill_manage(action, name, content=None, category=None, file_path=None, file_content=None, old_string=None, new_string=None, replace_all=False, absorbed_into=None) -> JSON str`. Runs the approval gate first, dispatches by action, then on success clears the skills system-prompt cache and updates curator telemetry.

| action | Required | Handler / behavior |
|---|---|---|
| `create` | content (full SKILL.md); optional category | `_create_skill` (`559-624`): validate name (`VALID_NAME_RE ^[a-z0-9][a-z0-9._-]*$`, max 64), single-segment category, frontmatter (name+description, closed `---`, non-empty body), size ≤100_000. Refuse on name collision across all roots. Atomic write → security scan (rmtree rollback on block) |
| `edit` | content (full SKILL.md rewrite) | `_edit_skill` (`627-668`): validate frontmatter+size; requires existing skill (else `_skill_not_found_error` with cross-profile hint); backup → atomic write → scan w/ rollback |
| `patch` | old_string + new_string (`''` deletes); optional file_path (default SKILL.md), replace_all (default false) | `_patch_skill` (`671-768`): `fuzzy_find_and_replace` (whitespace/indent/escape tolerant, block-anchor); unique match unless replace_all; re-validate size; if patching SKILL.md re-validate frontmatter intact. Atomic write + scan w/ rollback. Returns `_change.old/_change.new` (200-char previews) |
| `delete` | optional absorbed_into | `_delete_skill` (`771-831`): `absorbed_into` None=undeclared (warns), `''`=pruned no-target, `'<name>'`=consolidated (target must exist, ≠ self). **Pin guard refuses deletion** (patch/edit still allowed). `_validate_delete_target` (no symlink/junction, must be strictly inside a known root, never the root itself — port of Kilo Code #11240). `shutil.rmtree`, clean empty category dir |
| `write_file` | file_path (references/\|templates/\|scripts/\|assets/) + file_content | `_write_file` (`834-926`): 1 MiB/file + 100k char caps. Atomic write + scan w/ rollback |
| `remove_file` | file_path | `_remove_file` (`834-926`): lists available files on miss; cleans empty subdirs |

`SKILL_MANAGE_SCHEMA` actions enum: `create | patch | edit | delete | write_file | remove_file`; required `[action, name]`. `ALLOWED_SUBDIRS = {references, templates, scripts, assets}`.

### Size budgets / regex (`skill_manager_tool.py:238-245`)
- `MAX_SKILL_CONTENT_CHARS = 100_000` (~36k tokens @2.75 chars/tok) — SKILL.md and any text write.
- `MAX_SKILL_FILE_BYTES = 1_048_576` (1 MiB) per supporting file.
- `MAX_NAME_LENGTH=64`, `MAX_DESCRIPTION_LENGTH=1024`.
- `VALID_NAME_RE = ^[a-z0-9][a-z0-9._-]*$`; category validated the same way, single dir segment.

### Approval gate (`skill_manager_tool.py:933-999`)
`_apply_skill_write_gate` / `apply_skill_pending`: skills are too large to review inline, so they **ALWAYS stage** when the gate is on, regardless of origin. Records full kwargs payload + a `skill_gist` for replay. `_skill_gate_bypass` ContextVar set during `apply_skill_pending` replay so re-gating doesn't recurse. Fails open if `write_approval` import fails.

### Provenance (`skill_provenance.py:37-78`)
`_write_origin` ContextVar default `'foreground'`. `set_current_write_origin` / `reset_current_write_origin` / `get_current_write_origin`; `is_background_review()` returns origin==`'background_review'`. Bound per-turn in `build_turn_context` from `agent._memory_write_origin` (foreground agents default `'assistant_tool'`; review fork sets `'background_review'`). Constant `BACKGROUND_REVIEW='background_review'`.

**Provenance asymmetry (the whole point):** foreground `skill_manage(create)` is user-directed and must NEVER be marked agent-created (so the curator can't auto-consolidate/prune/archive user skills). Only the background-review fork's creates get `created_by='agent'`. The check is `is_background_review()` inside `skill_manage`'s success block. Origin values `'foreground'` and `'assistant_tool'` both correctly read as not-agent-created.

### The creation trigger
Per-turn counter `_iters_since_skill`:
1. **init** (`agent_init.py:1133,1224-1229`): `_iters_since_skill=0`; `_skill_nudge_interval=10` then overridden by `int(config skills.creation_nudge_interval, default 10)`; `_memory_write_origin='assistant_tool'`.
2. **turn start** (`turn_context.py:110,183`): `set_current_write_origin(agent._memory_write_origin)`; **NOTE: counter is NOT reset at turn start** — persists across turns within a live AIAgent (cadence spans the whole session). Does NOT survive process restart/resume (fresh AIAgent re-inits to 0; never persisted to the session DB).
3. **per tool-iteration** (`conversation_loop.py:644-648`): `if _skill_nudge_interval>0 and 'skill_manage' in valid_tool_names: _iters_since_skill += 1` (no increment if skills toolset absent).
4. **reset on use** (`tool_executor.py:269-273,863-867`): when `function_name=='skill_manage'`, `_iters_since_skill=0` (in both concurrent & sequential dispatch; post-block site gated on `not _execution_blocked`).
5. **trigger compute** (`turn_finalizer.py:375-401`): `_should_review_skills = (_skill_nudge_interval>0 AND _iters_since_skill>=_skill_nudge_interval AND 'skill_manage' in valid_tool_names)`; resets `_iters_since_skill=0` on fire.
6. **spawn AND-gate:** iff `final_response AND not interrupted AND (_should_review_memory OR _should_review_skills)` → `agent._spawn_background_review(...)` (best-effort, swallows exceptions).
7. **codex path** (`codex_runtime.py:265-313`): bypasses the chat loop, so explicitly `_iters_since_skill += turn.tool_iterations`, then same threshold check + reset + spawn.

### The background-review fork (`background_review.py:446-725`)
`_spawn_background_review` (`run_agent.py:1439-1461`) → `spawn_background_review_thread` picks the prompt (skill / memory / combined) → `threading.Thread(target, daemon=True, name='bg-review').start()`.

`_run_review_in_thread`: forks `AIAgent(max_iterations=16, quiet_mode, skip_memory=True)` inheriting the parent runtime (provider/model/base_url/api_key/api_mode; codex_app_server downgraded to codex_responses); sets origin/context=`background_review`; **pins** parent's `_cached_system_prompt` + session_start/session_id; disables compression/MCP refresh/nudges; applies a **dispatch whitelist** (not tools[] trimming) = names from `get_tool_definitions(enabled_toolsets=['memory','skills'])` with a deny message; installs a **non-interactive auto-deny** approval callback (`_bg_review_auto_deny` → "deny"); redirects stdout/stderr to devnull; runs `run_conversation(prompt + 'You can only call memory and skill management tools…', conversation_history=snapshot)`; then `summarize_background_review_actions` skipping tool msgs already in the snapshot (#14944). Surfaces via `agent._safe_print` + `background_review_callback`. In `finally`: re-redirect for teardown; clear the bg-review thread's approval callback so a recycled tid doesn't inherit it.

Cache-parity rationale: the fork must inherit `_cached_system_prompt` verbatim AND keep `tools[]` byte-identical (same enabled/disabled toolsets so the skills_prompt matches) AND skip the between-turns MCP refresh AND not compress — any divergence misses the provider prefix cache (issue #25322 / PR #17276, ~26% cost cut on Sonnet 4.5). `enabled_toolsets` is inherited from the parent, NOT narrowed to memory+skills — narrowing happens only at the runtime dispatch whitelist.

### `_SKILL_REVIEW_PROMPT` (`background_review.py:45-148`)
Mandates a be-active default; lists learning signals; enforces a strict preference order: **patch the currently-loaded skill > patch an existing umbrella > add a reference/template/script support file > create a new class-level umbrella**; class-level naming rules; and a **DO-NOT-CAPTURE taxonomy** so the agent doesn't harden brittle self-constraints:
- (1) environment-dependent failures (missing binaries, fresh-install errors, post-migration path mismatches, "command not found", unconfigured creds, uninstalled packages);
- (2) negative claims about tools/features ("browser tools do not work", "X tool is broken") — these harden into self-cited refusals for months after the real bug is fixed;
- (3) session-specific transient errors that resolved (capture the retry pattern, not the failure);
- (4) one-off task narratives.
When a tool failed due to setup state, capture the FIX under a setup/troubleshooting skill, never "this tool does not work". Bundled (`hermes-agent`) and hub-installed skills are PROTECTED — never edited; if only protected skills need updating, the fork says "Nothing to save."

### `skill_usage` write-path telemetry (`skill_usage.py:611-665,415-453`)
`mark_agent_created` sets `created_by='agent'` (only fires on background-review origin). `bump_patch` increments `patch_count`+`last_patched_at` for ANY skill. `forget` drops the record on delete. `is_curation_eligible`: agent-created always; bundled only if `curator.prune_builtins`; hub-installed never; protected built-ins never. `get_record('pinned')` backs the delete pin-guard.

### `_change` payload
`create`/`edit` → `{description: first 120 chars}`; `patch` → `{old: 200-char preview, new: 200-char preview}` — consumed by `summarize_background_review_actions` verbose mode.

## 1.5 Curator maintenance loop

The Curator is the background skill-maintenance subsystem — **inactivity-triggered (no cron daemon).** A session-start/idle hook calls `maybe_run_curator()`. Nothing is ever deleted; the max destructive action is **archive** (move to `.archive/`), which is restorable.

### Entry & gating
- `maybe_run_curator(*, idle_for_seconds=None, on_summary=None)` (`curator.py:1898-1917`): returns run result or None; never raises. Calls `should_run_now()`; when `idle_for_seconds` is provided, enforces `idle_for_seconds >= get_min_idle_hours()*3600` before `run_curator_review`.
- `should_run_now(now=None)` (`curator.py:219-269`): False if `not is_enabled()` or `is_paused()`. **Deferred first run:** if `last_run_at` is None it SEEDS `last_run_at='now'` with a "deferred first run" summary and returns False (never runs on the first tick after install/update). Otherwise `(now - last_run_at) >= interval_hours` (naive last treated as UTC). The min-idle check is NOT here.

### Phase 1 — pure state machine `apply_automatic_transitions(now=None)` (`curator.py:276-331`)
ALWAYS runs (live). Computes `stale_cutoff = now-stale_after_days`, `archive_cutoff = now-archive_after_days`. Iterates `skill_usage.agent_created_report()`. Per skill: skip pinned; seed+skip any row with `_persisted=False` via `seed_record_if_missing`; `anchor = last_activity_at OR created_at OR now`. Rules in order:
- `anchor <= archive_cutoff` & `state != archived` → `archive_skill()`
- elif `anchor <= stale_cutoff` & `state == active` → `set_state(stale)`
- elif `anchor > stale_cutoff` & `state == stale` → `set_state(active)` (reactivation)

Returns `{marked_stale, archived, reactivated, checked, seeded}`. Timestamp that drives aging is **derived activity** (`latest_activity_at` = newest of last_used/viewed/patched_at, **created_at EXCLUDED**); created_at is only a fallback anchor for never-active skills.

### Phase 2 — optional LLM consolidation (OFF by default)
`run_curator_review(on_summary=None, synchronous=False, dry_run=False, consolidate=None)` (`curator.py:1428-1689`):
- Live run: take pre-run snapshot (best-effort), run `apply_automatic_transitions`, **persist `last_run_at`/`run_count` BEFORE the LLM pass** (so a mid-review crash doesn't re-trigger).
- `consolidate=None` reads `get_consolidate()` (off by default). When off: records "llm: skipped (consolidation off)", writes report, returns — no fork, no aux cost.
- When on with candidates: build prompt (`CURATOR_REVIEW_PROMPT` + `builtins_note` if `prune_builtins`) and call `_run_llm_review`.
- `dry_run` SKIPS transitions AND snapshot (only counts candidates), prepends `CURATOR_DRY_RUN_BANNER`, does NOT bump `last_run_at`/`run_count`, still writes REPORT.md.

`_run_llm_review` (`curator.py:1757-1891`): forks `AIAgent(max_iterations=9999, quiet_mode=True, platform='curator', skip_context_files=True, skip_memory=True)` with `_memory_nudge_interval`/`_skill_nudge_interval=0`; stdout/stderr → /dev/null. Returns `{final, summary(240-char cap), model, provider, tool_calls(args trunc 400 chars), error}`. Never raises. `max_iterations=9999` because an umbrella sweep is typically 50-100 API calls.

`_resolve_review_runtime` (`curator.py:1692-1755`) precedence: (1) `auxiliary.curator.{provider,model}` when provider≠auto and model set; (2) legacy `curator.auxiliary.{provider,model}` (logs deprecation); (3) main `model.{provider, default/model}`. Returns explicit api_key/base_url overrides.

### `CURATOR_REVIEW_PROMPT` (`curator.py:365-504`)
Thesis: the library should be **class-level umbrellas** with references/templates/scripts subfiles, not one-session-one-skill micro-entries. Hard rules: don't touch bundled/hub; never delete (archive max); skip `pinned=yes`; skip protected built-ins (`plan`); don't use `use_count` to skip; don't reject on "distinct trigger". Workflow: find prefix clusters → build umbrellas via 3 paths (merge-into-existing / create-new / demote-to-references|templates|scripts) → check package integrity (re-home support files) → iterate. Requires `skill_manage(delete)` to pass `absorbed_into`. Mandates a ` ```yaml ` block with `consolidations`/`prunings`. `CURATOR_DRY_RUN_BANNER` (`curator.py:338-362`) forbids every mutating op; output IS the deliverable.

### Classification of removed skills (3-signal reconciler, strict authority order)
- **Signal 1 (authoritative)** `_extract_absorbed_into_declarations` (`curator.py:754-805`): model-declared `absorbed_into` at the delete call. `into != ''` ⇒ consolidated; `into == ''` ⇒ explicit prune; missing key ⇒ not declared (falls through).
- **Signal 2** `_parse_structured_summary` (`curator.py:673-751`): the model's ` ```yaml ` `consolidations`/`prunings` block; malformed/missing → empty (falls back).
- **Signal 3 (heuristic)** `_classify_removed_skills` (`curator.py:551-670`): a removed skill is consolidated when some OTHER surviving/added skill's write_file/patch/create references the removed name in `file_path` (path-component match) or content/`_raw` (word-boundary regex); else pruned.
- `_reconcile_classification` (`curator.py:808-936`): first-match — (1) declared absorbed_into beats all (target-present ⇒ consolidated; `''` ⇒ pruned; present-but-missing ⇒ fall through); (2) model YAML consolidation if target exists; (3) model-named-missing-umbrella ⇒ heuristic else prune (records `model_claimed_into`); (4) heuristic-only consolidation; (5) model pruning / no-evidence fallback. Every removed skill lands in exactly one bucket.

### Cron rewrite (mandatory after consolidation)
`cron.jobs.rewrite_skill_refs(consolidated: map, pruned: names)` (`cron/jobs.py:1262-1302`) → `{rewrites, jobs_updated, jobs_scanned}`. Best-effort/wrapped. A job listing a consolidated/pruned skill would otherwise silently load nothing at run time.

### Reporting (`curator.py:1029-1401`)
`_write_run_report`/`_render_report_markdown`: creates `logs/curator/{YYYYMMDD-HHMMSS}/` (disambiguates same-second with `-N`). Diffs before/after names, computes transitions, runs the reconciler, then calls `rewrite_skill_refs`. Writes `run.json` (full fidelity), `REPORT.md` (human, with Consolidated/Pruned/Added/Transitions/Cron + Recovery footer), and `cron_rewrites.json` (only when `jobs_updated>0`). `_build_rename_summary` (`curator.py:939-1026`) appends a user-visible "archived N skill(s)" rename map (capped 10) + "full report: hermes curator status" + a pin hint when there are consolidations.

### Backups (`curator_backup.py`)
- `snapshot_skills(reason='manual', *, protect_ids=None)` (`211-285`): pre-run `skills.tar.gz` (gz level 6) + `manifest.json` + cron `jobs.json` copy. UTC-id `2026-05-01T13-05-42Z` (`-NN` on same-second). Tarball **INCLUDES** SKILL.md + dirs, `.usage.json`, `.archive/`, `.curator_state`, `.bundled_manifest`, `.curator_suppressed`; **EXCLUDES** `.curator_backups` (recursion) and `.hub` (hub-managed). Returns dest or None — never aborts the curator pass.
- `_prune_old(keep=get_keep(), protect)` (`288-328`): keep newest N (`DEFAULT_KEEP=5`, clamp min 1); cleans stale `.rollback-staging-*` dirs.
- `rollback(backup_id=None)` (`539-683`): resolve target → **mandatory pre-rollback safety snapshot first** (protect_ids={target}; bail if it fails) → stage current entries (except `.curator_backups`/`.hub`) into `.rollback-staging-<ts>` → extract tarball with path-traversal guard (reject leading `/` or `..`; `filter='data'` on 3.12+) → `_restore_cron_skill_links(target)`. Returns `(ok, msg, path)`.
- `_restore_cron_skill_links` (`396-535`): SURGICAL — only `skills`/`skill` fields on jobs matched by id, under the scheduler's lock; leaves schedule/next_run_at/enabled/prompt alone; jobs deleted since snapshot skipped; new jobs untouched. Never raises.

### Archive / suppression (`skill_usage.py`)
- States `STATE_ACTIVE/STATE_STALE/STATE_ARCHIVED`; `PROTECTED_BUILTIN_SKILLS={'plan'}`.
- `archive_skill` (`672-799`) refuses non-eligible; moves dir to `.archive/<name>` (14-digit UTC timestamp suffix on collision); adds suppression name if bundled; `set_state(archived)`. `.archive/` is FLAT (category nesting flattened).
- `restore_skill` refuses to shadow hub or (prune-off) bundled; finds candidate in `.archive` (exact, then `<name>-<14-digit-ts>`); moves to flat top-level; removes suppression; `set_state(active)`. The 14-digit-suffix requirement keeps "git" from pulling an unrelated "git-helpers".
- `.curator_suppressed` (`263-327`): one pruned-built-in name per line (`#` comments allowed); makes pruning a built-in durable across `hermes update` re-seeds. `read_suppressed_names` is what the re-seeder consults.
- `seed_record_if_missing` (`533-552`): anchors a newly-eligible skill's inactivity clock to "now" (no-op if record exists or not eligible). Prevents a mass-prune when `prune_builtins` flips on.
- `agent_created_report` (`823-846`): per-skill rows with `_persisted`, `last_activity_at`, `activity_count` — drives the state machine.

### Data model (curator)
- `.usage.json` record fields: `created_by (null|'agent')`, `use_count`, `view_count`, `patch_count`, `last_used_at`, `last_viewed_at`, `last_patched_at`, `created_at`, `state ('active'|'stale'|'archived')`, `pinned (bool)`, `archived_at`. Atomic tempfile+os.replace under `.usage.json.lock`.
- `.curator_state`: `{last_run_at, last_run_duration_seconds, last_run_summary, last_run_summary_shown_at, last_report_path, paused, run_count}` (atomic_json_write, indent=2, sort_keys; keeps unknown keys only if `_`-prefixed).
- Required LLM YAML block under `## Structured summary (required)`: `consolidations:[{from,into,reason}]`, `prunings:[{name,reason}]` — empty lists allowed, block must not be omitted.
- `run.json`: full machine-readable (`started_at, duration_seconds, model, provider, auto_transitions, counts{before,after,delta,archived/added/consolidated/pruned_this_run,state_transitions,cron_jobs_rewritten,tool_calls_total}, tool_call_counts, archived[], consolidated[], pruned[], pruned_names[], added[], state_transitions[], cron_rewrites, llm_final/summary/error, tool_calls[]`).

### Curator interfaces (selected)
`maybe_run_curator(...)`, `should_run_now(now=None)`, `apply_automatic_transitions(now=None)`, `run_curator_review(...)`, `snapshot_skills(...)`, `rollback(backup_id=None)`, `archive_skill(name)`, `restore_skill(name)`, `set_state(name, state)`, `set_pinned(name, bool)`, `is_curation_eligible(name)`, `provenance(name)→'hub'|'bundled'|'agent'`, `rewrite_skill_refs(consolidated, pruned)`. CLI: `hermes curator {status,run[--dry-run][--consolidate],pause,resume,pin,unpin,archive,restore,prune,backup,rollback[--list]}`.

## 1.6 Skills — config knobs (table) & gotchas

### Config knobs
| Knob | Default | Meaning |
|---|---|---|
| `skills.external_dirs` | `[]` | Extra read-only roots scanned after `~/.hermes/skills`; local dir wins on collision |
| `skills.disabled` | `[]` | Global names hidden from index and rejected by `skill_view` (frontmatter name OR dir name) |
| `skills.platform_disabled.<platform>` | `{}` | Per-platform additional disabled list; unioned with global |
| `skills.config.<key>` | skill-declared default | Storage for `metadata.hermes.config` vars; injected into content at load |
| `skills.template_vars` | `true` | `${HERMES_SKILL_DIR}`/`${HERMES_SESSION_ID}` substitution at load |
| `skills.inline_shell` | `false` | Execute inline ``!`cmd` `` snippets at load |
| `skills.inline_shell_timeout` | `10` (s) | Per-snippet timeout; output also capped 4000 chars |
| `skills.guard_agent_created` | `false` | Safety scan on agent-created writes (off because the agent can already run code via terminal) |
| `skills.creation_nudge_interval` | `10` | Tool-iteration threshold for the skill-review fork; 0 disables |
| `MAX_NAME_LENGTH` | `64` | Name truncation cap |
| `MAX_DESCRIPTION_LENGTH` | `1024` | Description cap (authoring HARDLINE further limits to ≤60) |
| `MAX_SKILL_CONTENT_CHARS` | `100000` | Hard char cap on SKILL.md / any text write (constant) |
| `MAX_SKILL_FILE_BYTES` | `1048576` | 1 MiB byte cap per supporting file (constant) |
| `curator.enabled` | `true` | Master on/off |
| `curator.interval_hours` | `168` (7 days) | Min gap between runs |
| `curator.min_idle_hours` | `2` | Required idle (enforced only when `idle_for_seconds` passed) |
| `curator.stale_after_days` | `30` | active → stale inactivity |
| `curator.archive_after_days` | `90` | → archived inactivity |
| `curator.prune_builtins` | `true` (verified: `curator.py:187` and `skill_usage.py:257` both `get("prune_builtins", True)`) | Make bundled built-ins curation candidates (fresh window via seed-on-first-sight); adds builtins_note; suppression entry on archive. Hub never affected |
| `curator.consolidate` | `false` (`DEFAULT_CONSOLIDATE`) | Opt-in LLM umbrella pass |
| `curator.backup.enabled` | `true` | Take pre-run tar.gz snapshots |
| `curator.backup.keep` | `5` (`DEFAULT_KEEP`) | Newest snapshots retained (clamp min 1) |
| `auxiliary.curator.{provider,model,...}` | provider `auto`/empty ⇒ main chat model | Aux slot for the review fork; legacy fallback `curator.auxiliary.*` |
| review fork `max_iterations` | `16` (background-review) / `9999` (curator LLM) | Iteration caps |
| review fork nudge intervals | `0` | Disable recursive self-review |
| `agent.memory_notifications` | `on` | Summary verbosity: off / on (generic) / verbose (previews) |
| `HERMES_HOME` | `~/.hermes` (POSIX) / `%LOCALAPPDATA%\hermes` (Win) | Profile root; skills at `HERMES_HOME/skills` |
| `.no-bundled-skills` | absent | When present, `skills_sync` is a no-op |
| `HERMES_INTERACTIVE` | unset | Marks interactive surfaces so secret-capture prompting runs |
| `HERMES_PLATFORM`/`HERMES_SESSION_PLATFORM` | unset | Resolve active platform for per-platform disabled lists |

### Gotchas
- **No offset/limit pagination** on instructional tools (`skills_list`/`skill_view`) — deliberate (`AGENTS.md:111-113`): models read page 1 and skip the rest, so content must load whole.
- The skill name is joined onto every search root, so `_skill_lookup_path_error` rejects absolute/`..`/Windows-drive names **before** the `:` namespace split.
- **Ambiguous bare names are a refusal, not a guess** (>1 distinct SKILL.md across roots ⇒ `success:false` + matches list). Silent shadowing is treated as a bug class.
- `commands` prerequisites are ADVISORY ONLY (`required_commands`/`missing_required_commands` hardcoded empty); only env vars and credential files gate `setup_needed`.
- `platforms:` is a HARD gate (unsupported ⇒ refuse on `skill_view`); `environments:` is a SOFT offer-time gate enforced only in `skills_list`/prompt index — `skill_view` and `--skills` bypass it. Unknown environment tags fail open.
- Support dirs directly inside a SKILL.md dir are not scanned as standalone skills even if they contain a nested SKILL.md.
- Plugin skills are explicit-load-only — never in the flat tree, never in the prompt index.
- Termux/Android: linux-tagged skills are compatible regardless of `linux`/`android`.
- Injection-pattern detection and outside-trusted-dir detection only LOG — the skill is still served.
- `metadata.hermes.*` takes precedence over top-level `tags:`/`category:` (both accepted). Description falls back to first non-heading body line.
- **Setup-needed never hides a skill** — `readiness_status` surfaces it but content is still returned (except hard platform-unsupported and disabled, which are `success:false`).
- A successful `skill_view` bumps **both** view_count and use_count.
- The skill counter survives across turns within a live AIAgent but NOT across process restart/resume (in-memory, never persisted to the session DB).
- Three AND-conditions gate the spawn: `'skill_manage' in valid_tool_names`, `final_response` truthy, `not interrupted`. Plus the threshold. Best-effort.
- **Pin protects against DELETION ONLY** (curator auto-archive + `skill_manage delete`) — patch/edit/write_file/remove_file still go through.
- **NEVER deletes** — archive is the maximum destructive action and is restorable.
- **Deferred first run** — the very first `should_run_now()` seeds `last_run_at` and returns False.
- Consolidation OFF by default ⇒ a run does ONLY the deterministic prune (no fork). The transition state machine ALWAYS runs.
- Protected built-ins (`{'plan'}`) are NEVER eligible on any path regardless of `prune_builtins` or pin.
- Built-ins archive only after a FRESH inactivity window (seed-on-first-sight is the real safety, not the flag).
- Hub-installed skills are NEVER curated/archived/restored.
- `absorbed_into` must be passed at the delete call — guessing from the YAML summary after the fact is fragile.
- Cron rewrite is mandatory after consolidation; best-effort/wrapped.
- Snapshot failure NEVER aborts a curator pass; rollback takes a pre-rollback safety snapshot first.
- Tarball excludes `.curator_backups` (recursion) and `.hub`; INCLUDES `.curator_state` (so rollback also restores `last_run_at`, else the curator immediately re-fires).
- DO-NOT-CAPTURE taxonomy exists because captured negatives become persistent self-imposed constraints the agent cites against itself months later.

---

# Part 2 — Hermes Memory system

## 2.1 Curated core stores (MEMORY.md / USER.md)

Two small, file-backed, **character-bounded** stores rendered into the system prompt as a **FROZEN SNAPSHOT at session start**:
- `MEMORY.md` — the agent's PERSONAL NOTES (environment facts, project conventions, tool quirks, lessons learned).
- `USER.md` — the USER PROFILE (who the user is: name, role, preferences, communication style, workflow habits/expectations).

Both live under `<HERMES_HOME>/memories/` (`get_memory_dir() = get_hermes_home()/'memories'`, resolved dynamically per call so profile/HERMES_HOME switches take effect) (`memory_tool.py:55-57`).

### On-disk format (`memory_tool.py` data model)
- `ENTRY_DELIMITER = '\n§\n'` (newline, section-sign U+00A7, newline). A file is a flat list of free-text entries joined by this delimiter. Entries may be MULTILINE. Reading splits on the FULL `'\n§\n'` (not bare `§`) so an entry containing `§` is not mis-split.
- **No frontmatter, no IDs, no per-entry metadata, no timestamps.** Empty/whitespace file → zero entries. Entries stripped on read; empty dropped. Duplicates removed on load/reload via `dict.fromkeys` (order preserved, first kept).
- **Char budgets are CHARACTERS not tokens.** Defaults: `memory_char_limit=2200` (~800 tokens @2.75 chars/tok), `user_char_limit=1375` (~500 tokens). The budget covers the WHOLE store: `char_count = len('\n§\n'.join(entries))` — delimiters count; no single legitimate entry can exceed the whole-store limit (that's the drift signal).

### System-prompt block layout (`_render_block`, `memory_tool.py:607-623`)
A header line bracketed by two lines of `'═'*46`, then the §-joined content. memory header: `MEMORY (your personal notes) [N% — cur,/lim, chars]`; user header: `USER PROFILE (who the user is) [N% — cur,/lim, chars]`. Numbers comma-grouped; `pct = min(100, int(cur/lim*100))`. Blocks live in the VOLATILE tier (after stable identity + session-stable context files, before a date-only timestamp line); memory block precedes user block (`system_prompt.py:421-465`).

### MemoryStore — two parallel states (`memory_tool.py:113-731`)
`__init__(memory_char_limit=2200, user_char_limit=1375)` holds:
- `_system_prompt_snapshot {'memory','user'}` — FROZEN at load, injected into the prompt, never mutated mid-session.
- `memory_entries` / `user_entries` — live `List[str]`, mutated by tool calls, persisted to disk, reflected in tool responses.

`load_from_disk()` (`132-169`): mkdir memories dir; `_read_file` MEMORY.md→memory_entries, USER.md→user_entries; dedup; `_sanitize_entries_for_snapshot()` each list (threat→placeholder for snapshot ONLY; live lists keep raw text); `snapshot = {'memory': _render_block(...), 'user': _render_block(...)}`. Re-called by `invalidate_system_prompt()` on compression and at next session start.

`format_for_system_prompt(target)` (`567-578`) returns the FROZEN snapshot (or None if empty) — explicitly the load-time state, so mid-session writes do not change the prompt (keeps the prefix/KV cache warm).

### Threat scanning at snapshot build (`_sanitize_entries_for_snapshot`, `memory_tool.py:171-205`)
`scan_for_threats(entry, scope='strict')`; on findings the entry becomes `'[BLOCKED: <filename> entry contained threat pattern(s): <ids>. Removed from system prompt; use memory(action=remove) to delete the original.]'` (filename = `MEMORY.md`/`USER.md`, ids comma-joined). Empty entries and existing `[BLOCKED:` entries pass through. Deterministic from disk bytes so the snapshot stays byte-stable all session.

### External-drift detection (`_detect_external_drift`, `memory_tool.py:647-700`)
Two signals: (1) round-trip mismatch — `raw.strip() != '\n§\n'.join(parsed)`; (2) entry-size overflow — any single parsed entry length > the store's whole-file char_limit. On drift, write `path.bak.<unix_ts>` and signal refuse (`drift_backup` + remediation); backup-write failure returns path + `(BACKUP FAILED — file unchanged on disk)`. Instance method (needs per-target limit). Defends against patch-tool/shell/sister-session free-form writes (issue #26045). **Reads do NOT drift-check; only mutations do (under lock).**

### Locking & persistence (`memory_tool.py:207-242,251-267,625-645,702-731`)
`_file_lock(path)`: `fcntl.flock LOCK_EX` (Unix) / `msvcrt.locking` (Windows) / no-op yield otherwise; on a `.lock` sidecar so the data file can still be atomically replaced. `_reload_target` under lock: drift-check FIRST, then re-read+dedup+`_set_entries`. `_write_file`: `tempfile.mkstemp` in same dir, write+flush+fsync, `atomic_replace(tmp, path)`; empty list writes `''`.

## 2.2 Memory tool

A single `memory` tool with `action ∈ {add, replace, remove}` plus a batch `operations` path. Entries addressed by short **UNIQUE SUBSTRING** (no IDs).

### Schema & dispatcher (`memory_tool.py:838-901,931-1015`)
`memory(action?: 'add'|'replace'|'remove', target: 'memory'|'user' (REQUIRED), content?, old_text?, operations?: [{action, content?, old_text?}]) -> JSON string`. `required=['target']`. name=`memory`, toolset=`memory`, emoji 🧠. Store injected by runtime via `store=kw['store']` (`agent._memory_store`). Dispatcher: store None → error "Memory is not available…"; target not in `{memory,user}` → error. Single path validates required params BEFORE the gate (add needs content; replace needs old_text+content; remove needs old_text).

| op | Required shape | Behavior |
|---|---|---|
| `add(target, content)` | `{action:'add', target, content}` | strip; empty→err; scan strict→err; lock+reload+drift; exact dup→success "no duplicate added"; `new_total=len('\n§\n'.join(entries+[content]))`; if > limit → over-budget error WITH `current_entries` + usage + consolidate-in-one-turn instruction; else append, save (`296-346`) |
| `replace(target, old_text, content)` | `{action:'replace', target, old_text, content}` | empty old_text/content→err ("Use remove"); scan content; lock+reload+drift; matches = entries CONTAINING old_text; none→"No entry matched"; >1 distinct→err+80-char previews; >1 identical→first; budget check; replace idx (`348-411`) |
| `remove(target, old_text)` | `{action:'remove', target, old_text}` | empty→err; lock+reload+drift; substring match; none→err; >1 distinct→err+previews; >1 identical→first; pop idx, save. No budget check (`413-447`) |
| `apply_batch(target, operations)` | `{target, operations:[...]}` | Atomic all-or-nothing. Pre-scan EVERY add/replace content (one poisoned op rejects whole batch); lock+reload+drift; works on a COPY; per-op validation; **FINAL budget check only** (intermediate overflow allowed); commit copy + save once. `_batch_error` reports live uncommitted state + "No operations were applied (batch is all-or-nothing)." (`449-554`) |

### `_success_response()` (`memory_tool.py:582-605`)
`{success:true, done:true, target, usage:'N% — cur,/lim, chars', entry_count, message?, note:'Write saved. This update is complete — do not repeat it.'}`. **Deliberately omits the entries dump** (echoing them caused observed thrash — one correct batch then ~5 redundant repeats). Entries are echoed ONLY on error/over-budget paths (where the model needs them to decide consolidation): `{success:false, error, current_entries:[...], usage:'cur,/lim'}`.

### Optional write gate (`memory_tool.py:734-835`)
`_apply_write_gate`/`_apply_batch_write_gate` (config `memory.write_approval`, default False): `evaluate_gate(wa.MEMORY,...)` → allow→None (proceed); blocked→tool_error; stage→`wa.stage_write` + `{success:true, staged:true, pending_id, message}`. **Fails OPEN** (returns None) if `write_approval` can't import. `apply_memory_pending(payload, store)` replays a staged write bypassing the gate (called by `/memory approve`).

### Threat library
`scan_for_threats(content, scope='context') -> List[str]` pattern-ids; `first_threat_message(content, scope='strict') -> Optional[str]`. Memory uses `scope='strict'` (broadest: all + context + strict patterns, including invisible-unicode detection) at BOTH write time and snapshot-build time (`threat_patterns.py:11-24,49-115,187-245`).

### `MEMORY_GUIDANCE` (`prompt_builder.py:144-165`)
Injected only when the `memory` tool is loaded (`system_prompt.py:189-190`). States: keep compact (injected every turn); prioritize what reduces future steering; do NOT save task progress / PR#s / issue#s / commit SHAs / "fixed bug X" / "Phase N done" / anything stale in 7 days (use `session_search`); reusable procedures → skills. **Declarative-not-imperative rule:** "User prefers concise responses" ✓ vs "Always respond concisely" ✗; "Project uses pytest with xdist" ✓ vs "Run tests with pytest -n 4" ✗ — imperatives get re-read as standing directives in later sessions.

## 2.3 Write trigger (periodic nudge)

Two self-improvement counters share one deferred-review fork but tick on different clocks. (Skills counter `_iters_since_skill` is covered in §1.4; this is the memory counter `_turns_since_memory`.)

### Memory nudge tick (per user turn) — `build_turn_context` (`turn_context.py:204-238`)
When `_memory_nudge_interval>0` AND `'memory' in valid_tool_names` AND `_memory_store` is set: `_turns_since_memory += 1`; if `>= _memory_nudge_interval` (default 10): set `should_review_memory=True`, reset `_turns_since_memory=0`. `_user_turn_count += 1` unconditionally every turn. Returned on `TurnContext.should_review_memory` (dataclass field, line 57).

### Resume hydration (`turn_context.py:204-212`)
On the FIRST turn after resume (`_user_turn_count==0`) with non-empty history: count prior user-role messages → `prior_user_turns` → `_user_turn_count = prior_user_turns` → if `_memory_nudge_interval>0` and `_turns_since_memory==0`, set `_turns_since_memory = prior_user_turns % _memory_nudge_interval` (resumes mid-cadence). NOTE at line 183: `_turns_since_memory` and `_iters_since_skill` are deliberately NOT reset in the per-turn prologue.

### Counter reset on use (`tool_executor.py:268-272,863-867`)
Pre-execution: `if function_name=='memory': _turns_since_memory=0; elif 'skill_manage': _iters_since_skill=0`. Post-block-check: same resets but only when `not _execution_blocked` (a guardrail-blocked call does NOT reset). Effect: the nudge fires only after N turns/iters with NO self-update.

### Spawn (`turn_finalizer.py:375-401`)
External memory sync (`_sync_external_memory_for_turn`) runs first. Gate `final_response and not interrupted and (_should_review_memory or _should_review_skills)` → `agent._spawn_background_review(messages_snapshot=list(messages), review_memory, review_skills)` (try/except). Exactly ONE thread per turn. Prompt selection (`background_review.py:700-725`): both flags → `_COMBINED_REVIEW_PROMPT`; memory only → `_MEMORY_REVIEW_PROMPT`; else → `_SKILL_REVIEW_PROMPT`.

### `_MEMORY_REVIEW_PROMPT` (`background_review.py:34-43`)
Two-question focus: (1) did the user reveal persona/desires/preferences/personal details; (2) did the user express expectations about how the agent should behave / work style. Save via the memory tool or say "Nothing to save." The combined prompt partitions: memory = "who the user is and the current state of operations"; skills = "how to do this class of task for this user". Both skill and combined prompts carry the DO-NOT-CAPTURE taxonomy (see §1.4).

### `build_memory_write_metadata` (`background_review.py:419-443`)
Builds provenance dict for external-provider mirrors: `write_origin` (default `_memory_write_origin` or 'assistant_tool'), `execution_context` (default 'foreground'), `session_id`, `parent_session_id`, `platform`, `tool_name='memory'`, optional `task_id`/`tool_call_id`; strips None/'' values.

The review fork mechanics (shared snapshot, `skip_memory=True` with re-bound store, cache pinning, `compression_enabled=False`, codex downgrade, max_iterations=16) are identical to §1.4.

## 2.4 Cross-session recall (FTS5)

`session_search` — ONE tool with FOUR shapes inferred purely from which args are set (no `mode` param), backed by an FTS5 index over the SQLite message store.

### Dispatch (`session_search_tool.py:495-616`)
1. optional `@session:<profile>/<id>` normalization (split on `/`);
2. optional cross-profile DB swap (read-only, nulls `current_session_id`);
3. **SCROLL** if `session_id`+`around_message_id` set (precedence over query);
4. **READ** if `session_id` only (cross-profile locate-anywhere fallback on miss);
5. clamp limit `[1,10]`;
6. **BROWSE** if no/blank query;
7. **DISCOVERY** otherwise.

Registered toolset=`session_search`, emoji 🔍, `check_fn` requires the SQLite state DB.

### Shapes
- `_discover` (`394-492`): `db.search_messages(query, role_filter=['user','assistant'] default, exclude_sources=['subagent','tool'], limit=50, sort)` → dedupe hits by lineage root (`_resolve_to_parent`), skip current lineage & current session → per surviving session `db.get_anchored_view(hit_sid, msg_id, window=5, bookend=3)` → entry with snippet, bookend_start (first 3 user+asst), messages (±5 window, anchor flagged), bookend_end (last 3), match_message_id, messages_before/after; exposes `parent_session_id` when `lineage_root != hit_sid`. mode='discover'.
- `_scroll` (`270-391`): window clamp `[1,20]` default 5. REFUSES if anchor's lineage root == current session's lineage root. `db.get_messages_around`. On empty, raw SQL `SELECT session_id FROM messages WHERE id=?` to find the true owner; if a descendant in the same lineage root, transparently rebind+refetch (warns). mode='scroll'.
- `_read_session` (`178-224`): `db.get_session` meta + `db.get_messages`. If `total > head+tail`, return `shaped[:20] + shaped[-10:]` with `truncated=True` + a scroll pointer. mode='read'.
- `_list_recent_sessions` (`227-267`): `db.list_sessions_rich(limit+5, exclude_sources=['subagent','tool'], order_by_last_active=True)`. Skips current lineage root and any session with a `parent_session_id`. mode='browse'.
- `_resolve_to_parent` (`68-87`): walks `parent_session_id` to the lineage root with a cycle guard.
- `_resolve_profile_db` / `_locate_session_db` (`111-175`): open another profile's `state.db` read-only (mode=ro, no write lock); scan default + every profile for a bare id (ids globally unique).

### Schema (tables & triggers, `hermes_state.py`)
- `messages` (`551-571`): `id INTEGER PK AUTOINCREMENT, session_id TEXT FK→sessions(id), role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT(JSON), tool_name TEXT, timestamp REAL, token_count INTEGER, finish_reason TEXT, reasoning/reasoning_content/reasoning_details/codex_reasoning_items/codex_message_items TEXT, platform_message_id TEXT, observed INTEGER DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0`.
- `messages_fts` (`602-625`): single-column FTS5 (`content`), default unicode61 tokenizer, `rowid == messages.id`. INSERT/UPDATE/DELETE triggers mirror rows where content = `COALESCE(content,'')||' '||COALESCE(tool_name,'')||' '||COALESCE(tool_calls,'')` — so the single column indexes three message columns concatenated. UPDATE trigger deletes then re-inserts.
- `messages_fts_trigram` (`627-655`): FTS5 with `tokenize='trigram'` (overlapping 3-byte sequences → native substring match for CJK/Thai). Same concatenated payload, parallel triggers. Gated by `_trigram_available` (some SQLite builds lack the trigram tokenizer → "no such tokenizer: trigram", warned once, base FTS stays enabled).
- Six trigger names registered for schema reconciliation (`150-155`).

### `search_messages` executor (`hermes_state.py:3457-3776`)
Returns `[]` if `_fts_enabled` false or blank query. Sanitizes via `_sanitize_fts5_query`. ORDER BY rank (default), or timestamp DESC/ASC + rank for sort `newest`/`oldest`. WHERE `messages_fts MATCH ?` + `(active=1 OR compacted=1)` unless `include_inactive` (rewind rows excluded, compaction-archived rows kept, #38763) + source/exclude_sources/role filters. `snippet()` with `>>>`/`<<<` markers, 40-token context. **CJK routing:** ≥3 CJK chars and no short token and trigram available → trigram table; else LIKE substring over content/tool_name/tool_calls (ordered timestamp DESC, ignores `sort`). Adds 1-before + 1-after context per match; strips full content (snippet only).

Result row shape: `{id, session_id, role, snippet (>>>/<<<), timestamp, tool_name, source, model, session_started, context:[{role, content[:200]} up to 3]}` (content stripped). `get_anchored_view` return: `{window (role-filtered to user/assistant but anchor always kept), messages_before, messages_after, bookend_start (first N user/asst id<window_min, length(content)>0), bookend_end (last N, id>window_max, length>0)}`; default window=5, bookend=3.

### Selected interfaces
`session_search(query='', role_filter=None, limit=3, db=None, current_session_id=None, session_id=None, around_message_id=None, window=5, sort=None, profile=None) -> JSON`. `SessionDB.search_messages(query, source_filter=None, exclude_sources=None, role_filter=None, limit=20, offset=0, sort=None, include_inactive=False)`; `get_messages_around(session_id, around_message_id, window=5)`; `get_anchored_view(session_id, around_message_id, window=5, bookend=3, keep_roles=('user','assistant'))`; `list_sessions_rich(...)`; `SessionDB(db_path=None, read_only=False)` (read_only=True opens mode=ro, no write lock, no schema init).

## 2.5 Provider abstraction & Honcho

Persistent recall is abstracted behind a `MemoryProvider` ABC; concrete backends ship as plugins under `plugins/memory/<name>/`. A single `MemoryManager` is the only integration point.

### `MemoryProvider` ABC (`memory_provider.py:42-297`)
| Method | Kind | Signature |
|---|---|---|
| `name` | abstract property | `-> str` |
| `is_available` | abstract | `() -> bool` |
| `initialize` | abstract | `(session_id, **kwargs) -> None` |
| `get_tool_schemas` | abstract | `() -> List[Dict]` |
| `system_prompt_block` | default `''` | `() -> str` |
| `prefetch` | default `''` | `(query, *, session_id='') -> str` |
| `queue_prefetch` | default no-op | `(query, *, session_id='') -> None` |
| `sync_turn` | default no-op | `(user_content, assistant_content, *, session_id='', messages=None) -> None` |
| `handle_tool_call` | raises NotImplementedError | `(tool_name, args, **kwargs) -> str (JSON)` |
| `shutdown` | default | `() -> None` |
| `on_turn_start` | optional no-op | `(turn_number, message, **kwargs) -> None` |
| `on_session_end` | optional | `(messages) -> None` |
| `on_session_switch` | optional | `(new_session_id, *, parent_session_id='', reset=False, rewound=False, **kwargs) -> None` |
| `on_pre_compress` | optional `''` | `(messages) -> str` |
| `on_delegation` | optional | `(task, result, *, child_session_id='', **kwargs) -> None` |
| `on_memory_write` | optional | `(action, target, content, metadata=None) -> None` |
| `get_config_schema` | wizard | `() -> List[Dict]` (field `{key, description, secret(default False→.env), required, default, choices[], url, env_var}`) |
| `save_config` | wizard | `(values, hermes_home) -> None` |

`initialize` kwargs: always `hermes_home`+`platform`; may include `agent_context` (primary/subagent/cron/flush — skip writes for non-primary), `agent_identity`, `agent_workspace`, `parent_session_id`, `user_id`, `user_id_alt`.

### `MemoryManager` (`memory_manager.py:313-950`)
One instance in `run_agent.py`. Holds `_providers` (builtin always first), `_tool_to_provider` routing dict, `_has_external`, and a lazily-created **single-worker** `ThreadPoolExecutor` (`_sync_executor`, `max_workers=1`, `thread_name_prefix='mem-sync'`). `add_provider` enforces **at-most-one-external** + the **reserved-core-tool guard** (drops names in `_HERMES_CORE_TOOLS`, dedups duplicates). `prefetch_all`/`sync_all`/`queue_prefetch_all` strip skill scaffolding then fan out; sync+queue dispatch via `_submit_background`. `build_system_prompt` joins per-provider blocks. `handle_tool_call` routes by `_tool_to_provider`. All hook fan-outs wrapped in try/except (per-provider failure isolation). `shutdown_all` drains the executor (bounded `_SYNC_DRAIN_TIMEOUT_S=5.0`) then shuts providers in reverse order. `flush_pending` submits a sentinel barrier.

### Untrusted-output handling
- `build_memory_context_block(raw)` (`296-310`): wraps recall in `<memory-context>\n[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data — this is the agent's persistent memory and should inform all responses.]\n\n{clean}\n</memory-context>`. Returns `''` for empty.
- `sanitize_context` (`112-128`): one-shot scrubber — `_FENCE_TAG_RE` strips fence tags, `_INTERNAL_CONTEXT_RE` strips a full memory-context span, `_INTERNAL_NOTE_RE` strips the "NOT new user input" line (both variants).
- `StreamingContextScrubber` (`131-293`): stateful state machine over deltas (`_in_span`, `_buf`, `_at_block_boundary`); `feed(text)->visible`, `flush()` emits held tail OR DISCARDS if mid-span. Only treats `<memory-context>` as an opener at a BLOCK boundary followed by `\r`/`\n` so prose mentions don't trigger it. `reset()` per new top-level turn.
- `inject_memory_provider_tools` / `memory_provider_tools_enabled` (`48-105`): append external provider tool schemas, gated by enabled toolsets; dedupes; registers into `agent.valid_tool_names`; wraps each as `{'type':'function','function':schema}`.

### Plugin discovery (`plugins/memory/__init__.py:1-451`)
`_iter_provider_dirs` scans bundled `plugins/memory/<name>/` (skip `_`/`.` prefixes) then `$HERMES_HOME/plugins/<name>/` (bundled wins; user dirs filtered by text scan for `register_memory_provider`/`MemoryProvider`). `load_memory_provider`→`_load_provider_from_dir`: bundled module `plugins.memory.<name>`, user `_hermes_user_memory.<name>`; tries `register(ctx)` via `_ProviderCollector.register_memory_provider` FIRST, else instantiates any `MemoryProvider` subclass. `discover_memory_providers()` returns `(name, desc, is_available)`. `discover_plugin_cli_commands` loads `cli.py` for the ACTIVE provider only (`memory.provider` config).

### The 8 shipped backends
`byterover, hindsight, holographic, honcho, mem0, openviking, retaindb, supermemory`.

### Honcho — the AI-native "deepening user model"
`HonchoMemoryProvider` (`plugins/memory/honcho/__init__.py:191-1419`), `name='honcho'`. Models the conversation as two Honcho peers (user + ai), accumulates a representation/peer-card/conclusions per peer that grow across sessions, and recalls in **3 layers**: base `peer.context()` (representation + card), a multi-pass dialectic `peer.chat()` reasoning supplement, and persistent conclusions.

5 tools:
| Tool | Args |
|---|---|
| `honcho_profile` | `peer?, card?[]` (read/update peer card) |
| `honcho_search` | `query, max_tokens?≤2000, peer?` (semantic excerpts) |
| `honcho_reasoning` | `query, reasoning_level? (minimal/low/medium/high/max), peer?` (dialectic synthesis) |
| `honcho_context` | `query?, peer?` (summary + rep + card + recent msgs) |
| `honcho_conclude` | `conclusion? XOR delete_id?, peer?` |

`recall_mode` (hybrid|context|tools) gates tools + injection. Multi-pass dialectic `_run_dialectic_depth` (cold/warm prompts, early-bail when `_signal_sufficient` (>100 chars+structure or >300 chars), reasoning auto-scale). Guards: cron, lazy/background session init, trivial-prompt skip, stale-result discard, empty-streak backoff. `register(ctx)` at module end.

Supporting pieces: `HonchoSessionManager` (`session.py:71-1342`) wraps the SDK (peers, sessions, dialectic chat, context/card/conclusion CRUD, write-frequency queue); `HonchoSession` dataclass (`27-69`); `HonchoClientConfig` + `get_honcho_client` (`client.py:291-883`, file chain `$HERMES_HOME/honcho.json → ~/.hermes default → ~/.honcho/config.json → env`, per-host blocks win, singleton client, default timeout 30s).

### Honcho data-model notes
- Provider tool schema shape is BARE `{name, description, parameters}` — the manager/agent wraps it.
- Prefetch context keys: `summary`, `representation`, `card`, `ai_representation`, `ai_card`. Rendered sections: `## Session Summary`, `## User Representation`, `## User Peer Card`, `## AI Self-Representation`, `## AI Identity Card`.
- Honcho session id constraints: `^[a-zA-Z0-9_-]+`, max 100 chars (over-limit → prefix + `-<sha256[:8] of ORIGINAL key>`). Peer-id collision hash lengths: `(8,12,16,24,32,64)`.
- `_PROPORTIONAL_LEVELS` ((depth,pass)→level rel. base): `(1,0)=base; (2,0)=minimal,(2,1)=base; (3,0)=minimal,(3,1)=base,(3,2)=low`. `_LEVEL_ORDER=(minimal,low,medium,high,max)`.
- Reasoning auto-scale by query chars: `<120` +0; `120-399` +1; `≥400` +2; clamped to `reasoning_level_cap` (default 'high'). `_HEURISTIC_LENGTH_MEDIUM=120`, `_HEURISTIC_LENGTH_HIGH=400`.
- Migration uploads: `MEMORY.md→consolidated_memory.md`, `USER.md→user_profile.md` (user peer), `SOUL.md→agent_soul.md` (ai peer), each wrapped in `<prior_memory_file>`; prior local history as `<prior_conversation_history>`. Skipped under per-session strategy.
- `InsightsEngine` (`agent/insights.py:84-922`, `/insights`) is **pure SQLite usage ANALYTICS** (tokens, cost, tool/skill/activity breakdowns) — NOT memory recall, touches no MemoryProvider.

## 2.6 Memory — config knobs (table) & gotchas

### Config knobs (built-in stores + counters)
| Knob | Default | Meaning |
|---|---|---|
| `memory.memory_enabled` | `True` (config DEFAULTS) / `False` (agent_init fallback) | Enables MEMORY.md store + block |
| `memory.user_profile_enabled` | `True` (DEFAULTS) / `False` (fallback) | Enables USER.md store + block |
| `memory.memory_char_limit` | `2200` | Whole-store char budget for MEMORY.md (~800 tok); also its drift threshold |
| `memory.user_char_limit` | `1375` | Whole-store char budget for USER.md (~500 tok) + drift threshold |
| `memory.nudge_interval` | `10` | User-turns between memory-review nudges; 0 disables (forced 0 on forks) |
| `memory.write_approval` | `False` | Gates memory writes (foreground prompt inline, background staged) |
| `memory.provider` | `''` | Selects the single external provider plugin; empty = built-in only |
| `agent.memory_notifications` | `'on'` | Verbosity: off / on / verbose |
| `ENTRY_DELIMITER` | `'\n§\n'` | Section-sign delimiter (constant, not configurable) |
| `get_memory_dir()` | `<HERMES_HOME>/memories/` | Resolved dynamically per call |
| `_turns_since_memory` | `0` (resume-hydrated to `prior_user_turns % interval`) | Per-session user-turn counter |
| `_iters_since_skill` | `0` | Per-session tool-iteration counter |
| review fork `max_iterations` | `16` | Hard cap on the review fork |

### Config knobs (provider/Honcho)
| Knob | Default | Meaning |
|---|---|---|
| `_SYNC_DRAIN_TIMEOUT_S` | `5.0` | Max wait for in-flight background sync/prefetch at shutdown |
| one-external-provider rule | enforced | At most one non-builtin provider |
| `recall_mode` (`recallMode`) | `hybrid` | hybrid=inject+tools; context=inject only; tools=tools only |
| `injectionFrequency` | `every-turn` | `first-turn` returns empty prefetch after turn 1 |
| `contextCadence` | `1` | Min turns between base-context refreshes |
| `dialecticCadence` | `1` (wizard writes 2) | Min turns between dialectic fires; widened by empty-streak backoff |
| `dialecticDepth` | `1` | `.chat()` passes per cycle (clamp 1-3) |
| `dialecticDepthLevels` | `None` | Explicit per-pass levels; overrides proportional table |
| `dialecticReasoningLevel` | `low` | Base dialectic level |
| `dialecticDynamic` | `true` | When false, ignores per-call reasoning_level overrides |
| `reasoningHeuristic` | `true` | Auto-scale base level by query length |
| `reasoningLevelCap` | `high` | Ceiling for heuristic-selected level |
| `dialecticMaxChars` | `600` | Max chars of a dialectic result kept |
| `dialecticMaxInputChars` | `10000` | Max chars of dialectic query input |
| `messageMaxChars` | `25000` | Max chars per message to `add_messages()`; larger chunked `[continued]` |
| `contextTokens` | `None` (uncapped) | Token budget for auto-injected context; truncated to `contextTokens×4` chars |
| `writeFrequency` | `async` | async (queue, retry-once) / turn / session / int N |
| `observationMode` | `directional` (new) / `unified` (legacy) | Legacy shorthand for observe flags |
| `user_observe_me/others`, `ai_observe_me/others` | all True (directional) | Per-peer `SessionPeerConfig`; `ai_observe_others` drives the deepening model |
| `sessionStrategy` | `per-directory` | per-session / per-repo / per-directory / global |
| `pinPeerName`/`pinUserPeer` | `false` | Pin user peer to `peerName` |
| `initOnSessionStart` | `false` | Eager session create in tools mode |
| `timeout` (`HONCHO_TIMEOUT`) | `30.0s` | SDK HTTP timeout; base for first-turn dialectic join (8s fallback) |
| `_STALE_THREAD_MULTIPLIER` | `2.0` | A prefetch thread older than timeout×this is treated as dead |
| `_STALE_RESULT_MULTIPLIER` | `2` | A pending dialectic result older than cadence×this is discarded on read |
| `_BACKOFF_MAX` | `8` | Empty-streak backoff ceiling (effective cadence ≤ base×8) |

### Recall config knobs (session_search)
| Knob | Default | Meaning |
|---|---|---|
| `session_search limit` | `3` (clamp [1,10]) | Max distinct lineage-deduped sessions |
| `session_search window` | `5` (clamp [1,20]) | Messages each side of the anchor |
| `get_anchored_view bookend` | `3` | First/last user+assistant non-empty messages |
| `_read_session head / tail` | `20 / 10` | Head+tail when a session is larger than head+tail |
| `search_messages internal limit` | `50` | Widened FTS5 fetch for lineage-dedupe |
| `_HIDDEN_SESSION_SOURCES` | `('subagent','tool')` | Excluded from all search/browse |
| snippet token budget | `40` | Context tokens around the FTS5 match (`>>>`/`<<<`) |

### Gotchas (memory)
- **FROZEN SNAPSHOT is the whole point** — `format_for_system_prompt` returns the load-time snapshot, NOT live entries. A write this session is durable on disk but INVISIBLE to the model until next session or a compression rebuild. Keep snapshot and live lists as two separate states; mid-session writes must NOT mutate the snapshot/`_cached_system_prompt` (or the upstream prefix/KV cache invalidates).
- **Budget counts the JOINED string including delimiters** — `len('\n§\n'.join(entries))`; N entries add `(N-1)*3` delimiter chars.
- **Addressing is by SUBSTRING containment**, first-match wins; multiple distinct matches → error + 80-char previews; all-identical → first.
- **`apply_batch` is ALL-OR-NOTHING and validates the FINAL state only** — lets the model free space and add in one call even when an add alone would overflow. Exact-dup add inside a batch is skipped idempotently.
- Over-budget single add does NOT auto-consolidate — it rejects and tells the model to do remove/replace + add in ONE batch this turn. Success path NEVER echoes entries; only error/over-budget paths include `current_entries`.
- **Threat scan runs TWICE with scope='strict'** — snapshot build (poisoned disk → `[BLOCKED]` placeholder, raw kept in live state for the user) and write time (rejects).
- **External-drift guard** — a single parsed entry larger than the limit, or a non-round-tripping file, → `.bak.<ts>` + REFUSE. Reads do NOT drift-check; only mutations do (under lock).
- **Declarative-not-imperative is a HARD rule** — imperatives get re-read as standing directives later. Procedures/workflows go to SKILLS, not memory.
- **Stale-fact ban** — no PR/issue numbers, commit SHAs, "fixed bug X", "Phase N done", file counts, task progress.
- File ops atomic (temp+fsync+os.replace); locking is fcntl/msvcrt, no-op on platforms with neither.
- `get_memory_dir()` resolved per call so a profile/HERMES_HOME switch is respected.
- `_read_file` splits on the FULL `'\n§\n'` (not bare `§`); serialization must match.
- Both stores live in ONE MemoryStore; `memory_enabled`/`user_profile_enabled` independent (either alone constructs the store).
- The write gate fails OPEN if `write_approval` can't import.
- **The two nudge counters tick on DIFFERENT clocks** — memory = per user turn; skill = per tool-calling iteration. A single long turn advances skill by many but memory by exactly 1.
- Memory nudge evaluated in the PROLOGUE but spawned in the EPILOGUE (carried on `TurnContext`); skill trigger evaluated AND spawned in `finalize_turn`.
- Resume-hydration uses MODULO and only on the first post-resume turn.
- Memory nudge requires all three: `_memory_nudge_interval>0` AND `'memory' in valid_tool_names` AND `_memory_store` set.
- **`session_search` is ONE tool with FOUR shapes inferred from args** — no `mode`. SCROLL takes precedence over READ over a query; READ is session_id alone; BROWSE is no args; DISCOVERY is query.
- It REFUSES to scroll into / dedupes out the current session's lineage.
- FTS5 indexes a SINGLE `content` column but the triggers feed it `content || tool_name || tool_calls` concatenated.
- Default unicode61 splits CJK into single chars; ≥3-CJK queries route to trigram (or per-token LIKE fallback). Trigram tokenizer may be absent in some SQLite builds.
- `search_messages` excludes rewind rows (active=0, compacted=0) but INCLUDES compaction-archived (active=0, compacted=1) (#38763).
- Cross-profile reads open `state.db` read_only=True (mode=ro), nulling `current_session_id` (disables lineage guards).
- **One-external-provider rule**; **reserved-core-tool guard** drops provider tools named like built-ins (#40466).
- Provider tool schemas are BARE; the manager wraps them.
- **The 298s lesson** — ALL post-turn sync/prefetch run on ONE background worker (a misconfigured Hindsight daemon once blocked ~298s inline). Off-thread + single-worker = ordered, non-blocking, failure-isolated.
- Untrusted output treated as data — fenced + "NOT new user input"; one-shot `sanitize_context` strips pre-existing fences; `StreamingContextScrubber` discards an unterminated span at flush (leak-safe over completeness). Honcho writes are themselves scrubbed before storing.
- `on_memory_write` SKIPS the builtin provider (it is the write source).
- Honcho cron guard: `agent_context ∈ {cron,flush}` or `platform=='cron'` → fully inactive.
- Honcho `_session_ready` vs `_manager` — background init sets `_manager` before blocking setup completes; hooks must check `_session_ready()`.
- Cadence advances ONLY on a non-empty dialectic result; empty increments the streak (backs off, capped base×8).
- Stale-result discard (cadence×2), trivial-prompt skip, early-bail (depth is a ceiling).
- Deepening hinges on `ai_observe_others`; `delete_conclusion` is PII-only (Honcho self-heals).
- per-session strategy skips MEMORY/USER/SOUL migration.
- `/insights` is analytics, NOT recall — don't conflate.

---

# Part 3 — Ours today (current state)

## 3.1 Skills today

Agent Canvas equips every supervised `claude` CLI card with a single curated skill **PLUGIN**, authored in-process as data (`CANVAS_SKILLS`) and materialized at spine startup into `~/.agentcanvas-web/canvas-skills/`, attached to every card via `--plugin-dir`.

- `CANVAS_SKILLS` (`src/main/spine/skills.ts:48-238`): array of `CanvasSkill {name, description, body}`. **5 skills today:** `working-in-agent-canvas` (fleet-citizen primer) + four Mastermind ROLE skills (`mastermind-planner`, `mastermind-lead`, `mastermind-worker`, `mastermind-strategist`). HARDCODED — not dynamic, not per-card-selected; the whole plugin goes on every card (skills.ts:11-16). `PLUGIN_NAME='canvas-skills'`, `PLUGIN_VERSION='0.1.0'` (skills.ts:35-36). The strategist body carries `STRATEGIST_WORKFLOW_PLACEHOLDER='__STRATEGIST_WORKFLOW_PATH__'`.
- `CanvasSkill` interface (`skills.ts:20-31`): `name` (lowercase `[a-z0-9-]` ≤64 → `/canvas-skills:<name>`), `description` (≤1024, the only part always in context — drives auto-invocation), `body` (markdown, progressive-disclosure, loaded on demand).
- `ClaudeAdapter.stageSkills` (`claudeAdapter.ts:78-114`): `rmSync`s `<dir>/canvas-skills/` then rebuilds from scratch each call (editing skills.ts ships on relaunch; removed skill never lingers). Writes `.claude-plugin/plugin.json`, writes the pinned workflow to `workflows/strategist-tournament.js` (`STRATEGIST_WORKFLOW_REL`) from `STRATEGIST_TOURNAMENT_SRC`, then per skill writes `skills/<name>/SKILL.md` as `---\nname: <name>\ndescription: <JSON-quoted>\n---\n\n<body>`. Strategist placeholder replaced with the workflow's absolute path. Description emitted as a JSON-quoted YAML scalar so a `:` can't break frontmatter.
- `ClaudeAdapter.launchCommand` (`claudeAdapter.ts:170-192`): `exec claude --settings <hooks.json> --plugin-dir <pluginDir> --mcp-config <browser-mcp.json> <issue-mcp.json> -- <prompt>`. `--plugin-dir` added whenever `this.pluginDir` is set. The `--` before the prompt is load-bearing (`--mcp-config` is variadic). No `--strict-mcp-config`.
- `Spine.start` (`spine.ts:102`): `this.adapter.stageSkills(SPINE_DIR)` runs at startup with no sink/port dependency. `SPINE_DIR = ~/.agentcanvas-web` (spine.ts:22).
- `strategistTournament.js` (311 lines): the pinned idea tournament — 10 lensed generators → Bradley-Terry pairwise contest → cull/refine 10→6→3→1 → absolute-bar gate. Inlined into skills.ts via `import ... ?raw` (skills.ts:18). Invoked by absolute scriptPath through the CLI's **built-in Workflow tool** (NOT one of our MCP tools). Generators/judges read the REAL repo (cwd); canvas vision passed as `args.vision`. Returns `{gapRead, candidates:[{idea,why,outcome,visionLink,lens,rating,eliminatedRound?}], winnerLens, abstainReason}`.

### On-disk format & layout
- SKILL.md (written by stageSkills): `---\nname: <name>\ndescription: <JSON.stringify(description)>\n---\n\n<body>\n`.
- Plugin dir under SPINE_DIR: `canvas-skills/.claude-plugin/plugin.json` (manifest `{name:'canvas-skills', version:'0.1.0', description}`), `canvas-skills/skills/<name>/SKILL.md`, `canvas-skills/workflows/strategist-tournament.js`. Whole dir rmSync'd + rebuilt each call.
- Invocation namespace `/canvas-skills:<name>` (e.g. `/canvas-skills:mastermind-lead`).

## 3.2 Orchestrator runtime

`runOrchestrator` (`orchestrator.ts:57-176`) is **ONE long-lived Agent SDK `query()`** in streaming-input mode, fed by an `AsyncIterable<SDKUserMessage>` (NOT re-spawned per call). Options:
- model `claude-opus-4-8` (line 100);
- `systemPrompt` = inline `SYSTEM_PROMPT` string (lines 15-29, 101) — **NO `appendSystemPrompt`, NO `settingSources`, NO skills**;
- `mcpServers {canvas: buildCanvasServer(bus)}` (line 102);
- `tools:[]` strips all built-ins (line 109);
- `includePartialMessages:true` (line 111);
- `canUseTool` routes EVERY tool (NO `allowedTools`) for speech-pacing + permission (lines 69-84, 103-110);
- `UserPromptSubmit` hook injects `bus.openCanvas()` snapshot each turn (lines 119-132);
- deletes `process.env.ANTHROPIC_API_KEY` at startup to force subscription auth (line 67).

`Orchestrator` manager (`manager.ts:75-667`): `startSession()` (458-479) calls `runOrchestrator` once; session is long-lived — `input()` generator (484-492) yields queued messages then idles until `enqueue()` wakes it; auto-restarts in the finally only if work is queued and not disposed. Three queue producers: `run()` chat, `notifyAgentReply()`, `notifyAsk()`. `notifyMilestone()` (219-318) is the cascade router (plan-ready→spawn lead; issue-assigned/done/blocked→deterministic sendToAgent nudges; idea-ready→spawn planner with winner verbatim; idea-abstained→escalate; outcome-verified→spawnStrategist). `spawnStrategist` (324-354)/`retireStrategist` (358-363) manage the autonomous head. Modes `manual|partner|autonomous` (95).

Role→skill boot: `mainBus.spawnAgent` (`mainBus.ts:216-233`) — if `input.role` is set, prepends `/canvas-skills:mastermind-${role} ${mode}\n\n` to the turn-0 prompt (`mode = 'autonomous'` if `getMode()==='autonomous'` else `'partner'`). A slash command at the START runs before anything else. Single chokepoint covering LLM-spawned and requestWorkers/spawnStrategist-spawned cards.

Role-gated agent MCP: `AgentIssueMcp` (`agentIssueMcp.ts:79-721`) — stateless server-per-POST; calling card from `X-Canvas-Card`, token via `X-Canvas-Token`. `buildServer(cardId)` (143) resolves role from `getState().cards[].role` (default `'worker'`) and registers tools by role: ALL→`get_vision`; non-strategist→`list_issues`/`get_issue`/`comment_issue`; non-worker→`list_sprints`; planner|lead→`get_plan`; worker→`update_issue_status`/`report_blocker`; planner→`create_sprint`/`create_plan`/`approve_plan`; lead→`create_issue`/`set_deps`/`amend_issue`/`retire_issue`/`assign_issue`/`set_sprint_state`/`request_workers`; strategist→`get_vision_history`/`record_conception`/`set_conception_winner`/`abstain_conception`. Workers see ONLY own issues (`visibleIssues`, 164-167). Talks DIRECTLY to `IssueStore` (no command bus).

## 3.3 Persistence today

The ONLY durable domain store is the Mastermind substrate `IssueStore` (`issueStore.ts:75-586`) — an append-only JSONL event log at `~/.agentcanvas-web/issues.jsonl` replayed into memory.
- `apply()` (135-157): reduce → if ok, append one `LogEntry {seq, ts, ids, action}` line → `onChange`.
- `load()` (92-121): readFileSync, split lines, JSON.parse each, replay through reduce with recorded ids/ts (deterministic replay), tolerate malformed lines.
- `reduce()` (165-556) is the reducer over `IssueActionRequest`.
- `milestone()` (124-126) suppressed during replay (replaying latch).
- **`flush()` (161) is a NO-OP** — explicit comment "Seam for future compaction"; the log grows unbounded today.
- No memory/learning data here — purely vision/sprint/plan/issue/conception domain records.

Data shapes:
- `LogEntry` (issueStore.ts:37-43): `{seq:number, ts:number, ids:string[], action:IssueActionRequest}`. `ids` = ids generated by that action in reduce-call order (fed back on replay for deterministic refs); `ts` = apply-time timestamp (reused on replay).
- `IssueSnapshot` (types.ts:914-923): `{visions, versions, sprints, plans, issues, distance, conceptions}` — flat arrays keyed by projectId; the reduce target and read-projection.
- `IssueActionRequest` union (types.ts:806-897): `vision.commit/assessDistance`, `sprint.create/setState/resolveRealignment/remove`, `plan.create/approve`, `issue.create/setStatus/claim/release/setDeps/postVerdict/comment/amend/retire`, `conception.create/updateRound/setWinner/abstain` — the full mutation vocabulary.
- `Idea` (types.ts:751-798): `{id, idea, why, outcome, visionLink, lens, rating?, eliminatedRound?}`. `Conception`: `{id, projectId, visionVersionRef, gapRead?, candidates:Idea[], rounds:ConceptionRound[], state:'deliberating'|'decided'|'abstained', winnerIdeaRef?, abstainReason?, createdAt}`. The strategist's recorded idea tournament — the closest thing to a persisted "reasoning trace," but per-conception, not cross-run memory.

Other persisted files (no domain memory): `workspace.json` (canvas layout, debounced ~400ms), `spine.json` (token + ports, chmod 0600), `push.json` (web-push subs), `soniox.key` (encrypted voice key), `canvas-skills/` (staged plugin), `hooks.json`/`browser-mcp.json`/`issue-mcp.json` (per-launch transport configs, chmod 0600).

`ClaudeAdapter.currentTodos` (`claudeAdapter.ts:215-249`) reads the CLI's own task store `~/.claude/tasks/<sessionId>/*.json` (`{id, subject, activeForm, status}`) — read-only consumption of CLI state, the only place our code reads agent-side disk state, and it is ephemeral plan data, not memory/learning.

## 3.4 Attachment seams

- **Skill staging:** `Spine.start()` → `adapter.stageSkills(SPINE_DIR)` (spine.ts:102), no port dependency → rmSync + rebuild canvas-skills/ + write pinned workflow + substitute strategist path → sets `this.pluginDir`.
- **Card spawn:** `Spine.launch` → `ClaudeAdapter.launchCommand` → `exec claude --settings hooks.json --plugin-dir <canvas-skills> --mcp-config browser-mcp.json issue-mcp.json -- <prompt>`. Every card gets the full plugin; selection is by which role skill the prompt invokes.
- **Issue-MCP gating (per request):** POST /mcp → `handle()` auth (token) → `buildServer(cardId)` resolves role → registers ONLY that role's tools → executes against `IssueStore.apply` directly.
- **Orchestrator session (long-lived):** `enqueue()` → wake input generator → `ensureSession()` → `startSession()` → `runOrchestrator` builds ONE `query()` → idles between turns → ends only on `dispose()` or SDK error (auto-restarts if work queued).
- **Persistence write:** any `IssueActionRequest` → `IssueStore.apply` → reduce (validate, mutate in-memory, mint ids) → if ok append one JSONL line + `onChange(snapshot)` → `onMilestone`.
- **Persistence load (startup):** index.ts replays issues.jsonl before the window can ask → `IssueStore.load()` reads all lines, replays with recorded ids/ts (milestones suppressed).
- **Milestone feed:** `IssueStore.onMilestone` (index.ts:323) → `orchestrator.notifyMilestone` → cascade routing. `IssueStore.onChange` (index.ts:257) → `send('issue-update', snapshot)` to renderer.
- **IPC:** `load-issue-store` (invoke→IssueSnapshot), `issue-action` (invoke IssueActionRequest→IssueActionResult), `issue-update` (push IssueSnapshot) (index.ts:460-461,257).
- **MEMORY/LEARNING: NONE.** No control flow reads or writes any cross-run agent memory, learnings, or reflection. `flush()`/compaction is a no-op. Confirmed by `grep -rniwE 'memory|remember|recall|learn|knowledge|reflection'` (only in-memory data structures / "learn whether configured"); `grep` for MEMORY.md/loadMemory/writeMemory → none. The user's own `~/.claude/.../MEMORY.md` is harness/Claude-Code state, not read by this app.

### Selected config knobs (ours)
| Knob | Default | Meaning |
|---|---|---|
| `PLUGIN_NAME` | `'canvas-skills'` | Namespaces `/canvas-skills:<name>`; must stay stable across reattach (skills.ts:35) |
| `PLUGIN_VERSION` | `'0.1.0'` | Plugin manifest version (skills.ts:36) |
| `STRATEGIST_WORKFLOW_REL` | `'workflows/strategist-tournament.js'` | Where stageSkills writes the pinned workflow (skills.ts:43) |
| `STRATEGIST_WORKFLOW_PLACEHOLDER` | `'__STRATEGIST_WORKFLOW_PATH__'` | Token replaced with the workflow abs path (skills.ts:46) |
| `SPINE_DIR` | `~/.agentcanvas-web` | On-disk home for ALL main-process state (spine.ts:22) |
| tmux SOCKET | `'agentcanvas-web'` | Canvas-owned socket, isolated from Swift app (spine.ts:23) |
| orchestrator model | `'claude-opus-4-8'` | Pinned model (orchestrator.ts:100) |
| `OrchestratorMode` | `'manual'` | manual\|partner\|autonomous (manager.ts:95) |
| `REPLY_CLIP` | `500` | Chars before an agent reply is clipped into a fleet event (manager.ts:32) |
| requestWorkers clamp | `1..8` | Worker fleet size clamp (manager.ts:377) |
| `IssueStore.flush()` | no-op | The compaction seam — exists but does nothing in v1 (issueStore.ts:159-161) |

---

## 3.5 SDK Agent Skills support (authoritative — official SDK docs)

Source: Claude Agent SDK "Agent Skills in the SDK" (`code.claude.com/docs/en/agent-sdk/skills`). Platform facts the mastermind's skill library builds on.

- Skills are filesystem `SKILL.md` artifacts; **no programmatic registration API** — write files to disk, the SDK discovers them.
- **Discovery**: skill *metadata* discovered at **startup** from the configured setting sources; **full body loaded on trigger** (progressive disclosure, same as hermes). New skills appear only at the **next `query()`** — no hot-reload. This is what lets a fresh-`query()`-per-reaction model absorb newly authored skills automatically.
- **Loading sources**: `settingSources`/`setting_sources` must include `'user'` (`~/.claude/skills/`) and/or `'project'` (`<cwd>/.claude/skills/` + parents up to repo root); OR the **`plugins` option** loads skills from a specific path (plugin skills referenced as `plugin:skill`).
- **`skills` option**: omitted ⇒ discovered skills enabled + Skill tool available; `"all"` ⇒ all; `["a","b"]` ⇒ only those (match frontmatter `name` or dir name); `[]` ⇒ none. It is a **context filter, not a sandbox** (unlisted skills are hidden from the model but their files remain readable via Read/Bash).
- **Tools coupling**: setting `skills` auto-adds the `Skill` tool to `allowedTools`. **If you pass an explicit `tools` list you MUST include `"Skill"`**, or Claude cannot invoke skills.
- **`allowed-tools` frontmatter in `SKILL.md` is IGNORED under the SDK** (CLI-only). SDK tool access is governed by the query's `allowedTools` (+ any `canUseTool` callback).
- Skills are **model-invoked**: Claude autonomously calls the Skill tool when a skill's `description` matches context.

**Delta from our current orchestrator `query()` (`orchestrator.ts:97-109`)** — today `{ model:'claude-opus-4-8', systemPrompt: SYSTEM_PROMPT, mcpServers:{canvas}, tools:[] }`, no settingSources/skills/plugins. What the docs require to give the mastermind a private skill library (factual, not a design choice):

| Option | Today | Required for mastermind skills |
|---|---|---|
| `tools` | `[]` (suppresses Skill tool) | must include `"Skill"` (explicit list) |
| `skills` | unset | `"all"` or a curated name list |
| skill loader | none | `plugins: [<staged mastermind-skills dir>]` (private; reuses stageSkills/--plugin-dir; keeps skills out of global `~/.claude/skills`) |
| `systemPrompt` | static `SYSTEM_PROMPT` | `SYSTEM_PROMPT` + frozen memory snapshot (memory ≠ skills; rides the system prompt, not the skills mechanism) |

(Design/matching deferred — this block is authoritative platform reference only.)

## 3.6 SKILL.md authoring standards (authoritative — Anthropic best-practices)

Source: Anthropic "Skill authoring best practices". Rules to follow when the mastermind / its reviewer AUTHORS skills.

**Frontmatter validation (hard):**
- `name`: ≤64 chars, lowercase letters/numbers/hyphens only, no XML tags, **no reserved words `anthropic`/`claude`**. Gerund form recommended (`handling-stalled-sprints`).
- `description`: non-empty, ≤1024 chars, no XML tags, **third person ALWAYS** (injected into system prompt; POV drift breaks discovery). State **what it does + when to use it** with key trigger terms. This is THE skill-selection signal.

**Authoring rules:**
- Concise — assume Claude is smart; only add what it doesn't already know. Each token competes with conversation/context once loaded.
- Match **degrees of freedom** to task fragility: high freedom (text heuristics) for context-dependent work; medium (parameterized templates); low (exact steps/scripts, "do not modify") for fragile/consistency-critical ops.
- Progressive disclosure: SKILL.md body **<500 lines**; split overflow into files; **references ONE level deep from SKILL.md** (Claude partial-reads nested refs → incomplete info); ToC at top of any reference file >100 lines.
- No time-sensitive info (use a collapsed "old patterns" `<details>` section); consistent terminology throughout.
- MCP tool refs in bodies MUST be fully qualified `ServerName:tool_name` (for us `canvas:spawn_agent`, `canvas:send_to_agent`, …) or Claude may not locate the tool.
- Forward-slash paths only (cross-platform).
- Evaluation-driven dev: build 2-3 evals first, baseline without the skill, write minimal instructions, iterate by observing real usage (the "Claude A authors / Claude B uses / observe / refine" loop).

**Divergence to note — hermes vs Anthropic on `description` length:** hermes's house style caps descriptions at ≤60 chars / one sentence (§1.1) to keep its always-injected index of *hundreds* of skills small; Anthropic wants richer what+when descriptions (≤1024) for selection accuracy. For a SMALL mastermind library where selection accuracy dominates index size, follow Anthropic's richer-description guidance, not hermes's terse rule.

**Constraint for mastermind skills specifically:** the "Skills with executable code" half (utility scripts, package deps, code-exec env) largely **does NOT apply** — the mastermind runs with `tools:["Skill"]` + the canvas MCP and has **no Bash/code-execution**, and the Agent SDK (OAuth/API-like) has **no runtime package install** (per the authoring doc, the API path has no network/runtime install). So mastermind skills are **markdown-instruction-only**: procedures that direct `canvas:*` MCP calls, never script-bearing. (Script-bearing skills would belong to the fleet cards, which can run code — but those are the fixed role cards.)

(Design/matching deferred — authoritative reference only.)

## 3.7 SDK structured outputs (authoritative — where it fits the learning loop)

Source: Claude Agent SDK "Get structured output from agents". `query({ outputFormat: { type:"json_schema", schema } })` (TS) / `output_format` (Py) → after multi-turn tool use, the result message carries a validated `structured_output`; the SDK re-prompts on mismatch, and on exhaustion the result `subtype` is `error_max_structured_output_retries` (can also be a model-fallback retraction — distinguish via the `errors` field). Supports standard JSON Schema (object/array/string/number/boolean/null, enum, const, required, nested, `$ref`); Zod `z.toJSONSchema()` / Pydantic `.model_json_schema()` generate it.

**Applicability to this work:**
- **Fits the deferred reviewer's RETURN contract.** Instead of the reviewer fork calling write-tools directly (hermes's approach), run the reviewer as a `query()` whose `outputFormat` is its DECISION schema, e.g. `{ nothing_to_save:bool, memory_writes:[{store,op,target?,text}], skill_actions:[{op:create|patch,name,description,body}] }`; the main process then applies the validated plan deterministically (inspect/gate first). = hermes's plan→validate→execute, with "validate" provided by the SDK; also removes the reviewer's need for filesystem write tools.
- **Fits assessment sub-calls** (distance-to-vision assessor, tournament/judge verdicts) — naturally schema'd.
- **Does NOT fit the live control-plane reaction loop:** `outputFormat` forces the run to END with the blob; the mastermind's long-lived reactor acts via `canvas:*` tools and should not terminate in a JSON payload per reaction. Use structured output for short-lived OUT-OF-BAND sub-calls, not the reactor.
- **Error handling:** treat `error_max_structured_output_retries` as "nothing persisted this cycle" (a valid outcome); keep schemas focused, make uncertain fields optional.
- **Not** relevant to on-disk memory/skill formats (§2.1, §3.6) — this concerns a sub-call's return contract, not stored artifacts.

(Design/matching deferred — capability reference only.)

## 3.8 SDK system-prompt & memory-injection mechanics (authoritative)

Source: Claude Agent SDK "Modifying system prompts."
- **Three starting points:** minimal default (omit `systemPrompt` → tool-calling only, no CC guidance); `claude_code` **preset** (full Claude Code coding prompt; optional `append`); **custom string** (only what you write — you own tool guidance/safety/env context). Decision rule: custom string when the agent has a different surface/identity/permission model or is non-coding.
- **`append` is a property of the PRESET object** (`{type:"preset",preset:"claude_code",append}`). There is **no append for a custom string** — with a custom string you compose the whole prompt yourself. (Resolves the earlier "systemPrompt vs appendSystemPrompt" question: N/A for custom strings.)
- **`excludeDynamicSections: true`** is **preset-object only** (no effect on a custom string; TS v0.2.98+ / Py v0.1.58+). Moves per-session dynamic context (cwd, git flag, platform, shell, OS, auto-memory paths) out of the system prompt into the first user message so identical configs share a prompt cache across machines. Principle = keep volatile context out of the cached prefix (the SDK's built-in version of hermes §2.1's discipline).
- **CLAUDE.md is injected into the CONVERSATION, not the system prompt** (loaded via settingSources `'project'`/`'user'`); explicitly does NOT affect the system-prompt cache. Separate channel.
- **Output styles** modify the system prompt via saved markdown loaded through settingSources — a persona mechanism, not a memory channel.

Our orchestrator today: custom string `systemPrompt: SYSTEM_PROMPT` (`orchestrator.ts:101`), no settingSources — i.e. already on the custom-string path.

(Design/matching deferred — authoritative reference only.)

## Open / uncertain

- **`curator.prune_builtins` default — RESOLVED to `true`.** (The source maps disagreed; verified directly: `curator.py:187` `cfg.get("prune_builtins", True)` and `skill_usage.py:257` `cur.get("prune_builtins", True)` both default `True`. The authoring-trigger map's `false` was wrong.) When on, bundled built-ins become curation candidates only after a FRESH inactivity window (seed-on-first-sight); `false` exempts ALL built-ins.
- **`memory.memory_enabled` / `memory.user_profile_enabled` defaults are stated two ways**, but consistently: `True` in config DEFAULTS (`hermes_cli/config.py:1883-1906`) vs `False` at the `agent_init` read fallback (the value used when the config key is absent). The map for §2.3 also lists `false / false` for these (the agent_init view). Not a contradiction — config-DEFAULTS True wins in practice; the False is only the safety fallback when the key is missing entirely.
- All seven source map objects self-report `confidence: high`; no other facts were flagged low-confidence or conflicting. The maps note that **no memory/self-learning system exists in Agent Canvas today** (Part 3) — this is asserted from grep evidence, not an exhaustive read of every file, but is corroborated by multiple greps cited inline.
