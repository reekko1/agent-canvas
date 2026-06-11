import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RegistrationStepper, type StepProps } from '@/components/ui/registration-stepper'
import type { AppReadiness } from '@shared/types'

/** A copyable install command — the wizard's CopyChip. */
function CommandChip({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-muted px-3 py-2.5 text-left font-mono text-xs text-foreground hover:bg-muted/70"
      onClick={() => {
        void navigator.clipboard.writeText(command)
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }}
    >
      <span className="min-w-0 flex-1 truncate">{command}</span>
      {copied ? (
        <Check className="size-3.5 shrink-0 text-status-done" />
      ) : (
        <Copy className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  )
}

/// The hard gate: the canvas is unusable until `claude` and `tmux` exist.
/// No close button, no Esc — the only way through is reality. Steps complete
/// themselves: the gate re-probes every few seconds and on window focus, so
/// running the install in Terminal and switching back dissolves the step
/// (that IS the feedback — no "verify" button). Hidden until the first probe
/// answers, so a ready machine never sees a flash.
export function SetupGate() {
  const [readiness, setReadiness] = useState<AppReadiness | null>(null)

  const blocked = readiness !== null && (!readiness.claudeFound || !readiness.tmuxFound)

  useEffect(() => {
    let live = true
    const probe = () => {
      void window.canvas.checkAppReadiness().then((r) => {
        if (live) setReadiness(r)
      })
    }
    probe()
    const interval = setInterval(probe, 3000)
    window.addEventListener('focus', probe)
    return () => {
      live = false
      clearInterval(interval)
      window.removeEventListener('focus', probe)
    }
  }, [])

  const steps: StepProps[] = [
    {
      step: 1,
      title: 'Install Claude Code',
      description: 'Every card is a live agent',
      content: (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Nothing to supervise yet — every card is a live{' '}
            <span className="font-medium text-foreground">Claude Code</span> agent in a folder you
            choose. Installing it is one command, run in Terminal:
          </p>
          <CommandChip command="curl -fsSL https://claude.ai/install.sh | bash" />
          <p className="text-xs text-muted-foreground">
            This step completes itself once <span className="font-mono">claude</span> is on your
            PATH.
          </p>
        </div>
      ),
    },
    {
      step: 2,
      title: 'Install tmux',
      description: 'Agents survive app restarts',
      content: (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Without <span className="font-medium text-foreground">tmux</span>, agents stop when
            you quit the app. With it, they keep working through restarts and crashes — the canvas
            becomes a window onto them, not their life support.
          </p>
          {readiness?.brewFound ? (
            <CommandChip command="brew install tmux" />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                tmux installs through <span className="font-medium text-foreground">Homebrew</span>
                , which isn&apos;t on this Mac yet. Install it first; this step picks up from
                there.
              </p>
              <Button
                variant="outline"
                onClick={() => window.canvas.openExternal('https://brew.sh')}
              >
                <ExternalLink data-icon="inline-start" />
                Get Homebrew
              </Button>
            </>
          )}
        </div>
      ),
    },
  ]

  const currentStep = !readiness?.claudeFound ? 0 : !readiness.tmuxFound ? 1 : 2

  return (
    <AnimatePresence>
      {blocked && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-background/70 backdrop-blur-xl"
        >
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.99 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <RegistrationStepper
              steps={steps}
              currentStep={currentStep}
              headerTitle="A quiet place for your agents"
              headerStatus="Setup"
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
