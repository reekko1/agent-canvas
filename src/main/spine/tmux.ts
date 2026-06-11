import { execFile } from 'node:child_process'
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/// The session substrate: every card's process runs inside a tmux session on a
/// canvas-owned tmux server — the user's own tmux server and ~/.tmux.conf are
/// never touched. The card's terminal runs the tmux *client* (`new-session -A`
/// creates or reattaches), so quitting the app merely detaches and the fleet
/// keeps working. No tmux installed → callers fall back to direct spawn.
/// (Port of the Swift Tmux enum; facts verified against tmux 3.6.)
export class Tmux {
  binary: string | null = null
  private confPath: string | null = null

  constructor(
    private dir: string,
    readonly socket: string,
  ) {}

  /** Probe the binary at fixed install locations (a GUI app's PATH has none of
   *  them) and write the canvas-owned config. Call once at spine start. */
  prepare(): void {
    const probes = [
      '/opt/homebrew/bin/tmux',
      '/usr/local/bin/tmux',
      '/opt/local/bin/tmux',
      '/usr/bin/tmux',
      '/run/current-system/sw/bin/tmux',
      join(homedir(), '.nix-profile/bin/tmux'),
    ]
    this.binary =
      probes.find((p) => {
        try {
          accessSync(p, constants.X_OK)
          return true
        } catch {
          return false
        }
      }) ?? null
    if (!this.binary) {
      console.log('[tmux] not found — agents will not survive app restarts (brew install tmux)')
      return
    }
    // Minimal by intent: no status bar (the card chrome is the status bar),
    // no Esc delay (Esc is interrupt in the claude TUI), generous scrollback.
    const conf = `# Agent Canvas — governs only the '${this.socket}' socket; your ~/.tmux.conf is untouched.
set -g status off
set -s escape-time 0
set -g default-terminal "xterm-256color"
set -g history-limit 50000
set -g focus-events on
`
    try {
      mkdirSync(this.dir, { recursive: true })
      const p = join(this.dir, 'tmux.conf')
      writeFileSync(p, conf)
      this.confPath = p
      console.log(`[tmux] substrate ready (${this.binary})`)
    } catch (err) {
      console.error('[tmux] conf write failed — substrate off', err)
      this.binary = null
    }
  }

  /** The invocation a card's terminal runs: the tmux client, which attaches if
   *  the session survived a previous app run and otherwise creates it running
   *  `command`. `cardId` is stamped into the *session* env on creation (`-e`,
   *  tmux ≥ 3.2 — the client env is not enough, and sessions inherit the
   *  server's env, which belongs to whichever card started the server).
   *  Null when tmux is unavailable. */
  clientCommand(
    session: string,
    command: string,
    workdir: string,
    cardId: string | null,
  ): { file: string; args: string[] } | null {
    if (!this.binary || !this.confPath) return null
    return {
      file: this.binary,
      args: [
        '-L', this.socket,
        '-f', this.confPath,
        'new-session', '-A', '-s', session, '-c', workdir,
        '-e', `CANVAS_CARD_ID=${cardId ?? ''}`,
        command,
      ],
    }
  }

  /** Kill a session — the ✕-delete path, the one place the canvas ends an
   *  agent's life rather than just its view of it. */
  kill(session: string): void {
    if (!this.binary) return
    // `=name` forces an exact match — a bare -t prefix-matches, so card-1
    // would happily kill card-10.
    execFile(this.binary, ['-L', this.socket, 'kill-session', '-t', '=' + session], () => {})
  }

  /** Names of live sessions on the canvas socket (empty when no server runs). */
  liveSessions(): Promise<string[]> {
    return new Promise((resolve) => {
      if (!this.binary) return resolve([])
      execFile(this.binary, ['-L', this.socket, 'list-sessions', '-F', '#S'], (err, stdout) => {
        if (err) return resolve([])
        resolve(stdout.split('\n').filter(Boolean))
      })
    })
  }
}
