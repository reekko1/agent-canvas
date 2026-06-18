import { Globe } from 'lucide-react'

/// A stacked browser card's compact face — sibling to the agent poster and the
/// shell readout. The live <webview> is hidden behind this while stacked (its
/// page stays alive), so the preview is a snapshot captured the moment the card
/// was demoted. Identity (name / page title) reads in the window bar above, so
/// the face is just the preview — no chrome strip of its own. Clicking promotes
/// the card back to master, where the live page resumes.
export function BrowserFace({ snapshot }: { snapshot?: string }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-muted/40">
      {snapshot ? (
        <img src={snapshot} alt="" className="absolute inset-0 h-full w-full object-cover object-top" />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Globe className="size-10 text-muted-foreground/30" aria-hidden />
        </div>
      )}
    </div>
  )
}
