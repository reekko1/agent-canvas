import type { AttentionLevel, CardStatus, RemoteState } from '@shared/types'
import { relativeFromSeconds } from '@shared/time'
import { openTranscript } from './transcript'
import { $, esc } from './util'
import { post } from './net'

/// The Fleet view: canvas-led triage (the panel's original home, now the
/// secondary tab behind the orchestrator chat). Polls /state every 2s and groups
/// each canvas's questions / approvals / cards under it, loudest first. Answer a
/// question by tapping options; approve/deny a permission gate; tap an agent to
/// view its (read-only) transcript. The needs-you count is surfaced on the
/// bottom-nav Fleet badge so it's visible while you're on the chat tab.

const EMPTY: RemoteState = {
  canvases: [],
  cards: [],
  approvals: [],
  questions: [],
  feed: [],
  needsYou: 0,
}

// Mirrors the desktop status palette (index.css :root --status-* tokens) —
// hand-synced as raw hex because the panel ships standalone (no Tailwind/vars).
const COLORS: Record<CardStatus, string> = {
  idle: '#807e90',
  running: '#48bfc0',
  waiting: '#92aae3',
  done: '#76cd98',
  stalled: '#d79a56',
  blocked: '#fbb636',
  error: '#f33f4c',
}
const RANK: Record<AttentionLevel, number> = { blocking: 2, done: 1, none: 0 }

// The desktop's agent identity is lucide's Bot icon; inline it here (vanilla,
// no lucide), inheriting the mark's color via currentColor.
const BOT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/>' +
  '<path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>'

// In-flight question selections, preserved across the 2s refresh: askId →
// questionText → chosen labels.
const sel: Record<string, Record<string, string[]>> = {}
let STATE: RemoteState = EMPTY

const rel = (t: number): string => relativeFromSeconds(t)
const dot = (status: CardStatus): string =>
  `<span class="dot" style="background:${COLORS[status] || '#807e90'}"></span>`
const wordEl = (status: CardStatus): string =>
  `<span class="word" style="color:${COLORS[status] || '#807e90'}">${esc(status).toUpperCase()}</span>`

// A card tile mirrors the desktop "window bar": status-tinted chrome (a
// status-colored border), a mono title with the >_ / bot identity mark, the
// folder, the task, model, and a right-aligned status HUD. Tapping an AGENT
// tile opens its (read-only) transcript; shells and browsers stay neutral and
// aren't tappable — a shell has no agent to speak for it, and a headless
// agent has no terminal for a shell tile to mirror either.
function cardTile(k: RemoteState['cards'][number]): string {
  const shell = k.kind === 'shell'
  const browser = k.kind === 'browser'
  // Neither a shell nor a browser has an agent to speak for it — neutral
  // chrome, no status HUD.
  const neutral = shell || browser
  const color = neutral ? 'var(--border)' : COLORS[k.status] || '#807e90'
  const glow = k.status === 'error' ? ' err' : k.loud ? ' loud' : ''
  const right: string[] = []
  if (k.model) right.push(`<span class="cmodel">${esc(k.model)}</span>`)
  if (k.permissionMode === 'bypassPermissions') right.push('<span class="cbypass">BYPASS</span>')
  else if (k.permissionMode === 'dontAsk') right.push('<span class="cbypass">DON&#39;T-ASK</span>')
  if (!neutral)
    right.push(
      `<span class="hud" style="color:${color}"><span class="d" style="background:${color}"></span>${esc(k.status).toUpperCase()}</span>`,
    )
  // Shells show their foreground command (idle when bare); a browser shows its
  // current page url; agents show the task.
  const activity = browser
    ? k.url
      ? esc(k.url)
      : '<span class="idle">web page</span>'
    : shell
      ? k.running
        ? esc(k.running)
        : '<span class="idle">idle</span>'
      : esc(k.task ?? '')
  // Only agent tiles are tappable — the read-only transcript view.
  const act = k.kind === 'agent' ? ' data-act="transcript"' : ''
  return (
    `<div class="tile card${glow}" style="border-color:${color}"${act} data-i="${esc(k.id)}" data-n="${esc(k.name)}">` +
    `<span class="mark">${shell ? '&gt;_' : browser ? '🌐' : BOT_SVG}</span>` +
    `<span class="cfolder">${esc(k.name)}</span>` +
    `<span class="ctask">${activity}</span>` +
    right.join('') +
    `<span class="chev">›</span></div>`
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
  // The needs-you count rides the bottom-nav Fleet badge (the chat tab is home,
  // so this is how attention stays visible while you're chatting).
  const badge = $('nav-badge')
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

// ---- Actions (event-delegated within #supervise-view; survives re-render) ----
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

const act = (path: string, body: unknown): void => void post(path, body).then(refresh)

function answer(id: string): void {
  const a: Record<string, string> = {}
  const bag = sel[id] ?? {}
  for (const q in bag) if (bag[q].length) a[q] = bag[q].join(', ')
  delete sel[id]
  act('answer', { id, answers: a })
}

/** The /state body is untrusted JSON. Validate its shape before rendering so a
 *  transient `{}` (served in the window before the first publish) renders an
 *  empty panel instead of throwing inside render() and masquerading as offline. */
function isRemoteState(v: unknown): v is RemoteState {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return (
    Array.isArray(s.canvases) &&
    Array.isArray(s.cards) &&
    Array.isArray(s.approvals) &&
    Array.isArray(s.questions) &&
    Array.isArray(s.feed) &&
    typeof s.needsYou === 'number'
  )
}

function refresh(): void {
  fetch('state')
    .then((r) => r.json())
    .then((st: unknown) => {
      $('offline').style.display = 'none'
      render(isRemoteState(st) ? st : EMPTY)
    })
    .catch(() => {
      $('offline').style.display = 'inline'
    })
}

/** Mount the Fleet view: wire its delegated tap handler and start the 2s poll.
 *  The poll runs unconditionally (even on the chat tab) so the Fleet badge stays
 *  live and switching tabs is instant. */
export function initSupervise(): void {
  $('supervise-view').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    if (!t) return
    const id = t.dataset.i ?? ''
    switch (t.dataset.act) {
      case 'allow':
        act('decide', { id, allow: true })
        break
      case 'deny':
        act('decide', { id, allow: false })
        break
      case 'pick':
        pick(id, t.dataset.q ?? '', t.dataset.l ?? '', !!t.dataset.multi)
        break
      case 'send':
        answer(id)
        break
      case 'decline':
        delete sel[id]
        act('decline', { id })
        break
      case 'transcript':
        openTranscript(id, t.dataset.n ?? 'agent')
        break
    }
  })
  refresh()
  setInterval(refresh, 2000)
}
