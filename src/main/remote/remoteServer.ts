import http from 'node:http'
import type { QuestionAnswers, RemoteState } from '../../shared/types'
import type { PushService } from './push'

/// The remote panel: supervision — and the orbit Allow/Deny + answer-questions —
/// from any device on your tailnet. `GET /` serves a self-contained page,
/// `GET /state` the JSON snapshot, `POST /decide {id, allow}` answers a held
/// permission ask, `POST /answer {id, answers}` answers an AskUserQuestion,
/// `POST /decline {id}` declines one. Installable as a PWA (manifest + sw).
///
/// It binds loopback only; reachability is deliberately a proxy's job:
/// `tailscale serve --bg localhost:<port>` adds TLS + tailnet identity.
/// **Never expose it publicly** (Funnel, port-forward): the buttons approve
/// arbitrary tool calls on this machine. (Port of the Swift RemoteServer.)
export class RemoteServer {
  /** A decision arriving from the panel — same authority as the in-app
   *  toasts, routed to the same spine.decide. */
  onDecide?: (askId: string, allow: boolean) => void
  /** A held AskUserQuestion answered from the panel. */
  onAnswer?: (askId: string, answers: QuestionAnswers) => void
  /** A held AskUserQuestion declined from the panel. */
  onDecline?: (askId: string) => void

  /** Web-push delivery (set by the spine). Absent → the panel works, just no
   *  notifications. */
  push?: PushService
  /** True when the desktop window is focused — we skip the phone push then,
   *  since you're already looking at the canvas. */
  isDesktopFocused?: () => boolean

  port = 0
  private stateJSON = '{}'
  // Actionable ask/question ids already pushed for — so we ping on the NEW one,
  // not every 2s republish. `primed` suppresses a burst for whatever's pending
  // at startup.
  private notified = new Set<string>()
  private primed = false

  start(preferredPort: number | undefined, onReady: (port: number) => void): void {
    const server = http.createServer((req, res) => this.handle(req, res))
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferredPort) {
        console.log(`[remote] port ${preferredPort} taken — falling back to ephemeral`)
        preferredPort = undefined
        server.listen(0, '127.0.0.1')
      } else {
        console.error('[remote]', err)
      }
    })
    server.on('listening', () => {
      this.port = (server.address() as { port: number }).port
      onReady(this.port)
    })
    server.listen(preferredPort ?? 0, '127.0.0.1')
  }

  publish(state: RemoteState): void {
    this.stateJSON = JSON.stringify(state)
    this.maybeNotify(state)
  }

  /** Push when a NEW thing needs you — and only while the desktop isn't
   *  focused (you'd see it there otherwise). */
  private maybeNotify(state: RemoteState): void {
    const items = [
      ...state.approvals.map((a) => ({ id: a.id, name: a.name, kind: 'approval' as const })),
      ...state.questions.map((q) => ({ id: q.id, name: q.name, kind: 'question' as const })),
    ]
    const current = new Set(items.map((i) => i.id))
    const fresh = items.filter((i) => !this.notified.has(i.id))
    this.notified = current

    if (!this.primed) {
      this.primed = true // first snapshot just seeds the set — no startup burst
      return
    }
    if (!fresh.length || !this.push || this.isDesktopFocused?.()) return

    const names = new Map(state.canvases.map((c) => [c.id, c.name]))
    const lead = fresh[0]
    const canvas =
      lead.kind === 'approval'
        ? names.get(state.approvals.find((a) => a.id === lead.id)?.projectId ?? '')
        : names.get(state.questions.find((q) => q.id === lead.id)?.projectId ?? '')
    const body =
      fresh.length > 1
        ? `${fresh.length} agents need you`
        : `${canvas ? canvas + ' · ' : ''}${lead.name} ${lead.kind === 'question' ? 'asks you' : 'needs approval'}`
    void this.push.notify({ title: 'Agent Canvas', body })
  }

  /** Read a JSON POST body, then run `ok`. Malformed → 400. */
  private body(req: http.IncomingMessage, res: http.ServerResponse, ok: (obj: any) => boolean): void {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        if (!ok(JSON.parse(Buffer.concat(chunks).toString('utf8')))) throw new Error()
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      } catch {
        res.writeHead(400).end()
      }
    })
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
      return
    }
    if (req.method === 'GET' && url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(this.stateJSON)
      return
    }
    if (req.method === 'GET' && url === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json' }).end(MANIFEST)
      return
    }
    if (req.method === 'GET' && url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(SW)
      return
    }
    if (req.method === 'GET' && url === '/icon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(ICON)
      return
    }
    if (req.method === 'GET' && url === '/vapid') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(this.push?.publicKey ?? '')
      return
    }
    if (req.method === 'POST' && url === '/subscribe') {
      this.body(req, res, (o) => {
        if (typeof o?.endpoint !== 'string') return false
        this.push?.subscribe(o)
        return true
      })
      return
    }
    if (req.method === 'POST' && url === '/decide') {
      this.body(req, res, (o) => {
        if (typeof o.id !== 'string' || typeof o.allow !== 'boolean') return false
        this.onDecide?.(o.id, o.allow)
        return true
      })
      return
    }
    if (req.method === 'POST' && url === '/answer') {
      this.body(req, res, (o) => {
        if (typeof o.id !== 'string' || typeof o.answers !== 'object' || !o.answers) return false
        this.onAnswer?.(o.id, o.answers as QuestionAnswers)
        return true
      })
      return
    }
    if (req.method === 'POST' && url === '/decline') {
      this.body(req, res, (o) => {
        if (typeof o.id !== 'string') return false
        this.onDecline?.(o.id)
        return true
      })
      return
    }
    res.writeHead(404).end()
  }
}

const MANIFEST = JSON.stringify({
  name: 'Agent Canvas',
  short_name: 'Canvas',
  description: 'Triage your agent fleet from anywhere on your tailnet.',
  start_url: '.',
  scope: '.',
  display: 'standalone',
  background_color: '#13111c',
  theme_color: '#13111c',
  icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
})

// A flat-mark icon in the app's dark palette. SVG keeps it crisp at any size.
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
<rect width="192" height="192" rx="42" fill="#13111c"/>
<circle cx="96" cy="96" r="40" fill="none" stroke="#fbb636" stroke-width="12"/>
<circle cx="96" cy="96" r="12" fill="#fbb636"/></svg>`

// Minimal service worker: makes the page installable + lays the groundwork for
// the push pass (a 'push' handler that raises a notification). No precache —
// the page is tiny and always fetched fresh.
const SW = `self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function(e){
  var d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Agent Canvas', {
    body: d.body || 'A canvas needs you', icon: 'icon.svg', badge: 'icon.svg', data: d
  }));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(function(cs){
    for (var i=0;i<cs.length;i++) if ('focus' in cs[i]) return cs[i].focus();
    if (self.clients.openWindow) return self.clients.openWindow('.');
  }));
});`

/// One self-contained dark page, phone-first and canvas-led: each canvas (a
/// repo) shows its attention + git, with the questions/approvals/cards that
/// live on it. Answer a question by tapping options. Polls `/state` every 2s;
/// fetches use relative paths so it works behind whatever path Tailscale Serve
/// mounts it on. Colors mirror index.css's dark palette by hand — keep in sync.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#13111c">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Canvas">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon.svg">
<title>Agent Canvas</title>
<style>
  :root { --bg:#13111c; --body:#201f2a; --bar:#2a2836; --text:#eee9df; --muted:#92909f;
          --border:#393744; --blocked:#fbb636; --error:#f33f4c; --done:#76cd98; }
  * { box-sizing: border-box; margin: 0; -webkit-tap-highlight-color: transparent; }
  body { background: var(--bg); color: var(--text); font: 15px/1.45 -apple-system, "Helvetica Neue", sans-serif;
         padding: calc(18px + env(safe-area-inset-top)) calc(18px + env(safe-area-inset-right))
                  calc(28px + env(safe-area-inset-bottom)) calc(18px + env(safe-area-inset-left));
         max-width: 720px; margin: 0 auto; }
  h1 { font-size: 17px; letter-spacing: .02em; display: flex; align-items: center; gap: 10px; }
  h1 .badge { background: var(--blocked); color: #13111c; border-radius: 10px; padding: 1px 9px;
              font-size: 13px; font-weight: 700; display: none; }
  .canvas { margin: 20px 0 4px; }
  .chead { display: flex; align-items: center; gap: 8px; padding: 0 2px 8px; }
  .chead .cname { font-weight: 700; font-size: 15px; }
  .chead .git { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; margin-left: auto; }
  .chead .git .dirty { color: var(--blocked); }
  .adot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .adot.blocking { background: var(--blocked); box-shadow: 0 0 8px rgba(251,182,54,.6); }
  .adot.done { background: transparent; border: 1.5px solid var(--done); }
  .adot.none { background: var(--border); }
  .tile { background: var(--body); border: 1px solid var(--border); border-radius: 12px;
          padding: 11px 13px; margin-bottom: 8px; }
  .tile.loud { border-color: var(--blocked); box-shadow: 0 0 18px rgba(251,182,54,.18); }
  .tile.err { border-color: var(--error); box-shadow: 0 0 18px rgba(243,63,76,.2); }
  .tile.ask { border-color: var(--blocked); }
  .row { display: flex; align-items: baseline; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; align-self: center; }
  .name { font-weight: 650; }
  .word { font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: .06em; }
  .age { color: var(--muted); font-size: 12px; margin-left: auto; flex: none; font-family: ui-monospace, monospace; }
  .meta { color: var(--muted); font-size: 12.5px; margin-top: 3px; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap; }
  .meta .bypass { color: var(--error); font-weight: 700; }
  .detail { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted);
            margin: 4px 0 9px; word-break: break-all; }
  .q { font-size: 14px; font-weight: 600; margin: 9px 0 7px; }
  .opts { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 4px; }
  .opt { border: 1px solid var(--border); border-radius: 9px; padding: 7px 12px; font-size: 13px;
         color: var(--text); background: transparent; text-align: left; }
  .opt.on { border-color: var(--done); color: var(--done); background: rgba(118,205,152,.1); }
  .opt small { display: block; color: var(--muted); font-weight: 400; font-size: 11.5px; margin-top: 2px; }
  .opt.on small { color: var(--done); }
  button { font: 600 13px -apple-system, sans-serif; border-radius: 8px; padding: 7px 16px;
           border: 1px solid var(--border); background: transparent; color: var(--text); }
  .acts { margin-top: 8px; display: flex; gap: 6px; }
  button.allow, button.send { border-color: var(--done); color: var(--done); }
  button.deny, button.decline { border-color: var(--error); color: var(--error); }
  button:active { background: var(--bar); }
  button:disabled { opacity: .4; }
  h2 { font-size: 11px; letter-spacing: .14em; color: var(--muted); margin: 24px 0 8px;
       font-family: ui-monospace, monospace; }
  .empty { color: var(--muted); font-size: 13px; padding: 6px 2px; }
  .offline { color: var(--error); font-size: 12px; display: none; margin-left: auto; }
  #enable { display: none; margin-left: auto; border-color: var(--blocked); color: var(--blocked);
            padding: 5px 12px; font-size: 12px; }
</style>
</head>
<body>
<h1>Agent Canvas <span class="badge" id="badge"></span><span class="offline" id="offline">offline</span>
<button id="enable" onclick="enablePush()">Enable alerts</button></h1>
<div id="canvases"></div>
<h2>ACTIVITY</h2><div id="feed" class="empty">…</div>
<script>
var COLORS = { idle:'#807e90', running:'#48bfc0', waiting:'#92aae3', done:'#76cd98',
               stalled:'#d79a56', blocked:'#fbb636', error:'#f33f4c' };
var RANK = { blocking:2, done:1, none:0 };
var sel = {}; // askId -> { questionText -> [labels] }, preserved across refreshes
function esc(s) { return String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function rel(t) { var s = Math.max(0, Math.floor(Date.now()/1000 - t));
  if (s < 60) return 'now'; if (s < 3600) return Math.floor(s/60)+'m';
  if (s < 86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
function dot(status) { return '<span class="dot" style="background:'+(COLORS[status]||'#807e90')+'"></span>'; }
function word(status) { return '<span class="word" style="color:'+(COLORS[status]||'#807e90')+'">'+esc(status).toUpperCase()+'</span>'; }

var STATE = { canvases:[], cards:[], approvals:[], questions:[], feed:[], needsYou:0 };

function cardTile(k) {
  var cls = k.status === 'error' ? 'tile err' : (k.loud ? 'tile loud' : 'tile');
  var meta = [];
  if (k.permissionMode === 'bypassPermissions') meta.push('<span class="bypass">BYPASS</span>');
  else if (k.permissionMode === 'dontAsk') meta.push('<span class="bypass">DON&#39;T-ASK</span>');
  if (k.subagents > 0) meta.push('&#10022;' + k.subagents);
  if (k.model) meta.push(esc(k.model));
  if (k.task) meta.push(esc(k.task));
  return '<div class="' + cls + '"><div class="row">' + dot(k.status) +
         '<span class="name">' + esc(k.name) + '</span>' + word(k.status) +
         '<span class="age">' + rel(k.since) + '</span></div>' +
         (meta.length ? '<div class="meta">' + meta.join(' &middot; ') + '</div>' : '') + '</div>';
}

function approvalTile(a) {
  return '<div class="tile ask"><div class="row">' + dot('blocked') +
    '<span class="name">' + esc(a.name) + '</span><span class="age">' + rel(a.created) + '</span></div>' +
    '<div class="detail">' + esc(a.detail) + '</div>' +
    '<div class="acts"><button class="allow" onclick="decide(this.dataset.i,true)" data-i="' + esc(a.id) + '">Allow</button>' +
    '<button class="deny" onclick="decide(this.dataset.i,false)" data-i="' + esc(a.id) + '">Deny</button></div></div>';
}

function chosen(id, qtext) { return (sel[id] && sel[id][qtext]) || []; }
function pick(id, qtext, label, multi) {
  sel[id] = sel[id] || {};
  var cur = sel[id][qtext] || [];
  if (multi) { var i = cur.indexOf(label); if (i<0) cur=cur.concat([label]); else cur=cur.filter(function(x){return x!==label;}); }
  else { cur = cur.length===1 && cur[0]===label ? [] : [label]; }
  sel[id][qtext] = cur; render(STATE);
}
function questionTile(q) {
  var h = '<div class="tile ask"><div class="row">' + dot('blocked') +
    '<span class="name">' + esc(q.name) + '</span>' +
    '<span class="word" style="color:var(--blocked)">ASKS</span></div>';
  var ready = q.questions.length > 0;
  q.questions.forEach(function(qq) {
    h += '<div class="q">' + esc(qq.question) + '</div><div class="opts">';
    var on = chosen(q.id, qq.question);
    if (!on.length) ready = false;
    qq.options.forEach(function(o) {
      var isOn = on.indexOf(o.label) >= 0;
      h += '<button class="opt' + (isOn?' on':'') + '" onclick="pick(this.dataset.i,this.dataset.q,this.dataset.l,' + (qq.multiSelect?'true':'false') + ')"' +
        ' data-i="' + esc(q.id) + '" data-q="' + esc(qq.question) + '" data-l="' + esc(o.label) + '">' +
        esc(o.label) + (o.description ? '<small>' + esc(o.description) + '</small>' : '') + '</button>';
    });
    h += '</div>';
  });
  h += '<div class="acts"><button class="send" ' + (ready?'':'disabled ') + 'onclick="answer(this.dataset.i)" data-i="' + esc(q.id) + '">Send</button>' +
    '<button class="decline" onclick="decline(this.dataset.i)" data-i="' + esc(q.id) + '">Decline</button></div></div>';
  return h;
}

function render(st) {
  STATE = st;
  var badge = document.getElementById('badge');
  badge.style.display = st.needsYou > 0 ? 'inline-block' : 'none';
  badge.textContent = st.needsYou;
  document.title = (st.needsYou > 0 ? '(' + st.needsYou + ') ' : '') + 'Agent Canvas';

  // Prune in-flight selections whose question is gone (answered elsewhere).
  var live = {}; st.questions.forEach(function(q){ live[q.id] = 1; });
  for (var k in sel) if (!live[k]) delete sel[k];

  var byId = {}; st.canvases.forEach(function(c){ byId[c.id] = c; });
  var groups = {}; // projectId -> { canvas, cards, approvals, questions }
  function bucket(pid) {
    if (!groups[pid]) groups[pid] = { cards: [], approvals: [], questions: [] };
    return groups[pid];
  }
  st.canvases.forEach(function(c){ bucket(c.id); });
  st.cards.forEach(function(k){ bucket(k.projectId || '_').cards.push(k); });
  st.approvals.forEach(function(a){ bucket(a.projectId || '_').approvals.push(a); });
  st.questions.forEach(function(q){ bucket(q.projectId || '_').questions.push(q); });

  // Canvas order: loudest attention first, then by name. Orphans ('_') last.
  var ids = Object.keys(groups).sort(function(a,b){
    var ca = byId[a], cb = byId[b];
    var ra = ca ? RANK[ca.attention]||0 : 0, rb = cb ? RANK[cb.attention]||0 : 0;
    if (ra !== rb) return rb - ra;
    return (ca?ca.name:'~').localeCompare(cb?cb.name:'~');
  });

  var out = '';
  ids.forEach(function(pid){
    var g = groups[pid], c = byId[pid];
    if (!c && !g.cards.length && !g.approvals.length && !g.questions.length) return;
    var git = '';
    if (c && c.branch) { git = esc(c.branch); if (c.dirty > 0) git += ' <span class="dirty">&bull;' + c.dirty + '</span>'; }
    out += '<div class="canvas"><div class="chead">' +
      '<span class="adot ' + (c ? c.attention : 'none') + '"></span>' +
      '<span class="cname">' + esc(c ? c.name : 'Unassigned') + '</span>' +
      (git ? '<span class="git">' + git + '</span>' : '') + '</div>';
    g.questions.forEach(function(q){ out += questionTile(q); });
    g.approvals.forEach(function(a){ out += approvalTile(a); });
    g.cards.forEach(function(k){ out += cardTile(k); });
    if (!g.questions.length && !g.approvals.length && !g.cards.length)
      out += '<div class="empty">idle</div>';
    out += '</div>';
  });
  var cv = document.getElementById('canvases');
  cv.innerHTML = out || '<div class="empty">no canvases yet</div>';

  var f = document.getElementById('feed');
  if (!st.feed.length) { f.className = 'empty'; f.textContent = 'nothing yet'; }
  else {
    f.className = '';
    f.innerHTML = st.feed.slice(0, 20).map(function(e) {
      return '<div class="tile"><div class="row">' + dot(e.status) +
             '<span class="name">' + esc(e.name) + '</span>' + word(e.status) +
             '<span class="age">' + rel(e.date) + '</span></div>' +
             '<div class="meta">' + esc(e.message) + '</div></div>';
    }).join('');
  }
}

function refresh() {
  fetch('state').then(function(r){ return r.json(); }).then(function(st) {
    document.getElementById('offline').style.display = 'none';
    render(st);
  }).catch(function() {
    document.getElementById('offline').style.display = 'inline';
  });
}
function decide(id, allow) {
  fetch('decide', { method: 'POST', body: JSON.stringify({ id: id, allow: allow }) }).then(refresh, refresh);
}
function answer(id) {
  var a = {}; var s = sel[id] || {};
  for (var q in s) if (s[q].length) a[q] = s[q].join(', ');
  delete sel[id];
  fetch('answer', { method: 'POST', body: JSON.stringify({ id: id, answers: a }) }).then(refresh, refresh);
}
function decline(id) {
  delete sel[id];
  fetch('decline', { method: 'POST', body: JSON.stringify({ id: id }) }).then(refresh, refresh);
}
// ---- Push: install-as-PWA then subscribe, gated behind a user tap (iOS) ----
function pushSupported() {
  return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
}
function updateEnable() {
  var b = document.getElementById('enable');
  var granted = ('Notification' in window) && Notification.permission === 'granted';
  b.style.display = (pushSupported() && !granted) ? 'inline-block' : 'none';
}
function urlB64(b) {
  var pad = '='.repeat((4 - b.length % 4) % 4);
  var s = (b + pad).replace(/-/g, '+').replace(/_/g, '/');
  var raw = atob(s), out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function enablePush() {
  if (!pushSupported()) { alert('Add to Home Screen first, then enable alerts.'); return; }
  navigator.serviceWorker.ready.then(function(reg) {
    return Notification.requestPermission().then(function(perm) {
      if (perm !== 'granted') return;
      return fetch('vapid').then(function(r){ return r.text(); }).then(function(key) {
        if (!key) { alert('Push not configured.'); return; }
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) })
          .then(function(sub) { return fetch('subscribe', { method: 'POST', body: JSON.stringify(sub) }); })
          .then(updateEnable);
      });
    });
  }).catch(function(e){ console.log(e); });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function(){});
updateEnable();
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`
