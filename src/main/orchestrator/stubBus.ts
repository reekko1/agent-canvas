// An in-memory CommandBus double for exercising the orchestrator without the real
// app — used by the offline harness (harness.ts). The live bus is mainBus.ts. The
// seeded world mimics two canvases with a blocked agent.
import type {
  ActionResult,
  AgentReplyResult,
  CommandBus,
  SpawnAgentInput,
  SpawnBrowserInput,
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
      const name = input.name?.trim() || `Agent ${world.cards.length + 1}`
      world.cards.push({
        id,
        name,
        kind: 'agent',
        status: 'idle',
        task: input.prompt,
        canvasId,
        canvasName: cv.name,
      })
      const tail = input.prompt ? ` with initial prompt: "${input.prompt}"` : ''
      return { ok: true, cardId: id, message: `spawned ${name} (${id}) on ${cv.name}${tail}` }
    },

    async openBrowser(input: SpawnBrowserInput): Promise<SpawnResult> {
      const canvasId = input.canvasId ?? active
      const cv = world.canvases.find((c) => c.id === canvasId)
      if (!cv) return { ok: false, message: `no canvas with id ${canvasId}` }
      const id = `cd_new${++counter}`
      const name = input.name?.trim() || `Browser ${world.cards.length + 1}`
      world.cards.push({ id, name, kind: 'browser', status: 'idle', url: input.url, canvasId, canvasName: cv.name })
      const tail = input.url ? ` at ${input.url}` : ''
      return { ok: true, cardId: id, message: `opened ${name} (${id}) on ${cv.name}${tail}` }
    },

    async navigateBrowser(cardId: string, url: string): Promise<ActionResult> {
      const card = world.cards.find((c) => c.id === cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      if (card.kind !== 'browser') return { ok: false, message: `${card.name} is not a browser` }
      card.url = url
      return { ok: true, message: `pointed ${card.name} at ${url}` }
    },

    async sendToAgent(cardId: string, message: string): Promise<ActionResult> {
      const card = world.cards.find((c) => c.id === cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      if (card.kind !== 'agent') return { ok: false, message: `${card.name} is a shell, not an agent` }
      return { ok: true, message: `sent to ${card.name}: "${message}"` }
    },

    async getAgentReply(cardId: string): Promise<AgentReplyResult> {
      const card = world.cards.find((c) => c.id === cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      return {
        ok: true,
        reply: `(stub) ${card.name}: finished ${card.task ?? 'the task'}.`,
        message: `last reply from ${card.name}`,
      }
    },

    async renameAgent(cardId: string, name: string): Promise<ActionResult> {
      const card = world.cards.find((c) => c.id === cardId)
      if (!card) return { ok: false, message: `no card with id ${cardId}` }
      const clean = name.trim()
      if (!clean) return { ok: false, message: 'name cannot be empty' }
      card.name = clean
      return { ok: true, message: `renamed to ${clean}` }
    },

    async killCard(cardId: string): Promise<ActionResult> {
      const i = world.cards.findIndex((c) => c.id === cardId)
      if (i < 0) return { ok: false, message: `no card with id ${cardId}` }
      const [card] = world.cards.splice(i, 1)
      return { ok: true, message: `closed ${card.name} (${cardId})` }
    },

    async approveAsk(askId: string, decision: 'allow' | 'deny'): Promise<ActionResult> {
      const i = world.approvals.findIndex((a) => a.id === askId)
      if (i < 0) return { ok: false, message: `no pending ask with id ${askId}` }
      const [ask] = world.approvals.splice(i, 1)
      world.needsYou = Math.max(0, world.needsYou - 1)
      return { ok: true, message: `${decision === 'allow' ? 'approved' : 'denied'} ${ask.name}'s request` }
    },
  }
}
