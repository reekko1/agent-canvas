import { Minus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/// The shared frame for a right-edge side sheet (diff / vision / issues). One
/// calm treatment so the three siblings are indistinguishable as objects: a
/// hairline border, a single soft shadow for lift over the busy canvas, and a
/// flush header separated from the body by a bottom rule — no filled toolbar, no
/// heavy 2px outline. The `title` is a node (each sheet owns its own
/// typography — a mono path for the diff, a sans heading for the boards);
/// everything else (the chrome, the window controls) is identical.
export function SheetShell({
  title,
  subtitle,
  trailing,
  onCollapse,
  onClose,
  bodyClassName,
  children,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Header content before the window controls (e.g. the diffstat). */
  trailing?: React.ReactNode
  onCollapse?: () => void
  onClose?: () => void
  bodyClassName?: string
  children: React.ReactNode
}) {
  const hasControls = !!onCollapse || !!onClose
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-baseline gap-2">
          {title}
          {subtitle && (
            <span className="truncate text-[11px] text-muted-foreground">{subtitle}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {trailing}
          {trailing && hasControls && <span className="mx-1 h-4 w-px bg-border" />}
          {onCollapse && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onCollapse}
              title="Minimize"
              aria-label="Minimize"
            >
              <Minus />
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >
              <X />
            </Button>
          )}
        </div>
      </header>
      <div className={cn('min-h-0 flex-1 overflow-hidden', bodyClassName)}>{children}</div>
    </div>
  )
}
