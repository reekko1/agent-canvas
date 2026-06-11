import http from 'node:http'
import type { RemoteState } from '../../shared/types'

/// The remote panel: supervision — and the orbit Allow/Deny — from any device
/// on your tailnet. `GET /` serves a self-contained page, `GET /state` the
/// JSON snapshot, `POST /decide {id, allow}` answers a held permission ask.
///
/// It binds loopback only; reachability is deliberately a proxy's job:
/// `tailscale serve --bg localhost:<port>` adds TLS + tailnet identity.
/// **Never expose it publicly** (Funnel, port-forward): the Allow button
/// approves arbitrary tool calls on this machine. (Port of the Swift
/// RemoteServer.)
export class RemoteServer {
  /** A decision arriving from the panel — same authority as the in-app
   *  toasts, routed to the same spine.decide. */
  onDecide?: (askId: string, allow: boolean) => void

  port = 0
  private stateJSON = '{}'

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
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
      return
    }
    if (req.method === 'GET' && req.url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(this.stateJSON)
      return
    }
    if (req.method === 'POST' && req.url === '/decide') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (typeof obj.id !== 'string' || typeof obj.allow !== 'boolean') throw new Error()
          this.onDecide?.(obj.id, obj.allow)
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
        } catch {
          res.writeHead(400).end()
        }
      })
      return
    }
    res.writeHead(404).end()
  }
}

/// One self-contained dark page, phone-first: approvals you can answer, the
/// card fleet, the feed. Polls `/state` every 2s; fetches use relative paths
/// so it works behind whatever path Tailscale Serve mounts it on.
/// Colors mirror index.css's dark palette by hand — keep in sync.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Canvas</title>
<style>
  :root { --bg:#13111c; --body:#201f2a; --bar:#2a2836; --text:#eee9df; --muted:#92909f;
          --border:#393744; --blocked:#fbb636; --error:#f33f4c; --done:#76cd98; }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 15px/1.45 -apple-system, "Helvetica Neue", sans-serif;
         padding: 18px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 17px; letter-spacing: .02em; display: flex; align-items: center; gap: 10px; }
  h1 .badge { background: var(--blocked); color: #13111c; border-radius: 10px; padding: 1px 9px;
              font-size: 13px; font-weight: 700; display: none; }
  h2 { font-size: 11px; letter-spacing: .14em; color: var(--muted); margin: 22px 0 8px;
       font-family: ui-monospace, monospace; }
  h2.alert { color: var(--blocked); }
  .tile { background: var(--body); border: 1px solid var(--border); border-radius: 12px;
          padding: 11px 13px; margin-bottom: 8px; }
  .tile.loud { border-color: var(--blocked); box-shadow: 0 0 18px rgba(251,182,54,.18); }
  .tile.err { border-color: var(--error); box-shadow: 0 0 18px rgba(243,63,76,.2); }
  .row { display: flex; align-items: baseline; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; align-self: center; }
  .name { font-weight: 650; }
  .word { font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: .06em; }
  .age { color: var(--muted); font-size: 12px; margin-left: auto; flex: none;
         font-family: ui-monospace, monospace; }
  .meta { color: var(--muted); font-size: 12.5px; margin-top: 3px; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap; }
  .meta .bypass { color: var(--error); font-weight: 700; }
  .detail { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted);
            margin: 4px 0 9px; word-break: break-all; }
  button { font: 600 13px -apple-system, sans-serif; border-radius: 8px; padding: 6px 16px;
           border: 1px solid var(--border); background: transparent; color: var(--text); }
  button.allow { border-color: var(--done); color: var(--done); }
  button.deny { border-color: var(--error); color: var(--error); margin-left: 6px; }
  button:active { background: var(--bar); }
  .empty { color: var(--muted); font-size: 13px; padding: 6px 2px; }
  .offline { color: var(--error); font-size: 12px; display: none; margin-left: auto; }
</style>
</head>
<body>
<h1>Agent Canvas <span class="badge" id="badge"></span><span class="offline" id="offline">offline</span></h1>
<div id="approvalsWrap"></div>
<h2>AGENTS</h2><div id="cards" class="empty">…</div>
<h2>ACTIVITY</h2><div id="feed" class="empty">…</div>
<script>
var COLORS = { idle:'#807e90', running:'#48bfc0', waiting:'#92aae3', done:'#76cd98',
               stalled:'#d79a56', blocked:'#fbb636', error:'#f33f4c' };
function esc(s) { return String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function rel(t) { var s = Math.max(0, Math.floor(Date.now()/1000 - t));
  if (s < 60) return 'now'; if (s < 3600) return Math.floor(s/60)+'m';
  if (s < 86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
function dot(status) { return '<span class="dot" style="background:'+(COLORS[status]||'#807e90')+'"></span>'; }
function word(status) { return '<span class="word" style="color:'+(COLORS[status]||'#807e90')+'">'+esc(status).toUpperCase()+'</span>'; }

function render(st) {
  var badge = document.getElementById('badge');
  badge.style.display = st.needsYou > 0 ? 'inline-block' : 'none';
  badge.textContent = st.needsYou;
  document.title = (st.needsYou > 0 ? '(' + st.needsYou + ') ' : '') + 'Agent Canvas';

  var aw = document.getElementById('approvalsWrap'), h = '';
  if (st.approvals.length) {
    h = '<h2 class="alert">NEEDS APPROVAL</h2>';
    st.approvals.sort(function(a,b){ return a.created - b.created; }).forEach(function(a) {
      h += '<div class="tile loud"><div class="row">' + dot('blocked') +
           '<span class="name">' + esc(a.name) + '</span><span class="age">' + rel(a.created) + '</span></div>' +
           '<div class="detail">' + esc(a.detail) + '</div>' +
           '<button class="allow" onclick="decide(this.dataset.i,true)" data-i="' + esc(a.id) + '">Allow</button>' +
           '<button class="deny" onclick="decide(this.dataset.i,false)" data-i="' + esc(a.id) + '">Deny</button></div>';
    });
  }
  aw.innerHTML = h;

  var c = document.getElementById('cards');
  if (!st.cards.length) { c.className = 'empty'; c.textContent = 'no agents on the canvas'; }
  else {
    c.className = '';
    c.innerHTML = st.cards.map(function(k) {
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
    }).join('');
  }

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
  fetch('decide', { method: 'POST', body: JSON.stringify({ id: id, allow: allow }) })
    .then(refresh, refresh);
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`
