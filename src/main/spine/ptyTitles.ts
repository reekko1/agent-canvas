import { execFile } from 'node:child_process'

/// Shell-card title helpers for a DIRECT pty (no tmux pane to query). Ported
/// from tmux.ts's foregroundCommand/foregroundChild ps-walkers, adapted to
/// start from a known shell pid (the pty's own pid) instead of resolving one
/// via a tmux pane query. Observe-only — honors the bare-shell card's
/// no-orchestration contract.

/** The command the user typed in a shell pty — its direct child sitting in
 *  the tty's foreground process group (`+` in STAT), e.g. `npm run dev`; that
 *  child's own descendants (node/next-server) aren't children of the shell.
 *  Null when the shell is idle at its prompt, or `pgrep`/`ps` is unavailable. */
export function foregroundCommand(shellPid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-P', String(shellPid)], (err, stdout) => {
      if (err) return resolve(null) // no children — idle at the prompt
      const pids = stdout.split('\n').filter(Boolean)
      if (!pids.length) return resolve(null)
      execFile('ps', ['-o', 'pid=,stat=,command=', '-p', pids.join(',')], (err2, out2) => {
        resolve(err2 ? null : foregroundChild(out2))
      })
    })
  })
}

/** Pure: pick the typed command out of `ps -o pid,stat,command` output for a
 *  shell's direct children. The foreground one carries `+` in STAT; a
 *  pipeline (`a | b`) leaves several, so the earliest-started (lowest pid,
 *  the head of the pipe) is the one worth showing. */
function foregroundChild(psOut: string): string | null {
  const kids = psOut
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), stat: m[2], command: m[3] }))
    .filter((p) => p.stat.includes('+'))
    .sort((a, b) => a.pid - b.pid)
  return kids[0]?.command ?? null
}

/** A pty's working directory, via `lsof`'s field-output mode (`-Fn` emits one
 *  `n<value>` line for the cwd fd). Null if the process is gone or `lsof` is
 *  unavailable. Follows the user's `cd`s (re-queried on each poll) since
 *  there's no tmux `#{pane_current_path}` to read for a direct pty. */
export function paneCwd(shellPid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(shellPid), '-d', 'cwd', '-Fn'], (err, stdout) => {
      if (err) return resolve(null)
      const line = stdout.split('\n').find((l) => l.startsWith('n'))
      resolve(line ? line.slice(1) : null)
    })
  })
}
