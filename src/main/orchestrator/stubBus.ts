// An in-memory CommandBus for exercising the orchestrator without the real app.
// Slice 2 replaces this with a `mainBus` reading live RemoteState + dispatching
// to the renderer. The seeded world mimics two canvases with a blocked agent.
import type {
  ActionResult,
  CommandBus,
  SpawnAgentInput,
  SpawnResult,
  World,
} from './contract'

export function makeStubBus(): CommandBus {
  const world: World = {
    canvases: [
      { id: 'cv_alpha', name: 'alpha-api', attention: 'blocking', dirty: 3, branch: 'main' },
      { id: 'cv_beta', name: 'beta-web', attention: 'none', dirty: 0, branch: 'feat/login' },
    ],
    cards: [
      { id: 'cd_1', name: 'auth refactor', kind: 'agent', status: 'blocked', task: 'waiting on a permission', canvasId: 'cv_alpha', canvasName: 'alpha-api' },
      { id: 'cd_2', name: 'shell', kind: 'shell', status: 'idle', canvasId: 'cv_alpha', canvasName: 'alpha-api' },
      { id: 'cd_3', name: 'login page', kind: 'agent', status: 'running', task: 'building the form', canvasId: 'cv_beta', canvasName: 'beta-web' },
    ],
    approvals: [
      { id: 'ask_1', name: 'auth refactor', detail: 'Bash: rm -rf build/', canvasId: 'cv_alpha' },
    ],
    needsYou: 1,
  }
  let active = 'cv_alpha'
  let counter = 0

  return {
    async listWorld(): Promise<World> {
      return structuredClone(world)
    },

    async focusCanvas(canvasId: string): Promise<ActionResult> {
      const cv = world.canvases.find((c) => c.id === canvasId)
      if (!cv) return { ok: false, message: `no canvas with id ${canvasId}` }
      active = canvasId
      return { ok: true, message: `active canvas is now ${cv.name}` }
    },

    async spawnAgent(input: SpawnAgentInput): Promise<SpawnResult> {
      const canvasId = input.canvasId ?? active
      const cv = world.canvases.find((c) => c.id === canvasId)
      if (!cv) return { ok: false, message: `no canvas with id ${canvasId}` }
      const id = `cd_new${++counter}`
      world.cards.push({
        id,
        name: 'new agent',
        kind: 'agent',
        status: 'idle',
        task: input.prompt,
        canvasId,
        canvasName: cv.name,
      })
      const tail = input.prompt ? ` with initial prompt: "${input.prompt}"` : ''
      return { ok: true, cardId: id, message: `spawned agent ${id} on ${cv.name}${tail}` }
    },
  }
}
