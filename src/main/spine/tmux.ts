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
    // Mouse on is what makes wheel-scroll work at all: tmux holds the
    // history (xterm only ever sees tmux's alternate screen), and wheel-up
    // over a non-mouse app enters copy-mode and scrolls it.
    const conf = `# Agent Canvas — governs only the '${this.socket}' socket; your ~/.tmux.conf is untouched.
set -g status off
set -s escape-time 0
set -g default-terminal "xterm-256color"
set -g history-limit 50000
set -g focus-events on
# Shared attach (phone + desktop on one session): size to whoever's driving,
# not the smallest client, so a phone client doesn't shrink the desktop when
# it's idle. With a single client this is identical to today.
set -g window-size latest
setw -g aggressive-resize on
# Mouse is on for SCROLLBACK ONLY. Selection never reaches tmux: the
# renderer strips mouse-tracking sequences before xterm sees them (so
# drags select natively, like any normal terminal) and synthesizes wheel
# reports itself — wheels are the only mouse events that ever arrive.
# One line per report keeps trackpads smooth; -He hides the position
# indicator and auto-exits at the bottom. Esc / q also exit; typing exits
# via the renderer (it cancels copy-mode before delivering the keystroke).
set -g mouse on
bind -T root WheelUpPane if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send -M } { copy-mode -He ; send -X scroll-up }
bind -T copy-mode WheelUpPane send -X scroll-up
bind -T copy-mode WheelDownPane send -X scroll-down
bind -T copy-mode-vi WheelUpPane send -X scroll-up
bind -T copy-mode-vi WheelDownPane send -X scroll-down
bind -T copy-mode Escape send -X cancel
bind -T copy-mode-vi Escape send -X cancel
`
    try {
      mkdirSync(this.dir, { recursive: true })
      const p = join(this.dir, 'tmux.conf')
      writeFileSync(p, conf)
      this.confPath = p
      // A server may already be running with older settings (sessions outlive
      // the app) — re-source the conf so changes land without a fleet restart.
      // No server → execFile errors → ignored.
      execFile(this.binary, ['-L', this.socket, 'source-file', p], () => {})
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

  /** A second client attaching to an EXISTING card session — the mobile
   *  terminal. `attach-session` (not `new-session -A`) so a phone never
   *  accidentally creates a session; tmux is multi-client, so this mirrors the
   *  desktop live. Null when tmux is unavailable. */
  attachCommand(session: string): { file: string; args: string[] } | null {
    if (!this.binary || !this.confPath) return null
    return {
      file: this.binary,
      args: ['-L', this.socket, '-f', this.confPath, 'attach-session', '-t', session],
    }
  }

  /** Leave copy-mode (scrollback) in a session, if it's in it. The renderer
   *  calls this before delivering the first keystroke after a wheel-scroll,
   *  so typing lands in the app, never in copy-mode. Resolves once the tmux
   *  server has processed it — the caller may then write the keystroke.
   *  Not in copy-mode → tmux errors → ignored. */
  cancelCopyMode(session: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.binary) return resolve()
      execFile(
        this.binary,
        ['-L', this.socket, 'send-keys', '-t', '=' + session, '-X', 'cancel'],
        () => resolve(),
      )
    })
  }

  /** Kill a session — the ✕-delete path, the one place the canvas ends an
   *  agent's life rather than just its view of it. */
  kill(session: string): void {
    if (!this.binary) return
    // `=name` forces an exact match — a bare -t prefix-matches, so card-1
    // would happily kill card-10.
    execFile(this.binary, ['-L', this.socket, 'kill-session', '-t', '=' + session], () => {})
  }

  /** Run `display-message -p` against a session's active pane and return the
   *  formatted result (trimmed), or null if the session is gone / tmux absent.
   *  `=session:` exact-matches the session — no prefix bleed, the same guard
   *  `kill` relies on — while the trailing colon makes display-message read it
   *  as a session target and resolve the active pane; without it, `=name`
   *  parses as a *window* name and matches nothing. */
  private query(session: string, format: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.binary) return resolve(null)
      execFile(
        this.binary,
        ['-L', this.socket, 'display-message', '-p', '-t', `=${session}:`, format],
        (err, stdout) => resolve(err ? null : stdout.trim() || null),
      )
    })
  }

  /** The command running in a session's pane — the shell card's "what's
   *  running" title. tmux's `#{pane_current_command}` only gives the foreground
   *  *process name* (`node` for `npm run dev`), so we go one better: take the
   *  pane's shell pid + tty, then read the shell's foreground child off that
   *  tty (see `foregroundCommand`) — that child's argv is the line the user
   *  typed. Null when idle, the session is gone, or tmux/ps is unavailable.
   *  Observe-only: two reads, never a mutation — honors the bare-shell card's
   *  no-orchestration contract. */
  async paneCommand(session: string): Promise<string | null> {
    const info = await this.query(session, '#{pane_pid} #{pane_tty}')
    if (!info) return null
    const [pidStr, tty] = info.split(' ')
    const shellPid = Number(pidStr)
    if (!shellPid || !tty) return null
    return foregroundCommand(tty, shellPid)
  }

  /** The pane's current working directory — follows the user's `cd`s, feeding
   *  the shell card's title. tmux tracks this per pane (`#{pane_current_path}`),
   *  so it's a single read. Null when the session is gone or tmux is absent. */
  paneCwd(session: string): Promise<string | null> {
    return this.query(session, '#{pane_current_path}')
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

/** Read a tty's process table and pick out the command the user ran in it.
 *  Null if `ps` is unavailable or the shell sits idle at its prompt. */
function foregroundCommand(tty: string, shellPid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-t', tty.replace(/^\/dev\//, ''), '-o', 'pid=,ppid=,stat=,command='],
      (err, stdout) => resolve(err ? null : foregroundChild(stdout, shellPid)),
    )
  })
}

/** Pure: pick the typed command out of `ps -o pid,ppid,stat,command` output.
 *  The typed command is the shell's direct child that sits in the tty's
 *  foreground process group (`+` in STAT) — e.g. `npm run dev`, whose own
 *  `node`/`next-server` descendants hang off it but aren't children of the
 *  shell. None → the shell itself is foreground, i.e. idle (returns null). A
 *  pipeline (`a | b`) leaves several such children; the earliest-started
 *  (lowest pid, the head of the pipe) is the one worth showing. */
function foregroundChild(psOut: string, shellPid: number): string | null {
  const kids = psOut
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], command: m[4] }))
    .filter((p) => p.ppid === shellPid && p.stat.includes('+'))
    .sort((a, b) => a.pid - b.pid)
  return kids[0]?.command ?? null
}
