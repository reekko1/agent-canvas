/// CSRF token + the mutating-POST helper, shared by the supervision panel, the
/// orchestrator socket (orch.ts), and the push subscribe flow. The server issues
/// a per-process token from the unauthenticated GET /token; every mutating
/// request echoes it as x-canvas-token, and the WebSockets pass it as a `?token=`
/// query param (browsers can't set headers on a WS upgrade).

let TOKEN = ''

/** Fetch the CSRF token once, then cache it. */
export const ensureToken = (): Promise<string> =>
  TOKEN
    ? Promise.resolve(TOKEN)
    : fetch('token')
        .then((r) => r.text())
        .then((t) => (TOKEN = t))

/** Forget the cached token (the desktop rotated its per-process token on restart)
 *  — the next ensureToken() refetches. */
export const dropToken = (): void => {
  TOKEN = ''
}

/** POST JSON with the CSRF token. On a 404/401 (a stale token after the desktop
 *  restarted) drop the cache, refetch once, and retry — otherwise an open client
 *  would silently no-op every tap until reloaded. Errors are swallowed; the
 *  caller's own refresh surfaces an offline state. */
export const post = async (path: string, body: unknown): Promise<void> => {
  const send = (token: string): Promise<Response> =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-canvas-token': token },
      body: JSON.stringify(body),
    })
  try {
    let res = await send(await ensureToken())
    if (res.status === 404 || res.status === 401) {
      dropToken()
      res = await send(await ensureToken())
    }
  } catch {
    // network/offline
  }
}
