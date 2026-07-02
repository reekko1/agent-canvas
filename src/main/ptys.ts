import * as pty from 'node-pty'

export interface PtyHandlers {
  onData: (data: string) => void
  onExit: () => void
}

/** What a shell card's pty spawns — built by the `ensure-shell` IPC handler
 *  (a direct login shell, no tmux). */
export interface PtySpawnSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/// One direct PTY per SHELL card (no tmux — agent cards are headless
/// sessions, see spine.ts). Killing a pty here ends the shell outright; there
/// is no detach-vs-kill distinction without a session multiplexer underneath.
export class PtyRegistry {
  private ptys = new Map<string, pty.IPty>()

  has(cardId: string): boolean {
    return this.ptys.has(cardId)
  }

  spawn(cardId: string, spec: PtySpawnSpec, handlers: PtyHandlers, cols = 80, rows = 24): void {
    const p = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: spec.cwd,
      env: spec.env,
    })
    p.onData(handlers.onData)
    p.onExit(() => {
      this.ptys.delete(cardId)
      handlers.onExit()
    })
    this.ptys.set(cardId, p)
  }

  write(cardId: string, data: string): void {
    this.ptys.get(cardId)?.write(data)
  }

  resize(cardId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.ptys.get(cardId)?.resize(cols, rows)
  }

  kill(cardId: string): void {
    this.ptys.get(cardId)?.kill()
    this.ptys.delete(cardId)
  }

  /** The pty's own pid — feeds the shell-title ps-walk (there's no tmux pane
   *  to query anymore). Undefined if the card has no live pty. */
  pid(cardId: string): number | undefined {
    return this.ptys.get(cardId)?.pid
  }
}
