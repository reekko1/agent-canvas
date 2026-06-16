// Drives orchestrator turns in the main process. Owns the real CommandBus:
// `list_world` projects the latest RemoteState; mutations and confirms are
// dispatched to the renderer over a correlation-id channel and awaited. Streams
// events back to the chat bar.
import { runOrchestrator, type GateDecision } from './orchestrator'
import type { CommandBus, World } from './contract'
import type {
  OrchestratorCommandResult,
  OrchestratorEvent,
  RemoteState,
} from '../../shared/types'

export interface OrchestratorDeps {
  send: (channel: string, ...args: unknown[]) => void
  getState: () => RemoteState | null
}

export class Orchestrator {
  private readonly pending = new Map<number, (r: OrchestratorCommandResult) => void>()
  private nextId = 1
  private running = false

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Reply to a dispatched command (called from the renderer via IPC). */
  resolveCommand(id: number, result: OrchestratorCommandResult): void {
    const resolve = this.pending.get(id)
    if (resolve) {
      this.pending.delete(id)
      resolve(result)
    }
  }

  private dispatch(
    cmd: 'focusCanvas' | 'spawnAgent' | 'confirm',
    payload: Record<string, unknown>,
  ): Promise<OrchestratorCommandResult> {
    const id = this.nextId++
    this.deps.send('orchestrator-command', { id, cmd, payload })
    return new Promise<OrchestratorCommandResult>((resolve) => {
      this.pending.set(id, resolve)
      // The renderer might never reply (window gone) — don't wedge the turn.
      setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false, message: 'no response from the app' })
      }, 30_000)
    })
  }

  private readonly bus: CommandBus = {
    listWorld: async (): Promise<World> => {
      const s = this.deps.getState()
      if (!s) return { canvases: [], cards: [], approvals: [], needsYou: 0 }
      return {
        canvases: s.canvases.map((c) => ({
          id: c.id,
          name: c.name,
          attention: c.attention,
          dirty: c.dirty,
          branch: c.branch,
        })),
        cards: s.cards.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          status: c.status,
          task: c.task,
          canvasId: c.projectId,
          canvasName: c.projectName,
        })),
        approvals: s.approvals.map((a) => ({
          id: a.id,
          name: a.name,
          detail: a.detail,
          canvasId: a.projectId,
        })),
        needsYou: s.needsYou,
      }
    },

    focusCanvas: async (canvasId) => {
      const r = await this.dispatch('focusCanvas', { canvasId })
      return { ok: !!r.ok, message: r.message ?? (r.ok ? 'switched' : 'failed') }
    },

    spawnAgent: async (input) => {
      const r = await this.dispatch('spawnAgent', { ...input })
      return { ok: !!r.ok, cardId: r.cardId, message: r.message ?? (r.ok ? 'spawned' : 'failed') }
    },
  }

  private readonly gate = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<GateDecision> => {
    const r = await this.dispatch('confirm', { toolName, input })
    return r.allow ? { allow: true } : { allow: false, reason: 'You denied this action.' }
  }

  /** Run one orchestrator turn for a chat prompt. */
  async run(prompt: string): Promise<void> {
    if (this.running) {
      this.emit({ kind: 'error', text: 'Still working on the previous request — one at a time.' })
      return
    }
    this.running = true
    try {
      await runOrchestrator({
        bus: this.bus,
        prompt,
        gate: this.gate,
        onEvent: (e) => this.emit(e),
      })
    } catch (e) {
      this.emit({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      this.running = false
    }
  }

  private emit(e: OrchestratorEvent): void {
    this.deps.send('orchestrator-event', e)
  }
}
