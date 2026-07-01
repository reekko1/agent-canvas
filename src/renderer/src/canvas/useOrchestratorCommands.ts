import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction, type MutableRefObject } from 'react'
import { getBrowser } from '@/cards/browserBridge'
import type { OrchestratorConfirm } from '@/orchestrator/OrchestratorConfirmToast'
import { COMET_TRAVEL_MS } from '@shared/types'
import type {
  AgentRole,
  CardKind,
  CliKind,
  OrchestratorCommand,
  OrchestratorCommandResult,
  Project,
} from '@shared/types'
import type { CanvasNode } from './nodes'
import type { ProjectsApi } from './useProjects'

/// The renderer end of the orchestrator command bus. Main (the NL orchestrator)
/// dispatches canvas mutations and gate-confirms over `onOrchestratorCommand`;
/// this runs them against the live project state and replies by id via
/// `orchestratorResult`. A ref holds the latest closure so the IPC listener
/// subscribes once, not every render. Owns the pending permission gate
/// (`orchConfirm`) surfaced in the chat bar; everything else is delegated to the
/// canvas's own card-lifecycle / project callbacks passed in here. The gate copy
/// arrives pre-described from main (manager.describeGate) — this just displays it.
export function useOrchestratorCommands(deps: {
  proj: ProjectsApi
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>
  nodesRef: MutableRefObject<CanvasNode[]>
  makeCard: (
    cardId: string,
    folder: string,
    kind: CardKind,
    name?: string,
    url?: string,
    role?: AgentRole,
    cli?: CliKind,
  ) => CanvasNode
  switchProject: (id: string) => void
  promoteCard: (cardId: string) => void
  nextAgentName: () => string
  bumpBrowser: (cardId: string) => void
  titleFor: (cardId: string) => string
  renameCard: (cardId: string, name: string) => boolean
  onCloseCard: (cardId: string) => void
  reveal: (cardId: string) => void
  setPendingReveal: Dispatch<SetStateAction<Set<string>>>
}) {
  const {
    proj,
    setNodes,
    nodesRef,
    makeCard,
    switchProject,
    promoteCard,
    nextAgentName,
    bumpBrowser,
    titleFor,
    renameCard,
    onCloseCard,
    reveal,
    setPendingReveal,
  } = deps

  // The orchestrator's pending permission gate (one at a time — the SDK awaits
  // canUseTool before the next tool, so confirms never overlap).
  const [orchConfirm, setOrchConfirm] = useState<OrchestratorConfirm | null>(null)

  /** Resolve a spawn target canvas (explicit id, else the active canvas), or the
   *  failure message both spawn paths share. */
  const resolveTarget = (
    canvasId?: string,
  ): { ok: true; target: Project } | { ok: false; message: string } => {
    const target = canvasId ? proj.projects.find((p) => p.id === canvasId) : proj.active
    if (!target) {
      return { ok: false, message: canvasId ? `no canvas with id ${canvasId}` : 'no active canvas' }
    }
    return { ok: true, target }
  }

  /** The shared post-create choreography for a spawned card: attach to its canvas,
   *  bring that canvas forward, and hold it invisible until the delivering comet
   *  lands (a safety timer reveals it if the comet never fires — e.g. off-screen). */
  const finishSpawn = (target: Project, cardId: string): void => {
    proj.attachCardTo(target.id, cardId)
    if (proj.activeProjectId !== target.id) switchProject(target.id)
    setPendingReveal((s) => new Set(s).add(cardId))
    setTimeout(() => reveal(cardId), COMET_TRAVEL_MS + 1500)
  }

  // The orchestrator (main) dispatches canvas mutations and confirms here; we
  // run them against the live project state and reply by id. A ref holds the
  // latest closure so the IPC listener subscribes once, not every render.
  const orchCommandRef = useRef<(cmd: OrchestratorCommand) => void>(() => {})
  orchCommandRef.current = (cmd) => {
    const reply = (result: OrchestratorCommandResult): void =>
      window.canvas.orchestratorResult(cmd.id, result)

    if (cmd.cmd === 'confirm') {
      // Pre-described by main (manager.describeGate) — surface it as a gate toast.
      const { title, detail } = cmd.payload
      setOrchConfirm({ id: cmd.id, title, detail })
      return
    }

    if (cmd.cmd === 'confirm-clear') {
      // The gate was resolved on another device (the phone) or timed out — dismiss
      // our toast. Fire-and-forget: no result reply expected.
      setOrchConfirm((c) => (c?.id === cmd.id ? null : c))
      return
    }

    if (cmd.cmd === 'focusCanvas') {
      const { canvasId } = cmd.payload
      const target = proj.projects.find((p) => p.id === canvasId)
      if (!target) {
        reply({ ok: false, message: `no canvas with id ${canvasId}` })
        return
      }
      switchProject(canvasId)
      reply({ ok: true, message: `switched to ${target.name}` })
      return
    }

    if (cmd.cmd === 'spawnAgent') {
      const res = resolveTarget(cmd.payload.canvasId)
      if (!res.ok) {
        reply({ ok: false, message: res.message })
        return
      }
      const { target } = res
      const name = cmd.payload.name?.trim() || nextAgentName()
      const prompt = cmd.payload.prompt?.trim() ?? ''
      void (async () => {
        const r = await window.canvas.newCard(target.dir)
        if (!r) {
          reply({ ok: false, message: 'card creation was cancelled' })
          return
        }
        // Queue the instruction BEFORE the card mounts, so ensure-card launches
        // the agent already working on it (no keystroke race against startup).
        if (prompt) window.canvas.setInitialPrompt(r.cardId, prompt)
        setNodes((ns) => [
          ...ns,
          makeCard(r.cardId, r.folder, 'agent', name, undefined, cmd.payload.role, cmd.payload.cli),
        ])
        finishSpawn(target, r.cardId)
        reply({
          ok: true,
          cardId: r.cardId,
          message: `spawned ${name} on ${target.name}${prompt ? ', working on the task' : ''}`,
        })
      })()
      return
    }

    if (cmd.cmd === 'spawnBrowser') {
      const res = resolveTarget(cmd.payload.canvasId)
      if (!res.ok) {
        reply({ ok: false, message: res.message })
        return
      }
      const { target } = res
      const url = cmd.payload.url?.trim() || undefined
      const name = cmd.payload.name?.trim() || undefined
      const ownerCardId = cmd.payload.ownerCardId
      const reason = cmd.payload.reason?.trim() || undefined
      void (async () => {
        const r = await window.canvas.newBrowser(target.dir, url)
        if (!r) {
          reply({ ok: false, message: 'browser creation was cancelled' })
          return
        }
        const node = makeCard(r.cardId, r.folder, 'browser', name, url)
        // An agent-requested browser carries its owner link + stated reason.
        node.data.ownerCardId = ownerCardId
        node.data.reason = reason
        setNodes((ns) => [...ns, node])
        bumpBrowser(r.cardId) // a freshly opened browser starts live, not evicted
        finishSpawn(target, r.cardId)
        reply({
          ok: true,
          cardId: r.cardId,
          message: `opened a browser on ${target.name}${url ? ` at ${url}` : ''}`,
        })
      })()
      return
    }

    if (cmd.cmd === 'navigateBrowser') {
      const { cardId, url } = cmd.payload
      // The kind guard is owned by mainBus.requireBrowser before dispatch (and a
      // card's kind is immutable) — here we only confirm the card still exists in
      // the live node set, which can lead main's last-published snapshot.
      const node = nodesRef.current.find((n) => n.id === cardId && n.type === 'card')
      if (!node) {
        reply({ ok: false, message: `no card with id ${cardId}` })
        return
      }
      // Bump the nonce so BrowserView loads the url; surface the card so the
      // navigation is visible. Display url updates from the webview's did-navigate.
      setNodes((ns) =>
        ns.map((n) =>
          n.id === cardId && n.type === 'card'
            ? { ...n, data: { ...n.data, goto: { url, nonce: (n.data.goto?.nonce ?? 0) + 1 } } }
            : n,
        ),
      )
      promoteCard(cardId)
      reply({ ok: true, message: `navigated ${titleFor(cardId)} to ${url}` })
      return
    }

    if (cmd.cmd === 'setBrowserReason') {
      const { cardId, reason } = cmd.payload
      // Kind guarded by mainBus before dispatch — only the live existence check here.
      const node = nodesRef.current.find((n) => n.id === cardId && n.type === 'card')
      if (!node) {
        reply({ ok: false, message: `no card with id ${cardId}` })
        return
      }
      setNodes((ns) =>
        ns.map((n) =>
          n.id === cardId && n.type === 'card' ? { ...n, data: { ...n.data, reason } } : n,
        ),
      )
      reply({ ok: true, message: `updated reason for ${titleFor(cardId)}` })
      return
    }

    if (cmd.cmd === 'readBrowser' || cmd.cmd === 'screenshotBrowser' || cmd.cmd === 'actBrowser') {
      const { cardId } = cmd.payload
      // Kind guarded by mainBus before dispatch; the missing-handle check below
      // also covers a non-browser (it never registers a BrowserHandle).
      const node = nodesRef.current.find((n) => n.id === cardId && n.type === 'card')
      if (!node) {
        reply({ ok: false, message: `no card with id ${cardId}` })
        return
      }
      const handle = getBrowser(cardId)
      if (!handle) {
        reply({ ok: false, message: `${titleFor(cardId)}'s web view isn't ready yet` })
        return
      }
      // An action mutates the page — surface the card so it's visible. Reads and
      // screenshots are silent observations (no promote, no comet latency).
      if (cmd.cmd === 'actBrowser') promoteCard(cardId)
      void (async () => {
        try {
          if (cmd.cmd === 'readBrowser') {
            reply({ ok: true, message: `read ${titleFor(cardId)}`, snapshot: await handle.read() })
          } else if (cmd.cmd === 'screenshotBrowser') {
            reply({ ok: true, message: `captured ${titleFor(cardId)}`, image: await handle.screenshot() })
          } else {
            reply(await handle.act(cmd.payload.action))
          }
        } catch (e) {
          reply({ ok: false, message: e instanceof Error ? e.message : String(e) })
        }
      })()
      return
    }

    if (cmd.cmd === 'renameAgent') {
      const { cardId, name } = cmd.payload
      reply(
        renameCard(cardId, name)
          ? { ok: true, message: `renamed to ${name.trim()}` }
          : { ok: false, message: `couldn't rename ${cardId}` },
      )
      return
    }

    if (cmd.cmd === 'killCard') {
      const { cardId } = cmd.payload
      if (!nodesRef.current.some((n) => n.id === cardId && n.type === 'card')) {
        reply({ ok: false, message: `no card with id ${cardId}` })
        return
      }
      const name = titleFor(cardId) // capture before onCloseCard removes the node
      onCloseCard(cardId)
      reply({ ok: true, message: `closed ${name}` })
      return
    }

    // Exhaustiveness: every OrchestratorCommand variant is handled above, so cmd
    // is narrowed to `never` here. A new variant trips this assignment at compile
    // time instead of silently falling through to the runtime reply below (which
    // stays for the untyped-IPC edge — a malformed message off the wire).
    const _exhaustive: never = cmd
    reply({ ok: false, message: `unknown command: ${String((_exhaustive as { cmd?: unknown }).cmd)}` })
  }
  useEffect(() => window.canvas.onOrchestratorCommand((cmd) => orchCommandRef.current(cmd)), [])

  /** Answer the pending gate (one in flight at a time) and clear it. */
  const resolveConfirm = useCallback((allow: boolean) => {
    setOrchConfirm((c) => {
      if (c) window.canvas.orchestratorResult(c.id, { allow })
      return null
    })
  }, [])

  return { orchConfirm, resolveConfirm }
}
