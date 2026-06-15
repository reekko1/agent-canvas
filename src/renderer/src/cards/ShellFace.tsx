/// A stacked shell card's header strip. The shell's compact preview is the live
/// terminal itself — the actual process, painting right there behind this strip
/// — so all this adds is the running command, pinned to the top like a prompt.
/// The folder reads in the window bar, so it isn't echoed. Monochrome by
/// identity: colour on this canvas means an agent needs you, never a shell.
export function ShellFace({ running }: { running: string | null }) {
  return (
    <div className="absolute inset-x-0 top-0 z-10 flex items-baseline gap-2 border-b border-border/40 bg-terminal px-3 py-2 font-mono text-[13px] leading-snug text-terminal-foreground">
      <span className="text-terminal-foreground/40">❯</span>
      {running ? (
        <span className="truncate text-terminal-foreground">{running}</span>
      ) : (
        <span className="text-terminal-foreground/40">idle</span>
      )}
    </div>
  )
}
