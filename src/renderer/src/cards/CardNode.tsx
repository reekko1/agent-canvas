import { Bot, Globe, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { basenameOf } from '@/lib/utils'
import type { ShellTitle } from '@/canvas/useShellTitles'
import { STATUS_COLORS, type CardData } from './meta'
import { TerminalView } from './TerminalView'
import { BrowserView } from './BrowserView'
import { PosterFace } from './PosterFace'
import { ShellFace } from './ShellFace'
import { BrowserFace } from './BrowserFace'

/** The host of a browser card's url — its default chrome label. */
function hostOf(url?: string): string {
  if (!url) return 'New tab'
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/// One agent on the canvas: status-tinted chrome around a live terminal. As
/// the master it shows the terminal; in the stack a compact poster overlays
/// the (still-mounted) terminal, and clicking it promotes the card. The xterm
/// instance never unmounts across that switch — `stacked` only toggles which
/// face composites.
export function CardNode({
  id,
  data,
  stacked,
  dormant,
  ownerName,
  onFlyToOwner,
  browserThumb,
  title,
}: {
  id: string
  data: CardData
  stacked: boolean
  /** Browser card evicted by the webview budget — its guest is unmounted (the
   *  snapshot face shows). Always implies `stacked` (the master is never evicted). */
  dormant?: boolean
  /** For a browser opened by an agent: the owner's display name (a window-bar
   *  chip that flies to it). Undefined for hand/orchestrator-opened browsers. */
  ownerName?: string
  /** Promote/reveal this browser's owning agent. */
  onFlyToOwner?: () => void
  /** For an agent that owns a browser: a thumbnail of what that browser shows,
   *  surfaced on its poster ("what my agent is looking at"). */
  browserThumb?: string
  /** Live shell-pane title bits (command + cwd) from the global useShellTitles
   *  poll — undefined for agent cards and for a shell before its first poll. */
  title?: ShellTitle
}) {
  const { meta, folder, kind } = data
  const isShell = kind === 'shell'
  const isBrowser = kind === 'browser'
  // Neither a shell nor a browser has an agent to speak for it — calm, neutral
  // chrome always (no status colour, no loud pulse).
  const neutral = isShell || isBrowser
  const color = neutral ? 'var(--border)' : STATUS_COLORS[meta.status]
  const running = title?.running ?? null
  const cwd = title?.cwd ?? null
  // Shells follow their pane's working directory as the user cd's around; agents
  // (and a shell before its first poll) fall back to where the card was opened.
  const folderName = basenameOf((isShell && cwd) || folder) ?? folder
  // Agents show their (renameable) name; a browser shows its page title/host;
  // shells follow the pane folder.
  const displayName = isBrowser
    ? data.name || data.title || hostOf(data.url)
    : (!isShell && data.name) || folderName

  return (
    <div
      className={`relative flex h-full w-full flex-col overflow-hidden border-2 shadow-2xl ${
        // Shell = a squarer terminal screen; browser = a squarer page surface;
        // agent = a soft poster.
        isShell ? 'rounded-lg bg-terminal' : isBrowser ? 'rounded-lg bg-card' : 'rounded-2xl bg-card'
      }`}
      style={{ borderColor: color }}
    >
      <div
        className={`flex items-center gap-2.5 px-3 py-1.5 font-mono text-xs ${
          // Shell chrome melts into the screen; agent/browser chrome is a bar.
          isShell
            ? 'border-b border-border/40 bg-terminal text-terminal-foreground/80'
            : 'bg-muted text-foreground/80'
        }`}
      >
        {/* Identity mark: a bot for the agent, >_ for shells, the page favicon
            (falling back to a globe) for browsers. */}
        {isShell ? (
          <span className="font-bold text-muted-foreground/70" aria-hidden>
            {'>_'}
          </span>
        ) : isBrowser ? (
          data.favicon ? (
            <img src={data.favicon} alt="" className="size-3.5 shrink-0 rounded-sm" />
          ) : (
            <Globe className="size-3.5 text-muted-foreground/70" aria-hidden />
          )
        ) : (
          <Bot className="size-3.5 text-muted-foreground/70" aria-hidden />
        )}
        <span className="truncate text-muted-foreground">{displayName}</span>
        {/* Shell/browser bars carry no agent task line — but a browser opened by
            an agent shows that agent's stated reason (provenance), not a task. */}
        <span className="flex-1 truncate">
          {isBrowser ? (data.reason ?? '') : neutral ? '' : (meta.task ?? meta.detail ?? '')}
        </span>
        {/* Provenance chip: who opened this browser — click to fly to that agent. */}
        {isBrowser && ownerName && (
          <button
            className="shrink-0 rounded bg-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-border hover:text-foreground"
            onClick={onFlyToOwner}
            title={`Opened by ${ownerName} — click to view it`}
          >
            {ownerName}
          </button>
        )}
        {meta.model && <span className="text-muted-foreground">{meta.model}</span>}
        {meta.permissionMode === 'bypassPermissions' && (
          <span className="font-bold text-status-error">BYPASS</span>
        )}
        {/* Status HUD on the right — a live dot reading out the agent's state. */}
        {!neutral && (
          <span className="flex items-center gap-1.5 font-bold" style={{ color }}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
            {meta.status.toUpperCase()}
          </span>
        )}
        <span className="mx-1 h-4 w-px bg-border" />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => data.onClose(id)}
          title="Delete card (kills its tmux session)"
          aria-label="Delete card"
        >
          <X />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {isBrowser ? (
          <BrowserView
            cardId={id}
            url={data.url}
            goto={data.goto}
            // A stacked browser hides its live page (the snapshot face covers it);
            // the guest stays mounted so the page survives.
            hidden={stacked}
            interactive={!stacked}
            // Evicted by the budget: the guest is dropped entirely (face covers it).
            dormant={!!dormant}
            onNavigate={data.onNavigate}
          />
        ) : (
          <TerminalView
            cardId={id}
            folder={folder}
            kind={kind}
            // A stacked shell shows its live terminal as the preview; only the
            // agent poster covers its terminal.
            hidden={stacked && !isShell}
            // Stacked terminals are inert — the promote button owns the cursor,
            // so a drag can't start an xterm selection instead of expanding.
            interactive={!stacked}
            onEngage={() => data.onEngage(id)}
          />
        )}
        {stacked && (
          <button
            className="absolute inset-0 block cursor-pointer border-none bg-transparent p-0 text-left"
            onClick={() => data.onPromote(id)}
            title="Open in the main view"
          >
            {isBrowser ? (
              <BrowserFace snapshot={data.snapshot} />
            ) : isShell ? (
              <ShellFace running={running} />
            ) : (
              <PosterFace meta={meta} browserThumb={browserThumb} />
            )}
          </button>
        )}
      </div>
    </div>
  )
}
