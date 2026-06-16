import { useEffect, useState } from 'react'
import type { CanvasNode } from './nodes'

/** A shell card's live title bits: the foreground command and the pane's cwd
 *  (which follows the user's `cd`s) — mirrors the desktop's useShellTitle. */
export interface ShellTitle {
  running?: string
  cwd?: string
}

/// Polls each shell card's pane for its command + cwd so the phone's rows match
/// the desktop: the title follows the directory the shell is actually in, and
/// the activity slot shows what's running. Keyed by card id. Agents speak for
/// themselves (status/task), so only shells are polled.
export function useShellTitles(nodes: CanvasNode[]): Record<string, ShellTitle> {
  const [titles, setTitles] = useState<Record<string, ShellTitle>>({})
  const shellIds = nodes
    .filter((n) => n.type === 'card' && n.data.kind === 'shell')
    .map((n) => n.id)
  const key = shellIds.join('|')

  useEffect(() => {
    if (!shellIds.length) {
      setTitles({})
      return
    }
    let alive = true
    const tick = async (): Promise<void> => {
      const pairs = await Promise.all(
        shellIds.map(
          async (id) =>
            [
              id,
              {
                running: (await window.canvas.paneCommand(id)) ?? undefined,
                cwd: (await window.canvas.paneCwd(id)) ?? undefined,
              },
            ] as const,
        ),
      )
      if (alive) setTitles(Object.fromEntries(pairs))
    }
    void tick()
    const t = setInterval(() => void tick(), 1500)
    return () => {
      alive = false
      clearInterval(t)
    }
    // shellIds is captured via `key`; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return titles
}
