import type { CSSProperties } from 'react'
import { DiffNode } from '@/diff/DiffNode'
import { PAD, TOP_STRIP } from './layout'

/// The diff side sheet: a right-edge drawer that slides over the canvas without
/// displacing the master-stack. Collapsing parks it off-screen but keeps
/// DiffNode mounted (watcher + selection survive), with an edge tab to bring it
/// back; closing (the caller dropping `activeDir`) tears it down. Keyed by the
/// active project id so switching canvases re-points the watcher.
export function DiffSheet(props: {
  activeDir: string
  activeProjectId: string | null
  sheetW: number
  collapsed: boolean
  onCollapse: () => void
  onExpand: () => void
}) {
  const { activeDir, activeProjectId, sheetW, collapsed, onCollapse, onExpand } = props
  return (
    <>
      <div
        data-diff-sheet
        className="fixed overflow-hidden rounded-2xl"
        style={{
          top: TOP_STRIP,
          bottom: PAD,
          right: PAD,
          width: sheetW,
          zIndex: 35,
          transform: collapsed ? 'translateX(calc(100% + 24px))' : 'translateX(0)',
          transition: 'transform .3s ease',
        }}
      >
        <DiffNode id={`diff-${activeProjectId}`} data={{ folder: activeDir, onCollapse }} />
      </div>
      {collapsed && (
        <button
          className="fixed right-0 top-1/2 -translate-y-1/2 rounded-l-xl border border-r-0 border-border/40 bg-background/80 px-2 py-3 font-mono text-xs text-muted-foreground shadow-lg backdrop-blur-xl hover:text-foreground"
          style={{ zIndex: 36, writingMode: 'vertical-rl' } as CSSProperties}
          onClick={onExpand}
          title="Show diff"
        >
          diff
        </button>
      )}
    </>
  )
}
