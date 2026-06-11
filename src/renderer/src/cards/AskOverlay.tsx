import { Button } from '@/components/ui/button'
import type { PermissionAskInfo } from '@shared/types'

/// The held permission ask, projected onto the card: what the agent wants and
/// the one decision it's waiting on. Allow/Deny answer from orbit; engaging
/// the terminal instead releases the ask to the CLI's native dialog.
export function AskOverlay({
  ask,
  onDecide,
}: {
  ask: PermissionAskInfo
  onDecide: (askId: string, decision: 'allow' | 'deny') => void
}) {
  return (
    <div className="nodrag absolute inset-x-3 bottom-3 flex items-center gap-2.5 rounded-md border border-status-blocked bg-popover/95 px-3.5 py-2.5 font-mono text-xs text-popover-foreground">
      <span className="flex-1 truncate">{ask.detail}</span>
      <Button
        size="sm"
        className="bg-status-done text-terminal hover:bg-status-done/90"
        onClick={() => onDecide(ask.askId, 'allow')}
      >
        Allow
      </Button>
      <Button
        size="sm"
        className="bg-status-blocked text-terminal hover:bg-status-blocked/90"
        onClick={() => onDecide(ask.askId, 'deny')}
      >
        Deny
      </Button>
    </div>
  )
}
