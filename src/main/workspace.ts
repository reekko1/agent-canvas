import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WorkspaceSnapshot } from '../shared/types'

/// Disk side of workspace persistence (port of the Swift Workspace struct).
/// The renderer owns canvas state and pushes whole snapshots; this debounces
/// them so a drag stream doesn't grind the filesystem.
export class WorkspaceStore {
  private pending: WorkspaceSnapshot | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private file: string) {}

  load(): WorkspaceSnapshot | null {
    try {
      const ws = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(ws.items)) return ws as WorkspaceSnapshot
    } catch {
      // first run / unreadable → blank canvas
    }
    return null
  }

  save(snapshot: WorkspaceSnapshot): void {
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
