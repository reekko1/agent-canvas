import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MultiProjectSnapshot, Project } from '../shared/types'

/// Disk side of workspace persistence. The renderer owns canvas state and
/// pushes whole snapshots; this debounces them so a drag stream doesn't grind
/// the filesystem. On load it normalizes the file into a usable shape.
export class WorkspaceStore {
  private pending: MultiProjectSnapshot | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private file: string) {}

  async load(): Promise<MultiProjectSnapshot | null> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      return null // first run / unreadable → empty state (no projects)
    }
    const ws = raw as Record<string, unknown>
    if (!Array.isArray(ws.cards)) return null
    return normalize(ws as unknown as MultiProjectSnapshot)
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

/** Repair the invariants load relies on: `activeProjectId` points at a real
 *  project (or null when there are none), and each project references only
 *  cards that exist. Drops projects missing a dir — a project is a folder. */
function normalize(snap: MultiProjectSnapshot): MultiProjectSnapshot {
  const registry = (Array.isArray(snap.cards) ? snap.cards : []).filter(
    (c) =>
      typeof c.id === 'string' &&
      c.id.length > 0 &&
      typeof c.folder === 'string' &&
      (c.kind === 'agent' || c.kind === 'shell' || c.kind === 'browser'),
  )
  const known = new Set(registry.map((c) => c.id))
  const projects: Project[] = (Array.isArray(snap.projects) ? snap.projects : [])
    .filter(
      (p) =>
        typeof p.id === 'string' &&
        p.id.length > 0 &&
        typeof p.name === 'string' &&
        typeof p.dir === 'string' &&
        p.dir.length > 0,
    )
    .map((p) => ({
      ...p,
      cardIds: (p.cardIds ?? []).filter((id) => known.has(id)),
      focusedCardId: p.focusedCardId && known.has(p.focusedCardId) ? p.focusedCardId : undefined,
    }))
  // Drop ghost cards — registry entries no surviving project references.
  // Mounting one would respawn a tmux session for a card on no canvas.
  const onACanvas = new Set(projects.flatMap((p) => p.cardIds))
  const cards = registry.filter((c) => onACanvas.has(c.id))
  const activeProjectId = projects.some((p) => p.id === snap.activeProjectId)
    ? snap.activeProjectId
    : (projects[0]?.id ?? null)
  return { cards, projects, activeProjectId }
}
