import { motion, AnimatePresence } from 'framer-motion'

/** A mutating action the orchestrator proposed, awaiting your Allow/Deny.
 *  `title` is the verb in plain language, `detail` its target/payload. */
export interface OrchestratorConfirm {
  id: number
  title: string
  detail: string
}

/// The orchestrator's permission gate — a sibling of AskToasts in the same
/// bottom overlay, so an action the orchestrator wants to take reads like any
/// other permission ask. Differs from AskToasts only in wiring: a cyan accent
/// (it's the orchestrator, not an agent) and a reply over the correlation-id
/// channel rather than a held ask. Allow/Deny keep the shared go/stop status
/// colors a gate carries.
export function OrchestratorConfirmToast({
  confirm,
  onDecide,
}: {
  confirm: OrchestratorConfirm | null
  onDecide: (allow: boolean) => void
}) {
  return (
    <AnimatePresence>
      {confirm && (
        <motion.div
          key={confirm.id}
          layout
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.97 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="pointer-events-auto mb-2 w-full rounded-2xl border border-accent-ai/50 bg-background/75 p-3.5 shadow-lg shadow-black/15 backdrop-blur-xl"
        >
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent-ai" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-accent-ai/80">
              Orchestrator
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {confirm.title}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
              {confirm.detail}
            </span>
            {/* Plain buttons (not the design-system Button) so Allow/Deny keep
                their go/stop status colors — a permission gate's semantics. */}
            <button
              type="button"
              className="h-7 shrink-0 rounded-lg bg-status-done px-3 text-[12px] font-medium text-terminal transition-colors hover:bg-status-done/90"
              onClick={() => onDecide(true)}
            >
              Allow
            </button>
            <button
              type="button"
              className="h-7 shrink-0 rounded-lg bg-status-blocked px-3 text-[12px] font-medium text-terminal transition-colors hover:bg-status-blocked/90"
              onClick={() => onDecide(false)}
            >
              Deny
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
