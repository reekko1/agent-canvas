import './style.css'
import type { RemoteState } from '@shared/types'
import { openTerminal } from './term'

/// The mobile panel: canvas-led triage. Polls /state every 2s and groups each
/// canvas's questions / approvals / cards under it, loudest first. Answer a
/// question by tapping options; approve/deny a permission gate. Push opt-in
/// rides the installed-PWA service worker.

const EMPTY: RemoteState = {
  canvases: [],
  cards: [],
  approvals: [],
  questions: [],
  feed: [],
  needsYou: 0,
}

const COLORS: Record<string, string> = {
  idle: '#807e90',
  running: '#48bfc0',
  waiting: '#92aae3',
  done: '#76cd98',
  stalled: '#d79a56',
  blocked: '#fbb636',
  error: '#f33f4c',
}
const RANK: Record<string, number> = { blocking: 2, done: 1, none: 0 }

// In-flight question selections, preserved across the 2s refresh: askId →
// questionText → chosen labels.
const sel: Record<string, Record<string, string[]>> = {}
let STATE: RemoteState = EMPTY

const $ = (id: string): HTMLElement => document.getElementById(id)!

function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
function rel(t: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t))
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}
const dot = (status: string): string =>
  `<span class="dot" style="background:${COLORS[status] || '#807e90'}"></span>`
const wordEl = (status: string): string =>
  `<span class="word" style="color:${COLORS[status] || '#807e90'}">${esc(status).toUpperCase()}</span>`

function cardTile(k: RemoteState['cards'][number]): string {
  const cls = k.status === 'error' ? 'tile err' : k.loud ? 'tile loud' : 'tile'
  const meta: string[] = []
  if (k.permissionMode === 'bypassPermissions') meta.push('<span class="bypass">BYPASS</span>')
  else if (k.permissionMode === 'dontAsk') meta.push('<span class="bypass">DON&#39;T-ASK</span>')
  if (k.subagents > 0) meta.push('&#10022;' + k.subagents)
  if (k.model) meta.push(esc(k.model))
  if (k.task) meta.push(esc(k.task))
  // Whole tile taps into the card's terminal (a live tmux mirror).
  const word =
    k.kind === 'shell' ? '<span class="word" style="color:var(--muted)">SHELL</span>' : wordEl(k.status)
  return (
    `<div class="${cls} tap" data-act="term" data-i="${esc(k.id)}" data-n="${esc(k.name)}">` +
    `<div class="row">${dot(k.status)}` +
    `<span class="name">${esc(k.name)}</span>${word}` +
    `<span class="age">${rel(k.since)}</span><span class="chev">›</span></div>` +
    (meta.length ? `<div class="meta">${meta.join(' &middot; ')}</div>` : '') +
    `</div>`
  )
}

function approvalTile(a: RemoteState['approvals'][number]): string {
  return (
    `<div class="tile ask"><div class="row">${dot('blocked')}` +
    `<span class="name">${esc(a.name)}</span><span class="age">${rel(a.created)}</span></div>` +
    `<div class="detail">${esc(a.detail)}</div>` +
    `<div class="acts"><button class="allow" data-act="allow" data-i="${esc(a.id)}">Allow</button>` +
    `<button class="deny" data-act="deny" data-i="${esc(a.id)}">Deny</button></div></div>`
  )
}

const chosen = (id: string, q: string): string[] => sel[id]?.[q] ?? []

function questionTile(q: RemoteState['questions'][number]): string {
  let h =
    `<div class="tile ask"><div class="row">${dot('blocked')}` +
    `<span class="name">${esc(q.name)}</span>` +
    `<span class="word" style="color:var(--blocked)">ASKS</span></div>`
  let ready = q.questions.length > 0
  for (const qq of q.questions) {
    h += `<div class="q">${esc(qq.question)}</div><div class="opts">`
    const on = chosen(q.id, qq.question)
    if (!on.length) ready = false
    for (const o of qq.options) {
      const isOn = on.indexOf(o.label) >= 0
      h +=
        `<button class="opt${isOn ? ' on' : ''}" data-act="pick" data-i="${esc(q.id)}"` +
        ` data-q="${esc(qq.question)}" data-l="${esc(o.label)}" data-multi="${qq.multiSelect ? '1' : ''}">` +
        `${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`
    }
    h += `</div>`
  }
  h +=
    `<div class="acts"><button class="send" data-act="send" ${ready ? '' : 'disabled '}data-i="${esc(q.id)}">Send</button>` +
    `<button class="decline" data-act="decline" data-i="${esc(q.id)}">Decline</button></div></div>`
  return h
}

interface Group {
  cards: RemoteState['cards']
  approvals: RemoteState['approvals']
  questions: RemoteState['questions']
}

function render(st: RemoteState): void {
  STATE = st
  const badge = $('badge')
  badge.style.display = st.needsYou > 0 ? 'inline-block' : 'none'
  badge.textContent = String(st.needsYou)
  document.title = (st.needsYou > 0 ? `(${st.needsYou}) ` : '') + 'Agent Canvas'

  // Drop selections whose question is gone (answered elsewhere).
  const live: Record<string, 1> = {}
  st.questions.forEach((q) => (live[q.id] = 1))
  for (const k in sel) if (!live[k]) delete sel[k]

  const byId: Record<string, RemoteState['canvases'][number]> = {}
  st.canvases.forEach((c) => (byId[c.id] = c))
  const groups: Record<string, Group> = {}
  const bucket = (pid: string): Group =>
    (groups[pid] ??= { cards: [], approvals: [], questions: [] })
  st.canvases.forEach((c) => bucket(c.id))
  st.cards.forEach((k) => bucket(k.projectId || '_').cards.push(k))
  st.approvals.forEach((a) => bucket(a.projectId || '_').approvals.push(a))
  st.questions.forEach((q) => bucket(q.projectId || '_').questions.push(q))

  const ids = Object.keys(groups).sort((a, b) => {
    const ca = byId[a]
    const cb = byId[b]
    const ra = ca ? RANK[ca.attention] || 0 : 0
    const rb = cb ? RANK[cb.attention] || 0 : 0
    if (ra !== rb) return rb - ra
    return (ca ? ca.name : '~').localeCompare(cb ? cb.name : '~')
  })

  let out = ''
  for (const pid of ids) {
    const g = groups[pid]
    const c = byId[pid]
    if (!c && !g.cards.length && !g.approvals.length && !g.questions.length) continue
    let git = ''
    if (c && c.branch) {
      git = esc(c.branch)
      if (c.dirty > 0) git += ` <span class="dirty">&bull;${c.dirty}</span>`
    }
    out +=
      `<div class="canvas"><div class="chead">` +
      `<span class="adot ${c ? c.attention : 'none'}"></span>` +
      `<span class="cname">${esc(c ? c.name : 'Unassigned')}</span>` +
      (git ? `<span class="git">${git}</span>` : '') +
      `</div>`
    g.questions.forEach((q) => (out += questionTile(q)))
    g.approvals.forEach((a) => (out += approvalTile(a)))
    g.cards.forEach((k) => (out += cardTile(k)))
    if (!g.questions.length && !g.approvals.length && !g.cards.length)
      out += `<div class="empty">idle</div>`
    out += `</div>`
  }
  $('canvases').innerHTML = out || '<div class="empty">no canvases yet</div>'

  const f = $('feed')
  if (!st.feed.length) {
    f.className = 'empty'
    f.textContent = 'nothing yet'
  } else {
    f.className = ''
    f.innerHTML = st.feed
      .slice(0, 20)
      .map(
        (e) =>
          `<div class="tile"><div class="row">${dot(e.status)}` +
          `<span class="name">${esc(e.name)}</span>${wordEl(e.status)}` +
          `<span class="age">${rel(e.date)}</span></div>` +
          `<div class="meta">${esc(e.message)}</div></div>`,
      )
      .join('')
  }
}

// ---- Actions (event-delegated; survives re-render) ----
function pick(id: string, q: string, label: string, multi: boolean): void {
  const bag = (sel[id] ??= {})
  let cur = bag[q] ?? []
  if (multi) {
    cur = cur.includes(label) ? cur.filter((x) => x !== label) : cur.concat([label])
  } else {
    cur = cur.length === 1 && cur[0] === label ? [] : [label]
  }
  bag[q] = cur
  render(STATE)
}
const post = (path: string, body: unknown): Promise<unknown> =>
  fetch(path, { method: 'POST', body: JSON.stringify(body) }).then(refresh, refresh)
function answer(id: string): void {
  const a: Record<string, string> = {}
  const bag = sel[id] ?? {}
  for (const q in bag) if (bag[q].length) a[q] = bag[q].join(', ')
  delete sel[id]
  void post('answer', { id, answers: a })
}

document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
  if (!t) return
  const id = t.dataset.i ?? ''
  switch (t.dataset.act) {
    case 'allow':
      void post('decide', { id, allow: true })
      break
    case 'deny':
      void post('decide', { id, allow: false })
      break
    case 'pick':
      pick(id, t.dataset.q ?? '', t.dataset.l ?? '', !!t.dataset.multi)
      break
    case 'send':
      answer(id)
      break
    case 'decline':
      delete sel[id]
      void post('decline', { id })
      break
    case 'term':
      openTerminal(id, t.dataset.n ?? 'terminal')
      break
  }
})

function refresh(): void {
  fetch('state')
    .then((r) => r.json())
    .then((st: RemoteState) => {
      $('offline').style.display = 'none'
      render(st)
    })
    .catch(() => {
      $('offline').style.display = 'inline'
    })
}

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
    await fetch('subscribe', { method: 'POST', body: JSON.stringify(subscription) })
    updateEnable()
  } catch (err) {
    console.log(err)
  }
}
$('enable').addEventListener('click', () => void enablePush())

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})
updateEnable()
refresh()
setInterval(refresh, 2000)
