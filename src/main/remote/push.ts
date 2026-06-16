import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import webpush, { type PushSubscription } from 'web-push'

interface PushFile {
  publicKey: string
  privateKey: string
  subs: PushSubscription[]
}

/// Web-push delivery for the remote panel: holds the VAPID keypair + the set of
/// installed-PWA subscriptions, persisted alongside the spine config so a phone
/// stays subscribed across app restarts. Tailnet-only, like the panel itself —
/// the subscription endpoints are the browser's push service, signed with our
/// VAPID key. Expired endpoints are pruned on send.
export class PushService {
  private keys: { publicKey: string; privateKey: string }
  private subs: PushSubscription[]

  constructor(private file: string) {
    const loaded = this.load()
    this.keys = loaded ?? webpush.generateVAPIDKeys()
    this.subs = loaded?.subs ?? []
    // Apple's APNs rejects a non-routable subject (e.g. @localhost) with
    // 403 BadJwtToken — the VAPID `sub` must be a real mailto/https.
    webpush.setVapidDetails('mailto:hello@agentcanvas.app', this.keys.publicKey, this.keys.privateKey)
    if (!loaded) this.persist()
  }

  /** The VAPID public key the page passes to `pushManager.subscribe`. */
  get publicKey(): string {
    return this.keys.publicKey
  }

  /** Register a device (idempotent on endpoint). */
  subscribe(sub: PushSubscription): void {
    if (!sub?.endpoint) return
    if (this.subs.some((s) => s.endpoint === sub.endpoint)) return
    this.subs.push(sub)
    this.persist()
  }

  /** Fan a notification out to every device; drop endpoints the push service
   *  reports as gone (404/410). Fire-and-forget — never blocks publish. */
  async notify(payload: { title: string; body: string }): Promise<void> {
    if (!this.subs.length) return
    const body = JSON.stringify(payload)
    const dead: string[] = []
    await Promise.all(
      this.subs.map((s) =>
        webpush.sendNotification(s, body).catch((err: { statusCode?: number }) => {
          if (err.statusCode === 404 || err.statusCode === 410) dead.push(s.endpoint)
        }),
      ),
    )
    if (dead.length) {
      this.subs = this.subs.filter((s) => !dead.includes(s.endpoint))
      this.persist()
    }
  }

  private load(): PushFile | null {
    try {
      const f = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof f.publicKey === 'string' && typeof f.privateKey === 'string') {
        return { publicKey: f.publicKey, privateKey: f.privateKey, subs: Array.isArray(f.subs) ? f.subs : [] }
      }
    } catch {
      // first run / unreadable → fresh keypair
    }
    return null
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const out: PushFile = { ...this.keys, subs: this.subs }
    writeFileSync(this.file, JSON.stringify(out, null, 2))
    chmodSync(this.file, 0o600) // carries the VAPID private key — keep it secret
  }
}
