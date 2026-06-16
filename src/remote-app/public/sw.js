// Minimal service worker: makes the panel installable + raises notifications
// from web-push. No precache — the app is tiny and always fetched fresh.
self.addEventListener('install', function () {
  self.skipWaiting()
})
self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim())
})
self.addEventListener('push', function (e) {
  var d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch (x) {}
  e.waitUntil(
    self.registration.showNotification(d.title || 'Agent Canvas', {
      body: d.body || 'A canvas needs you',
      icon: 'icon.svg',
      badge: 'icon.svg',
      data: d,
    }),
  )
})
self.addEventListener('notificationclick', function (e) {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function (cs) {
      for (var i = 0; i < cs.length; i++) if ('focus' in cs[i]) return cs[i].focus()
      if (self.clients.openWindow) return self.clients.openWindow('.')
    }),
  )
})
