import { gitSnapshot } from './git'
import type { GitSnapshot } from '../../shared/types'

/// Passively watches working trees by polling (port of the Swift DiffWatcher,
/// registry-shaped: one entry per live diff object). Each tick recomputes a
/// cheap signature and only delivers a full snapshot when the tree actually
/// changed — an idle repo costs one `git status` per interval, nothing more.
export class DiffWatchers {
  private entries = new Map<
    string,
    { folder: string; timer: NodeJS.Timeout; lastSignature?: string; running: boolean }
  >()

  constructor(
    private deliver: (diffId: string, snapshot: GitSnapshot) => void,
    private intervalMs = 1500,
  ) {}

  watch(diffId: string, folder: string): void {
    if (this.entries.has(diffId)) return
    const entry = {
      folder,
      timer: setInterval(() => void this.tick(diffId), this.intervalMs),
      running: false,
    }
    this.entries.set(diffId, entry)
    void this.tick(diffId) // deliver once immediately
  }

  unwatch(diffId: string): void {
    const e = this.entries.get(diffId)
    if (!e) return
    clearInterval(e.timer)
    this.entries.delete(diffId)
  }

  /** Refresh every watcher on a folder right now (e.g. after a git action)
   *  instead of waiting for the next poll. */
  poke(folder: string): void {
    for (const [id, e] of this.entries) if (e.folder === folder) void this.tick(id)
  }

  private async tick(diffId: string): Promise<void> {
    const e = this.entries.get(diffId)
    if (!e || e.running) return // a slow git never stacks ticks
    e.running = true
    try {
      const snap = await gitSnapshot(e.folder)
      // Re-check: unwatch may have raced the await.
      if (!this.entries.has(diffId) || snap.signature === e.lastSignature) return
      e.lastSignature = snap.signature
      this.deliver(diffId, snap)
    } finally {
      e.running = false
    }
  }
}
