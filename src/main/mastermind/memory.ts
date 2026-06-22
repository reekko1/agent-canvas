// Event-sourced memory (two stores), materialized in-memory, single-arbiter apply.
// Mirrors issueStore: append-only ops -> materialize -> render snapshot for the
// reactor's system prompt. `remove` is just an event, so history is preserved
// (recoverability is free). OPERATOR is global; PRODUCT is per-project (keyed by
// canvas id) — the one structural change from the probe, which had a single product
// store. Product functions therefore take a projectId.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { operatorMemoryPath, productMemoryPath } from './paths'

export type Store = 'operator' | 'product'
export type MemOp = 'add' | 'replace' | 'remove'
export interface MemWrite {
  store: Store
  op: MemOp
  target?: string
  text?: string
}
interface MemEvent extends MemWrite {
  ts: number
  source: string
}

export const BUDGET: Record<Store, number> = { operator: 2000, product: 4000 }

const logPath = (store: Store, projectId?: string): string => {
  if (store === 'operator') return operatorMemoryPath()
  if (!projectId) throw new Error('product memory requires a projectId')
  return productMemoryPath(projectId)
}

function readEvents(store: Store, projectId?: string): MemEvent[] {
  const p = logPath(store, projectId)
  if (!existsSync(p)) return []
  const events: MemEvent[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line) as MemEvent)
    } catch {
      console.warn('[mastermind] skipping unparseable memory line')
    }
  }
  return events
}

// Replay the log into the current entry set. Pure projection of the event log.
function project(events: MemWrite[]): { entries: string[]; error?: string } {
  const entries: string[] = []
  for (const e of events) {
    if (e.op === 'add') {
      if (!e.text) return { entries, error: 'add without text' }
      entries.push(e.text)
    } else if (e.op === 'replace') {
      if (!e.target || !e.text) return { entries, error: 'replace needs target+text' }
      const i = entries.findIndex((x) => x.includes(e.target!))
      if (i < 0) return { entries, error: `replace target not found: "${e.target}"` }
      entries[i] = e.text
    } else if (e.op === 'remove') {
      if (!e.target) return { entries, error: 'remove needs target' }
      const i = entries.findIndex((x) => x.includes(e.target!))
      if (i < 0) return { entries, error: `remove target not found: "${e.target}"` }
      entries.splice(i, 1)
    } else {
      return { entries, error: `unknown op "${(e as MemWrite).op}"` }
    }
  }
  return { entries }
}

export function materialize(store: Store, projectId?: string): string[] {
  return project(readEvents(store, projectId)).entries
}
export function snapshot(store: Store, projectId?: string): string {
  return materialize(store, projectId).join('\n')
}
export function used(store: Store, projectId?: string): number {
  return snapshot(store, projectId).length
}
export function remaining(store: Store, projectId?: string): number {
  return BUDGET[store] - used(store, projectId)
}

// Single-arbiter apply: validate the whole plan against FINAL state (per store), then
// commit. Atomic — if any store would break (missing target / over budget), nothing is
// written. `projectId` is required iff the batch touches the product store.
export function applyMemoryOps(
  writes: MemWrite[],
  source: string,
  projectId?: string,
): { ok: boolean; error?: string } {
  const byStore = new Map<Store, MemWrite[]>()
  for (const w of writes) {
    if (!byStore.has(w.store)) byStore.set(w.store, [])
    byStore.get(w.store)!.push(w)
  }
  for (const [store, ops] of byStore) {
    const pid = store === 'product' ? projectId : undefined
    const { entries, error } = project([
      ...materialize(store, pid).map((t) => ({ store, op: 'add' as const, text: t })),
      ...ops,
    ])
    if (error) return { ok: false, error: `${store}: ${error}` }
    const finalLen = entries.join('\n').length
    if (finalLen > BUDGET[store]) return { ok: false, error: `${store} over budget: ${finalLen}/${BUDGET[store]}` }
  }
  for (const w of writes) {
    const pid = w.store === 'product' ? projectId : undefined
    const p = logPath(w.store, pid)
    mkdirSync(dirname(p), { recursive: true })
    const ev: MemEvent = { ...w, ts: Date.now(), source }
    appendFileSync(p, JSON.stringify(ev) + '\n')
  }
  return { ok: true }
}
