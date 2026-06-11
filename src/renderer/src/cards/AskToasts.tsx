import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import type { PermissionAskInfo } from '@shared/types'

/** The agent context a toast carries above the permission line. */
export interface AskContext {
  name: string
  task?: string
}

/// Held permission asks as a toast stack rising from the bottom edge: who is
/// asking, what they're working on, and the one decision they're waiting on.
/// Allow/Deny answer from orbit; clicking the body flies to the card, which
/// releases the ask to the CLI's native dialog in its terminal.
export function AskToasts({
  asks,
  contextFor,
  onDecide,
  onBodyClick,
}: {
  asks: PermissionAskInfo[]
  contextFor: (cardId: string) => AskContext
  onDecide: (askId: string, decision: 'allow' | 'deny') => void
  onBodyClick: (ask: PermissionAskInfo) => void
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex flex-col items-center gap-2">
      <AnimatePresence>
        {asks.map((ask) => {
          const ctx = contextFor(ask.cardId)
          return (
            <motion.div
              key={ask.askId}
              layout
              initial={{ opacity: 0, y: 24, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.97 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="pointer-events-auto w-[30rem] max-w-[90vw] cursor-pointer rounded-2xl border border-status-blocked/50 bg-background/75 p-3.5 shadow-lg shadow-black/15 backdrop-blur-xl"
              onClick={() => onBodyClick(ask)}
              title="Click to fly to the card (the dialog moves to its terminal)"
            >
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-status-blocked" />
                <span className="text-sm font-medium text-foreground">{ctx.name}</span>
                {ctx.task && (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {ctx.task}
                  </span>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
                  {ask.detail}
                </span>
                <Button
                  size="sm"
                  className="bg-status-done text-terminal hover:bg-status-done/90"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDecide(ask.askId, 'allow')
                  }}
                >
                  Allow
                </Button>
                <Button
                  size="sm"
                  className="bg-status-blocked text-terminal hover:bg-status-blocked/90"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDecide(ask.askId, 'deny')
                  }}
                >
                  Deny
                </Button>
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
