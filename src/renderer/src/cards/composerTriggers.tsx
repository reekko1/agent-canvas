import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { unstable_useMentionAdapter, type Unstable_Mention } from '@assistant-ui/react'
import type { DirectiveChipProps } from '@assistant-ui/react-lexical'
import { FileIcon, SparklesIcon } from 'lucide-react'
import { CLI_SKILL_PREFIX, type CliKind, type ModelChoice } from '@shared/types'
import { ComposerTriggerPopover } from '@/components/assistant-ui/composer-trigger-popover'
import {
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorRoot,
  ModelSelectorTrigger,
} from '@/components/assistant-ui/model-selector'

/// Per-card context so the (generic, copied) Thread composer can build controls
/// scoped to THIS card: its id (skills/models/file IPCs are per-card), CLI (the
/// skill-invocation prefix), folder (the repo file list), the selected model,
/// and a setter that persists + live-switches it. Provided by TranscriptView.
export const CardChatContext = createContext<{
  cardId: string
  cli: CliKind
  folder: string
  model?: string
  onModelChange?: (model: string) => void
  /** The card's runnable models, loaded once by TranscriptView (it doubles as
   *  the session-readiness probe). `null` = still loading; `[]` = none. */
  models: ModelChoice[] | null
} | null>(null)

/// The composer's `/` (skills) + `@` (repo files) pickers. Both use the default
/// directive formatter — insertion drops a `:type[label]{name=id}` directive that
/// DirectiveText renders as a chip; TranscriptView's onNew rewrites each directive
/// to its `id` (the clean invocation / path) before the text reaches the CLI.
/// Must render INSIDE ComposerPrimitive.Unstable_TriggerPopoverRoot.
export function CardComposerTriggers() {
  const ctx = useContext(CardChatContext)
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const [files, setFiles] = useState<string[]>([])

  useEffect(() => {
    void window.canvas.listSkills().then(setSkills)
  }, [])
  useEffect(() => {
    if (!ctx) return
    void window.canvas.searchFiles(ctx.folder).then(setFiles)
  }, [ctx?.folder])

  const cli = ctx?.cli ?? 'claude'
  const skillItems = useMemo<Unstable_Mention[]>(
    () =>
      skills.map((s) => ({
        id: `${CLI_SKILL_PREFIX[cli]}${s.name}`, // the clean invocation the CLI receives (same record the drivers' skillRef() reads)
        type: 'skill',
        label: s.name,
        description: s.description,
        icon: 'skill',
      })),
    [skills, cli],
  )
  const fileItems = useMemo<Unstable_Mention[]>(
    () => files.map((p) => ({ id: p, type: 'file', label: p, icon: 'file' })),
    [files],
  )

  const skillMention = unstable_useMentionAdapter({ items: skillItems })
  const fileMention = unstable_useMentionAdapter({ items: fileItems })

  if (!ctx) return null
  return (
    <>
      <ComposerTriggerPopover
        char="/"
        {...skillMention}
        iconMap={{ skill: SparklesIcon }}
        fallbackIcon={SparklesIcon}
        emptyItemsLabel="No matching skills"
      />
      <ComposerTriggerPopover
        char="@"
        {...fileMention}
        iconMap={{ file: FileIcon }}
        fallbackIcon={FileIcon}
        emptyItemsLabel="No matching files"
      />
    </>
  )
}

/// The composer's model picker — purely presentational off the loaded model
/// list (TranscriptView owns the fetch, since it doubles as the session-
/// readiness probe). `null` = still loading (rare here: for a fresh card the
/// whole surface shows the init shimmer until this resolves, so by the time the
/// composer renders the list is usually ready). Selecting one live-switches the
/// session and persists the choice (`onModelChange`).
export function CardModelSelector() {
  const ctx = useContext(CardChatContext)
  if (!ctx) return null
  const models = ctx.models
  if (models === null) return <div className="h-8 w-24 animate-pulse rounded-md bg-muted/60" aria-hidden />
  if (models.length === 0) return null
  return (
    <ModelSelectorRoot models={models} value={ctx.model} onValueChange={ctx.onModelChange}>
      <ModelSelectorTrigger variant="ghost" size="sm" />
      <ModelSelectorContent>
        <ModelSelectorList>
          <ModelSelectorEmpty />
          {models.map((m) => (
            <ModelSelectorItem key={m.id} model={m} />
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorRoot>
  )
}

/// The inline chip a picked skill/file renders as inside the Lexical composer
/// (passed to LexicalComposerInput's `directiveChip`). A compact pill with a
/// type icon; files show their basename (full path on hover + as the sent id).
export function DirectiveChip({ directiveType, label }: DirectiveChipProps) {
  const isFile = directiveType === 'file'
  const Icon = isFile ? FileIcon : SparklesIcon
  const display = isFile ? label.split('/').pop() || label : label
  return (
    <span
      title={label}
      className="inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 align-baseline text-sm font-medium text-foreground"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      {display}
    </span>
  )
}

/** Rewrite composer text for the CLI: replace each `:type[label]{name=id}`
 *  directive (default formatter) with its clean `id` — the skill invocation or
 *  file path — so the agent never sees chip syntax. ponytail: the format is
 *  fixed/documented; a label never contains `]` (skill names + repo paths). */
export function stripDirectives(text: string): string {
  return text.replace(/:[A-Za-z]\w*\[[^\]]*\]\{name=([^}]*)\}/g, '$1')
}
