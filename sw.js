/* Keeps the app itself on the phone so it opens with no signal. Jobs are not kept here: the app keeps its own small copy.
 * Bump VERSION when a file changes so phones pick the new one up (the old copy is used once more, then replaced). */
var VERSION = 'pj-24';
var FILES = ['./', 'index.html', 'app.js', 'style.css', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/logo.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // the sheet's requests always go to the network
  // Saved copy first so it opens at once, and a fresh copy is fetched behind it for next time.
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(e.request, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(e.request).then(function (r) { if (r && r.ok) c.put(e.request, r.clone()); return r; }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});

/* Phone alerts: the office's sheet sends {title, body, tag, open}. Shown even with the app closed. For a customer text the title is
 * who and the body is the start of their message; other alerts say in plain words what they are for. Same tag = one alert replaced, not a stack. */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data.json(); } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Protec', {
    body: d.body || '', tag: d.tag || 'protec', renotify: true, icon: 'icons/icon-192.png', data: { open: d.open || '' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  var open = (e.notification.data && e.notification.data.open) || '';
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) { list[i].postMessage({ open: open }); return list[i].focus(); }
    return self.clients.openWindow('./' + (open ? '?open=' + open : ''));
  }));
});
