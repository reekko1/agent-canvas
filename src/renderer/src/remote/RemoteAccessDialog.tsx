import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import QRCode from 'qrcode'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RegistrationStepper, type StepProps } from '@/components/ui/registration-stepper'
import type { RemoteReadiness } from '@shared/types'

/// "Set up remote access": the wizard's tailscale chapter as a self-completing
/// stepper. Each step is satisfied by reality, not by clicking Next — the
/// dialog re-probes every few seconds (and on window focus), so installing
/// Tailscale in another window or running the serve command in Terminal
/// advances the step on its own. The payoff is the QR straight to the phone.
export function RemoteAccessDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [readiness, setReadiness] = useState<RemoteReadiness | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Probe while open: immediately, on a slow poll, and when the user comes
  // back to the app (they likely just ran the command — the step completing
  // itself IS the feedback).
  useEffect(() => {
    if (!open) return
    let live = true
    const probe = () => {
      void window.canvas.checkRemoteReadiness().then((r) => {
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
  }, [open])

  // The QR for the live tailnet URL (paper tile so phone cameras lock on).
  useEffect(() => {
    if (!readiness?.tailnetURL) {
      setQr(null)
      return
    }
    void QRCode.toDataURL(readiness.tailnetURL, {
      margin: 1,
      width: 360,
      color: { dark: '#13111c', light: '#f5f2ea' },
    }).then(setQr)
  }, [readiness?.tailnetURL])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const serving = !!readiness?.tailscaleFound && !!readiness.tailscaleServing
  const currentStep = !readiness?.tailscaleFound ? 0 : !serving ? 1 : 2
  const serveCommand =
    readiness && readiness.panelPort > 0
      ? `tailscale serve --bg localhost:${readiness.panelPort}`
      : null

  const copyCommand = () => {
    if (!serveCommand) return
    void navigator.clipboard.writeText(serveCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const steps: StepProps[] = [
    {
      step: 1,
      title: 'Install Tailscale',
      description: 'Your devices, one private network',
      content: (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            First, install Tailscale on this Mac and sign in. This step notices on its own.
          </p>
          <Button
            variant="tertiary"
            onClick={() => window.canvas.openExternal('https://tailscale.com/download')}
          >
            <ExternalLink data-icon="inline-start" />
            Get Tailscale
          </Button>
        </div>
      ),
    },
    {
      step: 2,
      title: 'Serve the panel',
      description: 'One command — tailnet only',
      content: (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Run the filled-in command in Terminal to serve the page over your tailnet.
          </p>
          {serveCommand ? (
            <button
              className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-muted px-3 py-2.5 text-left font-mono text-xs text-foreground hover:bg-muted/70"
              onClick={copyCommand}
            >
              <span className="min-w-0 flex-1 truncate">{serveCommand}</span>
              {copied ? (
                <Check className="size-3.5 shrink-0 text-status-done" />
              ) : (
                <Copy className="size-3.5 shrink-0 text-muted-foreground" />
              )}
            </button>
          ) : (
            <p className="text-xs text-muted-foreground">
              The remote panel is still starting up; the command appears here in a moment.
            </p>
          )}
        </div>
      ),
    },
    {
      step: 3,
      title: 'Your fleet, from anywhere',
      description: 'Statuses, the live feed, Allow / Deny',
      content: (
        <div className="space-y-3">
          {qr && (
            <div className="flex items-center gap-4">
              <div className="shrink-0 rounded-lg bg-[#f5f2ea] p-2">
                <img src={qr} alt="QR to the remote panel" className="size-28 max-w-none" />
              </div>
              <div className="min-w-0 space-y-1.5">
                <p className="break-all font-mono text-xs text-status-running">
                  {readiness?.tailnetURL}
                </p>
                <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                  <span className="inline-block size-2 rounded-full bg-status-done shadow-[0_0_6px_var(--status-done)]" />
                  serving · tailnet only
                </p>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold text-status-blocked">Keep it on the tailnet.</span> The
            Allow button approves commands on this Mac — never expose the panel publicly (Funnel,
            port-forward).
          </p>
        </div>
      ),
    },
  ]

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.97 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
          >
            <RegistrationStepper
              steps={steps}
              currentStep={currentStep}
              headerTitle="Remote access"
              headerStatus={serving ? 'Live' : 'Setup'}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
