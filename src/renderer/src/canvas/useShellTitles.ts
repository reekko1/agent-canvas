import { useEffect, useState } from 'react'
import type { ShellTitle } from '@shared/types'
import type { CanvasNode } from './nodes'

export type { ShellTitle }

/// Polls each shell card's direct pty for its foreground command + cwd (a
/// ps-walk in main — there's no tmux pane to query) so the phone's rows match
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
    if (!shellIds.length) return
    let alive = true
    const tick = async (): Promise<void> => {
      const pairs = await Promise.all(
        shellIds.map(async (id) => [id, (await window.canvas.shellTitle(id)) ?? {}] as const),
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
  }, [key])

  return titles
}
