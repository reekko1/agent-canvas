import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RegistrationStepper, type StepProps } from '@/components/ui/registration-stepper'
import type { IconComponent } from '@/lib/icon-context'
import type { AppReadiness } from '@shared/types'

// lucide's prop types are wider than IconComponent (size is string|number), so it
// can't go straight into Button's `leadingIcon`; a thin adapter bridges it.
const ExternalLinkIcon: IconComponent = (props) => <ExternalLink {...props} />

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

/// Setup gate, two tiers. `claude` is a HARD block — the canvas is unusable
/// without it, no close button, no Esc, the only way through is reality.
/// Being signed into Claude is a SOFT, skippable step (the orchestrator
/// needs it; the canvas doesn't), shown over a working canvas. Steps complete
/// themselves: the gate re-probes every few seconds and on window focus, so
/// running an install — or signing into `claude` — in Terminal and switching
/// back dissolves the step (that IS the feedback — no "verify" button). Hidden
/// until the first probe answers, so a ready machine never sees a flash.
export function SetupGate() {
  const [readiness, setReadiness] = useState<AppReadiness | null>(null)
  // The auth step is optional, so it's dismissible — unlike the claude gate.
  // Session-scoped: skipping hides it now but it returns next launch if still
  // unsigned-in, which is the only way back (placement is onboarding-only).
  const [authDismissed, setAuthDismissed] = useState(false)
  // The Soniox voice key — also a soft, skippable step. `voiceSaved` closes it
  // immediately on a successful save (the probe confirms within a few seconds);
  // `voiceDismissed` skips it for this launch.
  const [voiceKey, setVoiceKey] = useState('')
  const [savingVoice, setSavingVoice] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceDismissed, setVoiceDismissed] = useState(false)
  const [voiceSaved, setVoiceSaved] = useState(false)

  // claude is a HARD gate — the canvas can't function without it. Being signed
  // into Claude is a SOFT prompt — only the orchestrator needs it, so it shows
  // over a working canvas and can be skipped.
  const hardBlocked = readiness !== null && !readiness.claudeFound
  const needsAuth =
    readiness !== null && readiness.claudeFound && !readiness.orchestratorAuthed && !authDismissed
  // Voice is the last soft step — prompt for a key once the tools are in place.
  const needsVoiceKey =
    readiness !== null &&
    readiness.claudeFound &&
    !readiness.voiceKeySet &&
    !voiceSaved &&
    !voiceDismissed
  const show = hardBlocked || needsAuth || needsVoiceKey

  async function saveVoiceKey(): Promise<void> {
    setVoiceError(null)
    setSavingVoice(true)
    const r = await window.canvas.saveVoiceKey(voiceKey)
    setSavingVoice(false)
    if (r.ok) {
      setVoiceKey('')
      setVoiceSaved(true)
    } else {
      setVoiceError(r.message ?? 'Could not save the key.')
    }
  }

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
      title: 'Connect your Claude account',
      description: 'Powers the orchestrator — optional',
      content: (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The <span className="font-medium text-foreground">orchestrator</span> — the chat bar
            that drives your whole fleet — runs on your Claude subscription. Sign in once and it
            just works. The canvas itself doesn&apos;t need this, so you can skip it.
          </p>
          <CommandChip command="claude" />
          <p className="text-xs text-muted-foreground">
            Run <span className="font-mono">claude</span> once and sign in — you can close it right
            after. This step completes itself the moment you&apos;re signed in.
          </p>
          <Button variant="tertiary" onClick={() => setAuthDismissed(true)}>
            Skip for now
          </Button>
        </div>
      ),
    },
    {
      step: 3,
      title: 'Enable voice (Soniox)',
      description: 'Talk to the orchestrator — optional',
      content: (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Hold <span className="font-mono">⌥</span> to talk to the orchestrator and hear it speak
            back, powered by <span className="font-medium text-foreground">Soniox</span>. Paste an
            API key to turn it on — it&apos;s encrypted and stored only on this Mac. The canvas
            doesn&apos;t need this, so you can skip it.
          </p>
          <input
            type="password"
            value={voiceKey}
            onChange={(e) => setVoiceKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && voiceKey.trim() && !savingVoice) void saveVoiceKey()
            }}
            placeholder="Paste your Soniox API key"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary"
          />
          {voiceError && <p className="text-xs text-status-error">{voiceError}</p>}
          <div className="flex items-center gap-2">
            <Button onClick={() => void saveVoiceKey()} disabled={!voiceKey.trim() || savingVoice}>
              {savingVoice ? 'Verifying…' : 'Save key'}
            </Button>
            <Button
              variant="tertiary"
              leadingIcon={ExternalLinkIcon}
              onClick={() => window.canvas.openExternal('https://console.soniox.com')}
            >
              Get a key
            </Button>
            <Button variant="tertiary" onClick={() => setVoiceDismissed(true)}>
              Skip for now
            </Button>
          </div>
        </div>
      ),
    },
  ]

  // claude → auth → voice. Each soft step (auth, voice) advances once it's
  // satisfied or skipped; when both are, `show` is false so the modal is gone.
  const currentStep = !readiness?.claudeFound ? 0 : needsAuth ? 1 : 2

  return (
    <AnimatePresence>
      {show && (
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
