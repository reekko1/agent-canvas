import { useEffect, useState } from 'react'
import type { CanvasNode } from './nodes'

/// Polls each shell card's foreground command (tmux pane) so the phone can show
/// it on the list row — the same `paneCommand` the desktop's shell face reads,
/// lifted to a map keyed by card id. Agents speak for themselves (status/task),
/// so only shells are polled.
export function useShellCommands(nodes: CanvasNode[]): Record<string, string> {
  const [cmds, setCmds] = useState<Record<string, string>>({})
  const shellIds = nodes
    .filter((n) => n.type === 'card' && n.data.kind === 'shell')
    .map((n) => n.id)
  const key = shellIds.join('|')

  useEffect(() => {
    if (!shellIds.length) {
      setCmds({})
      return
    }
    let alive = true
    const tick = async (): Promise<void> => {
      const pairs = await Promise.all(
        shellIds.map(async (id) => [id, await window.canvas.paneCommand(id)] as const),
      )
      if (alive) setCmds(Object.fromEntries(pairs.filter(([, c]) => c)) as Record<string, string>)
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

  return cmds
}
