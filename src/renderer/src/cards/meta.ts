import type {
  AgentTodo,
  CardEvent,
  CardKind,
  CardStatus,
  PermissionAskInfo,
} from '@shared/types'

// Status palette lives in index.css (:root tokens); loud = blocked/error.
export const STATUS_COLORS: Record<CardStatus, string> = {
  idle: 'var(--status-idle)',
  running: 'var(--status-running)',
  waiting: 'var(--status-waiting)',
  done: 'var(--status-done)',
  stalled: 'var(--status-stalled)',
  blocked: 'var(--status-blocked)',
  error: 'var(--status-error)',
}

/// A card's accumulated spine state — everything the chrome and the poster
/// render. Owned by the canvas (per node), fed exclusively by applyCardEvent.
export interface CardMeta {
  status: CardStatus
  /** When the status last changed — feeds the "· 14m" attention-debt suffix. */
  statusSince?: number
  /** The CLI session running in this card — persisted (unlike status) because
   *  a tmux session outlives the app: it keys plan re-hydration on restart. */
  sessionId?: string
  detail?: string
  task?: string
  summary?: string
  model?: string
  permissionMode?: string
  subagents?: number
  todos?: AgentTodo[]
  ask?: PermissionAskInfo | null
}

export interface CardData extends Record<string, unknown> {
  folder: string
  /** 'agent' = watched claude session; 'shell' = bare $SHELL, no hooks — the
   *  spine never speaks about it, so its meta stays idle forever. */
  kind: CardKind
  meta: CardMeta
  onDecide: (cardId: string, askId: string, decision: 'allow' | 'deny') => void
  onClose: (cardId: string) => void
}

/** Fold one spine event into a card's meta (pure — the canvas owns the state,
 *  the adapter stays stateless, and this stays testable). */
export function applyCardEvent(m: CardMeta, ev: CardEvent): CardMeta {
  const meta = { ...m }
  if (ev.status) {
    if (ev.status !== meta.status) meta.statusSince = Date.now()
    meta.status = ev.status
    // Any non-blocked status means the ask resolved CLI-side (answered,
    // timed out, or released) — never leave a stale overlay up.
    if (ev.status !== 'blocked') meta.ask = null
  }
  if (ev.detail) meta.detail = ev.detail
  if (ev.taskLabel) meta.task = ev.taskLabel
  if (ev.clearTask) meta.task = undefined
  if (ev.summary) meta.summary = ev.summary
  if (ev.model) meta.model = ev.model
  if (ev.permissionMode) meta.permissionMode = ev.permissionMode
  if (ev.resetSubagents) meta.subagents = 0
  if (ev.subagentDelta) {
    meta.subagents = Math.max(0, (meta.subagents ?? 0) + ev.subagentDelta)
  }
  if (ev.todoChange) meta.todos = applyTodoChange(meta.todos, ev.todoChange)
  return meta
}

function applyTodoChange(
  todos: AgentTodo[] | undefined,
  tc: NonNullable<CardEvent['todoChange']>,
): AgentTodo[] | undefined {
  switch (tc.kind) {
    case 'replace':
      return tc.todos
    case 'clear':
      return undefined
    case 'add':
      return [...(todos ?? []), tc.todo]
    case 'update':
      return (todos ?? []).flatMap((t) => {
        if (t.id !== tc.id) return [t]
        if (tc.status === 'deleted') return []
        return [
          {
            ...t,
            status: tc.status ?? t.status,
            content: tc.content ?? t.content,
            activeForm: tc.activeForm ?? t.activeForm,
          },
        ]
      })
  }
}
