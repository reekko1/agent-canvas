import { useEffect, useState } from 'react'
import type { Project, RepoIdentity } from '@shared/types'

/// Polls each canvas's repo for its branch + dirty count, keyed by project id.
/// Lightweight (one `git status` per canvas, ~3s) and decoupled from the diff
/// drawer, so the toolbar shows git identity for EVERY canvas, not just the
/// active one. Distinct dirs are de-duped so two canvases on the same repo cost
/// one call.
export function useCanvasGit(projects: Project[]): Record<string, RepoIdentity> {
  const [byProject, setByProject] = useState<Record<string, RepoIdentity>>({})

  // Re-key the poll on the set of (id → dir) pairs, so it restarts only when a
  // canvas is added/removed/renamed-folder — not on every card change.
  const key = projects.map((p) => `${p.id}:${p.dir}`).join('|')

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      const dirs = [...new Set(projects.map((p) => p.dir))]
      const results = await Promise.all(
        dirs.map(async (dir) => [dir, await window.canvas.repoIdentity(dir)] as const),
      )
      if (cancelled) return
      const byDir = new Map(results)
      setByProject(Object.fromEntries(projects.map((p) => [p.id, byDir.get(p.dir)!])))
    }
    void poll()
    const t = setInterval(() => void poll(), 3000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
    // key captures the dir set; projects is read inside but only its dirs matter.
  }, [key])

  return byProject
}
