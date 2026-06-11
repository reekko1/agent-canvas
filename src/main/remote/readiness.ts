import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import type { AppReadiness, RemoteReadiness } from '../../shared/types'

/// Environment probe for the remote-access setup: is the tailscale CLI on
/// this Mac, and is `tailscale serve` currently proxying the panel's port?
/// (Port of the Swift Readiness, scoped to the tailscale chapter.)

/** Where the tailscale CLI actually lands: the Mac app's bundled binary,
 *  Homebrew (either arch), MacPorts, Nix — probed directly because a GUI
 *  app's PATH has none of them. */
const TAILSCALE_PATHS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/local/bin/tailscale',
  '/run/current-system/sw/bin/tailscale',
  `${homedir()}/.nix-profile/bin/tailscale`,
]

function findTailscale(): string | undefined {
  return TAILSCALE_PATHS.find((p) => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/** Is `tailscale serve` proxying our remote port? Resolves the tailnet HTTPS
 *  URL when it is, undefined otherwise. `serve status` prints blank-line-
 *  separated route blocks (public URL, then its proxy target); we find the
 *  block whose proxy is our loopback port and take *its* URL — the first URL
 *  in the whole output may be someone else's route. */
function probeServe(binary: string, port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(binary, ['serve', 'status'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(undefined)
        return
      }
      const block = stdout
        .split(/\n\s*\n/)
        .find((b) => b.includes(`127.0.0.1:${port}`) || b.includes(`localhost:${port}`))
      resolve(block?.split(/\s+/).find((w) => w.startsWith('https://')))
    })
  })
}

/** tmux's install homes — kept in sync with Tmux.prepare's probe list. */
const TMUX_PATHS = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/opt/local/bin/tmux',
  '/usr/bin/tmux',
  '/run/current-system/sw/bin/tmux',
  `${homedir()}/.nix-profile/bin/tmux`,
]

/** Homebrew's two install homes (Apple silicon, Intel). */
const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']

function executableAt(paths: string[]): boolean {
  return paths.some((p) => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/** Spawns the user's login shell — the exact way a card spawns the agent —
 *  so the answer matches what launching would actually find. */
function probeClaude(): Promise<boolean> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL ?? '/bin/zsh'
    execFile(shell, ['-lc', 'command -v claude'], { timeout: 10000 }, (err) => resolve(!err))
  })
}

export async function checkAppReadiness(): Promise<AppReadiness> {
  return {
    claudeFound: await probeClaude(),
    tmuxFound: executableAt(TMUX_PATHS),
    brewFound: executableAt(BREW_PATHS),
  }
}

export async function checkRemoteReadiness(panelPort: number): Promise<RemoteReadiness> {
  const tailscale = findTailscale()
  const tailnetURL =
    tailscale && panelPort > 0 ? await probeServe(tailscale, panelPort) : undefined
  return {
    panelPort,
    tailscaleFound: tailscale !== undefined,
    tailscaleServing: tailnetURL !== undefined,
    tailnetURL,
  }
}
