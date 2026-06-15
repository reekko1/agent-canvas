import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  type CardRecord,
  type MultiProjectSnapshot,
  type Project,
  type WorkspaceSnapshot,
} from '../shared/types'

/// Disk side of workspace persistence (port of the Swift Workspace struct).
/// The renderer owns canvas state and pushes whole snapshots; this debounces
/// them so a drag stream doesn't grind the filesystem. On load it upgrades a
/// legacy single-canvas file into the multi-project shape.
export class WorkspaceStore {
  private pending: MultiProjectSnapshot | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private file: string) {}

  load(): MultiProjectSnapshot | null {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // first run / unreadable → blank canvas (renderer seeds a default project)
      return null
    }
    const ws = raw as Record<string, unknown>
    // Already the new shape → normalize and return.
    if (Array.isArray(ws.cards)) return normalize(ws as unknown as MultiProjectSnapshot)
    // Legacy single-canvas shape → back up once, then migrate.
    if (Array.isArray(ws.items)) {
      this.backupLegacy()
      return normalize(migrate(ws as unknown as WorkspaceSnapshot))
    }
    return null
  }

  /** Preserve the pre-migration file once, so a bad migration is recoverable
   *  while the refactor is in flight. */
  private backupLegacy(): void {
    const bak = `${this.file}.legacy.bak`
    try {
      if (!existsSync(bak)) copyFileSync(this.file, bak)
    } catch (err) {
      console.error('[workspace] legacy backup failed', err)
    }
  }

  save(snapshot: MultiProjectSnapshot): void {
    this.pending = snapshot
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.flush()
    }, 400)
  }

  /** Write whatever is pending now — the before-quit path. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.pending) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.pending, null, 2))
    } catch (err) {
      console.error('[workspace] save failed', err)
    }
    this.pending = null
  }
}

/** Upgrade a legacy `{items, viewport}` snapshot into the multi-project shape:
 *  drop frames and diffs (frames are removed; diffs are no longer persisted),
 *  lift every card/shell into the global registry carrying its transitional
 *  layout, and gather them under one Default project. */
function migrate(legacy: WorkspaceSnapshot): MultiProjectSnapshot {
  const cards: CardRecord[] = []
  for (const i of legacy.items) {
    if (!i.folder) continue // frames have no folder
    if (i.kind !== 'card' && i.kind !== 'shell') continue // diffs are not cards
    cards.push({
      id: i.id,
      folder: i.folder,
      kind: i.kind === 'shell' ? 'shell' : 'agent',
      session: i.session,
    })
  }
  const project: Project = {
    id: DEFAULT_PROJECT_ID,
    name: DEFAULT_PROJECT_NAME,
    cardIds: cards.map((c) => c.id),
    focusedCardId: cards[0]?.id,
  }
  return { cards, projects: [project], activeProjectId: DEFAULT_PROJECT_ID }
}

/** Repair invariants every load relies on: a durable Default project exists,
 *  `activeProjectId` points at a real project, and each project references only
 *  cards that exist. Cheap, and it turns a corrupt file into a usable one. */
function normalize(snap: MultiProjectSnapshot): MultiProjectSnapshot {
  const cards = Array.isArray(snap.cards) ? snap.cards : []
  const known = new Set(cards.map((c) => c.id))
  const projects: Project[] = (Array.isArray(snap.projects) ? snap.projects : []).map((p) => ({
    ...p,
    cardIds: (p.cardIds ?? []).filter((id) => known.has(id)),
    focusedCardId:
      p.focusedCardId && known.has(p.focusedCardId) ? p.focusedCardId : undefined,
  }))
  if (!projects.some((p) => p.id === DEFAULT_PROJECT_ID)) {
    projects.unshift({ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME, cardIds: [] })
  }
  const activeProjectId = projects.some((p) => p.id === snap.activeProjectId)
    ? snap.activeProjectId
    : DEFAULT_PROJECT_ID
  return { cards, projects, activeProjectId }
}
