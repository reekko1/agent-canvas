import { useEffect, useMemo, useState } from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import type { CardStatus, CliKind, TranscriptItem } from '@shared/types'
import { Thread } from '@/components/assistant-ui/thread'
import { CardChatContext, stripDirectives } from './composerTriggers'

/// An agent card's live conversation, rendered by assistant-ui's `Thread`.
/// The DATA layer is unchanged from the terminal-era view: self-subscribe to
/// `onTranscriptItem` FIRST, then load the persisted backlog, so no live push
/// is missed between the two; state is a plain array upserted by
/// `TranscriptItem.id` (a streaming assistant message re-pushes under the same
/// id, so "append vs replace" is decided by id equality). The PRESENTATION is
/// bridged into an ExternalStoreRuntime: our items are the store, mapped to
/// assistant-ui messages by `toMessage`, and `Thread` owns the whole surface —
/// message list, markdown, tool cards, auto-scroll, and the composer. Sending
/// routes back out through `onNew → sendToCard`; the resulting `user` item is
/// echoed by main, so we never optimistically append it here.

function upsert(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  // Fast path: a streaming item almost always updates the LAST element.
  if (items.length && items[items.length - 1].id === item.id) {
    return [...items.slice(0, -1), item]
  }
  const i = items.findIndex((x) => x.id === item.id)
  if (i === -1) return [...items, item]
  const next = items.slice()
  next[i] = item
  return next
}

function mergeLoaded(loaded: TranscriptItem[], buffered: TranscriptItem[]): TranscriptItem[] {
  let out = loaded
  for (const item of buffered) out = upsert(out, item)
  return out
}

/// A turn's worth of items, coalesced into one assistant-ui message. A `user`
/// item is its own group; every assistant-side item (assistant text, tool
/// calls, error/system notes) folds into ONE assistant group until the next
/// `user` or `turn` boundary. This is what lets consecutive tool calls render
/// as a single grouped "N tool calls" card — assistant-ui only groups
/// tool-call PARTS within a message, so they must share one message.
type Group = { id: string; role: 'user' | 'assistant'; items: TranscriptItem[] }

function groupItems(items: TranscriptItem[]): Group[] {
  const groups: Group[] = []
  let open: Group | null = null // the assistant group currently accumulating
  for (const item of items) {
    if (item.kind === 'user') {
      groups.push({ id: item.id, role: 'user', items: [item] })
      open = null
    } else if (item.kind === 'turn') {
      open = null // a turn boundary closes the assistant group (drops the bare duration)
    } else {
      if (!open) {
        open = { id: item.id, role: 'assistant', items: [] }
        groups.push(open)
      }
      open.items.push(item)
    }
  }
  return groups
}

/** One item → one message part. `tool` becomes a tool-call part (its salient
 *  line as args text, captured output as result); everything else is text. */
function toPart(item: TranscriptItem) {
  if (item.kind === 'tool') {
    return {
      type: 'tool-call' as const,
      toolCallId: item.id,
      toolName: item.toolName ?? 'tool',
      args: {},
      argsText: item.text,
      result: item.detail ?? (item.failed ? 'failed' : undefined),
    }
  }
  return { type: 'text' as const, text: item.text }
}

function toMessage(group: Group): ThreadMessageLike {
  const first = group.items[0]
  const base = { id: group.id, createdAt: new Date(first.ts) }
  if (group.role === 'user') {
    return { ...base, role: 'user', content: [{ type: 'text', text: first.text }] }
  }
  const streaming = group.items.some((i) => i.kind === 'assistant' && i.streaming)
  return {
    ...base,
    role: 'assistant',
    content: group.items.map(toPart),
    status: streaming ? { type: 'running' } : { type: 'complete', reason: 'stop' },
  }
}

export function TranscriptView({
  cardId,
  status,
  folder,
  cli,
}: {
  cardId: string
  status: CardStatus
  folder: string
  cli: CliKind
}) {
  const [items, setItems] = useState<TranscriptItem[]>([])

  useEffect(() => {
    let loaded = false
    const buffer: TranscriptItem[] = []
    setItems([])
    // Subscribe BEFORE loading — no push between subscribe and load can be lost.
    const off = window.canvas.onTranscriptItem((id, item) => {
      if (id !== cardId) return
      if (!loaded) {
        buffer.push(item)
        return
      }
      setItems((prev) => upsert(prev, item))
    })
    void window.canvas.loadTranscript(cardId).then((backlog) => {
      loaded = true
      setItems(mergeLoaded(backlog, buffer))
    })
    return off
  }, [cardId])

  const messages = useMemo(() => groupItems(items), [items])

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: status === 'running',
    convertMessage: toMessage,
    onNew: async (message: AppendMessage) => {
      const raw = message.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
      const text = stripDirectives(raw).trim()
      if (text) await window.canvas.sendToCard(cardId, text)
    },
    onCancel: async () => {
      window.canvas.interruptCard(cardId)
    },
  })

  return (
    <CardChatContext.Provider value={{ cli, folder }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread />
      </AssistantRuntimeProvider>
    </CardChatContext.Provider>
  )
}
