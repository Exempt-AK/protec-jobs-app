/* Keeps the app itself on the phone so it opens with no signal. Jobs are not kept here: the app keeps its own small copy.
 * Bump VERSION when a file changes so phones pick the new one up (the old copy is used once more, then replaced). */
var VERSION = 'pj-31';
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
/* Pre-load: the moment an alert arrives, fetch that conversation (and fresh jobs) while the phone is awake, and keep them in the phone's
 * database (IndexedDB 'pjsw'). The app copies them in when it opens, so a tap shows the texts at once instead of waiting 5-10 s.
 * The page leaves its link key, device pass and API address there (the worker can't read the page's localStorage). */
function kv(mode, fn) {
  return new Promise(function (ok) {
    try {
      var r = indexedDB.open('pjsw', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onerror = function () { ok(null); };
      r.onsuccess = function () { try { var q = fn(r.result.transaction('kv', mode).objectStore('kv')); q.onsuccess = function () { ok(q.result); }; q.onerror = function () { ok(null); }; } catch (x) { ok(null); } };
    } catch (x) { ok(null); }
  });
}
function apiGet(auth, req) {
  req.k = auth.k; req.d = auth.d || '';
  var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 25000);
  return fetch(auth.api + '?api=1&q=' + encodeURIComponent(JSON.stringify(req)), { signal: ctl.signal }).then(function (r) { clearTimeout(t); return r.json(); }).then(function (o) { return o && o.ok ? o : null; });
}
function preload(d) {
  var t0 = Date.now();
  return kv('readonly', function (st) { return st.get('auth'); }).then(function (auth) {
    if (!auth || !auth.k || !auth.d || (d.k && d.k !== auth.k)) return;   // not set up on this phone yet: the app loads it when opened
    var save = function (name) { return function (o) { return o && kv('readwrite', function (st) { return st.put({ t: Date.now(), d: o }, name); }); }; };
    var day = new Date(); day.setHours(0, 0, 0, 0);
    // Same asks the app's own background refresh makes (app.js preload): every tab ready before the phone is picked up.
    var more = function (office) {
      if (!office) return [];
      return [{ op: 'inbox' }, { op: 'requests' }, { op: 'pendList' }, { op: 'calendar', from: day.getTime() - 28 * 864e5, days: 84 }, { op: 'customers' }].map(function (q) { return apiGet(auth, q).then(save('op:' + q.op), function () {}); });
    };
    var th = d.phone ? apiGet(auth, { op: 'thread', phone: d.phone }).then(function (o) { return o && kv('readwrite', function (st) { return st.put({ t: Date.now(), msgs: o.msgs }, 'th:' + d.phone); }); }, function () {}) : Promise.resolve();
    var jobs = apiGet(auth, { op: 'jobs' }).then(function (o) { return save('op:jobs')(o).then(function () { return more(o && o.office); }); }, function () { return []; });
    return Promise.all([th, jobs.then(function (ps) { return Promise.all(ps); })]).then(function () { return kv('readwrite', function (st) { return st.put({ at: Date.now(), ms: Date.now() - t0 }, 'last'); }); });
  });
}
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data.json(); } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(Promise.all([preload(d).catch(function () {}), self.registration.showNotification(d.title || 'Protec', {
    body: d.body || '', tag: d.tag || 'protec', renotify: true, icon: 'icons/icon-192.png', data: { open: d.open || '', phone: d.phone || '', text: d.text || '', k: d.k || '' }
  })]));
});
self.addEventListener('notificationclick', function (e) {
  var open = (e.notification.data && e.notification.data.open) || '', phone = (e.notification.data && e.notification.data.phone) || '', text = (e.notification.data && e.notification.data.text) || '', k = (e.notification.data && e.notification.data.k) || '';
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) { list[i].postMessage({ open: open, phone: phone, text: text, k: k }); return list[i].focus(); }
    // The receiver's own link key rides in the address (#k=), so the office person gets the office My jobs and the tech the tech one.
    return self.clients.openWindow('./' + (open ? '?open=' + open + (phone ? '&phone=' + encodeURIComponent(phone) + '&t=' + encodeURIComponent(text) : '') : '') + (/^[a-f0-9]{32}$/.test(k) ? '#k=' + k : ''));
  }));
});
