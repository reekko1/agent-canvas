import { useEffect, useRef } from 'react'
import type { Project, RemoteState, RepoIdentity } from '@shared/types'
import { isLoud } from '@/cards/meta'
import { basenameOf } from '@/lib/utils'
import type { CanvasNode } from './nodes'
import type { ActivityNotification } from './useActivityFeed'
import type { PendingAsk } from './usePendingAsks'
import type { PendingQuestion } from './usePendingQuestions'
import type { AttentionLevel } from './useProjectAttention'
import type { ShellTitle } from './useShellTitles'

/** The host of a browser card's url (e.g. "mail.google.com") — a readable
 *  fallback name when the page title hasn't loaded yet. */
function hostOf(url?: string): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host || undefined
  } catch {
    return url
  }
}

/// Mirror the attention state to the remote panel. Riding the same renderer
/// state as the in-app surfaces (cards' meta, the toast asks/questions, the
/// activity feed, the per-canvas attention + git) means the phone and the
/// canvas can never disagree. The phone leads with canvases; cards, approvals
/// and questions group under them by project id. Published through a
/// content-compare so position-only changes don't churn IPC.
export function useRemotePublish({
  nodes,
  projects,
  activeProjectId,
  attention,
  git,
  shellTitles,
  asks,
  questions,
  notifications,
  titleFor,
}: {
  nodes: CanvasNode[]
  projects: Project[]
  activeProjectId: string | null
  attention: Record<string, AttentionLevel>
  git: Record<string, RepoIdentity>
  shellTitles: Record<string, ShellTitle>
  asks: PendingAsk[]
  questions: PendingQuestion[]
  notifications: ActivityNotification[]
  titleFor: (cardId: string) => string
}) {
  const lastJSON = useRef('')

  useEffect(() => {
    // cardId → its canvas, so approvals/questions (which only know a cardId)
    // can be tagged with the same projectId as the cards.
    const projectIdFor = new Map<string, string>()
    for (const p of projects) for (const id of p.cardIds) projectIdFor.set(id, p.id)
    const nameFor = new Map(projects.map((p) => [p.id, p.name]))

    const canvases: RemoteState['canvases'] = projects.map((p) => ({
      id: p.id,
      name: p.name,
      active: p.id === activeProjectId,
      attention: attention[p.id] ?? 'none',
      dirty: git[p.id]?.dirty ?? 0,
      branch: git[p.id]?.branch,
    }))

    const cards: RemoteState['cards'] = nodes
      .flatMap((n) => (n.type === 'card' ? [n] : []))
      .map((n) => {
        const projectId = projectIdFor.get(n.id)
        const shell = n.data.kind === 'shell'
        const browser = n.data.kind === 'browser'
        const title = shellTitles[n.id]
        // Shell titles follow the pane's cwd (the user's cd's), like the
        // desktop; a browser reads as its live page (title, else host); agents
        // keep the static open folder.
        const name =
          shell && title?.cwd
            ? (basenameOf(title.cwd) ?? titleFor(n.id))
            : browser
              ? n.data.name || n.data.title || hostOf(n.data.url) || titleFor(n.id)
              : titleFor(n.id)
        return {
          id: n.id,
          name,
          kind: n.data.kind,
          status: n.data.meta.status,
          loud: isLoud(n.data.meta.status),
          since: (n.data.meta.statusSince ?? 0) / 1000,
          task: n.data.meta.task,
          running: shell ? title?.running : undefined,
          // The browser's current page — lets the orchestrator answer "what page
          // are we on" instead of only seeing the card name.
          url: browser ? n.data.url : undefined,
          // Owner link + stated reason for an agent-requested browser — main's
          // agent MCP server resolves "my browser" from ownerId.
          ownerId: browser ? n.data.ownerCardId : undefined,
          reason: browser ? n.data.reason : undefined,
          model: n.data.meta.model,
          permissionMode: n.data.meta.permissionMode,
          subagents: n.data.meta.subagents ?? 0,
          projectId,
          projectName: projectId ? nameFor.get(projectId) : undefined,
        }
      })

    const approvals: RemoteState['approvals'] = asks.map((a) => ({
      id: a.askId,
      name: titleFor(a.cardId),
      detail: a.detail,
      created: a.created / 1000,
      projectId: projectIdFor.get(a.cardId),
    }))

    const qs: RemoteState['questions'] = questions.map((q) => ({
      id: q.askId,
      name: titleFor(q.cardId),
      projectId: projectIdFor.get(q.cardId),
      questions: q.questions,
    }))

    const feed: RemoteState['feed'] = notifications.map((n) => ({
      name: n.title,
      status: n.status,
      loud: isLoud(n.status),
      message: n.description,
      date: n.timestamp.getTime() / 1000,
    }))

    const state: RemoteState = {
      canvases,
      cards,
      approvals,
      questions: qs,
      feed,
      needsYou:
        approvals.length + qs.length + cards.filter((c) => c.status === 'error').length,
    }
    const json = JSON.stringify(state)
    if (json === lastJSON.current) return
    lastJSON.current = json
    window.canvas.publishRemoteState(state)
  }, [nodes, projects, activeProjectId, attention, git, shellTitles, asks, questions, notifications, titleFor])
}
