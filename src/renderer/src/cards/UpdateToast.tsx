import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import type { UpdateStatus } from '@shared/types'

/// The app's own auto-update toast, bottom-left so it never collides with the
/// per-agent AskToasts (bottom-center). Downloading shows a progress bar; once
/// the new version is staged it offers "Restart" to apply it now, or "Later"
/// to keep working (the update still installs on the next quit).
export function UpdateToast({
  update,
  onRestart,
  onDismiss,
}: {
  update: UpdateStatus | null
  onRestart: () => void
  onDismiss: () => void
}) {
  return (
    <div className="pointer-events-none fixed bottom-5 left-5 z-40 flex flex-col items-start gap-2">
      <AnimatePresence>
        {update && (
          <motion.div
            key="update"
            layout
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="pointer-events-auto w-72 max-w-[90vw] rounded-2xl border border-border/40 bg-background/75 p-3.5 shadow-lg shadow-black/15 backdrop-blur-xl"
          >
            {update.state === 'downloading' && (
              <>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-status-running" />
                  <span className="text-sm font-medium text-foreground">Downloading update</span>
                  {update.version && (
                    <span className="text-xs text-muted-foreground">v{update.version}</span>
                  )}
                </div>
                <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-muted/50">
                  <div
                    className="h-full rounded-full bg-status-running transition-[width] duration-300 ease-out"
                    style={{ width: `${Math.round(update.percent ?? 0)}%` }}
                  />
                </div>
              </>
            )}

            {update.state === 'ready' && (
              <>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-status-done" />
                  <span className="text-sm font-medium text-foreground">Update ready</span>
                  {update.version && (
                    <span className="text-xs text-muted-foreground">v{update.version}</span>
                  )}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Restart to install — or keep working and it applies on next quit.
                </p>
                <div className="mt-2.5 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={onDismiss}
                  >
                    Later
                  </Button>
                  <Button
                    size="sm"
                    className="bg-status-done text-terminal hover:bg-status-done/90"
                    onClick={onRestart}
                  >
                    Restart
                  </Button>
                </div>
              </>
            )}

            {update.state === 'error' && (
              <>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-status-error" />
                  <span className="text-sm font-medium text-foreground">Update failed</span>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Couldn&apos;t fetch the latest version. It&apos;ll retry next launch.
                </p>
                <div className="mt-2.5 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={onDismiss}
                  >
                    Dismiss
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
