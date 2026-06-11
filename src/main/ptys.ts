import * as pty from 'node-pty'
import type { LaunchSpec } from './spine/spine'

export interface PtyHandlers {
  onData: (data: string) => void
  onExit: () => void
}

/// One PTY per card, running the tmux client (or the direct-spawn fallback).
/// Killing a pty here only detaches the tmux client — ending the *agent* is
/// Spine.killSession's job.
export class PtyRegistry {
  private ptys = new Map<string, pty.IPty>()

  spawn(cardId: string, spec: LaunchSpec, handlers: PtyHandlers): void {
    const p = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
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
}
