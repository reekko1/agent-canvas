import './style.css'
import { $ } from './util'
import { ensureToken } from './net'
import { initSupervise } from './supervise'
import { initChat } from './chat'

/// The shell: a two-view phone app — the orchestrator CHAT (home) and the FLEET
/// supervision panel (secondary), switched by the bottom nav; the read-only
/// transcript overlay (transcript.ts) floats above either. This module owns
/// the view router, the push-subscribe flow, and bootstrap; chat.ts and
/// supervise.ts own their views.

// ---- View router -----------------------------------------------------------
type View = 'chat' | 'supervise'
function setView(v: View): void {
  document.body.dataset.view = v
  document.querySelectorAll('#bottom-nav [data-view]').forEach((b) => {
    b.classList.toggle('on', (b as HTMLElement).dataset.view === v)
  })
}
$('bottom-nav').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-view]') as HTMLElement | null
  if (b?.dataset.view) setView(b.dataset.view as View)
})

// ---- Push: install-as-PWA then subscribe, gated behind a user tap (iOS) ----
const pushSupported = (): boolean =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
function updateEnable(): void {
  const b = $('enable')
  const granted = 'Notification' in window && Notification.permission === 'granted'
  b.style.display = pushSupported() && !granted ? 'inline-block' : 'none'
}
function urlB64(b: string): Uint8Array {
  const pad = '='.repeat((4 - (b.length % 4)) % 4)
  const raw = atob((b + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}
async function enablePush(): Promise<void> {
  if (!pushSupported()) {
    alert('Add to Home Screen first, then enable alerts.')
    return
  }
  try {
    const reg = await navigator.serviceWorker.ready
    if ((await Notification.requestPermission()) !== 'granted') return
    const key = await fetch('vapid').then((r) => r.text())
    if (!key) {
      alert('Push not configured.')
      return
    }
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64(key) as BufferSource,
    })
    await fetch('subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-canvas-token': await ensureToken() },
      body: JSON.stringify(subscription),
    })
    updateEnable()
  } catch (err) {
    console.log(err)
  }
}
$('enable').addEventListener('click', () => void enablePush())

// ---- Bootstrap -------------------------------------------------------------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})
updateEnable()
void ensureToken() // pre-warm so the first action / socket doesn't wait on it
setView('chat')
initSupervise() // polls /state unconditionally so the Fleet badge stays live
initChat()
