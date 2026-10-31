/* Protec My jobs (installable app, plan step 4: works offline).
 * Talks to the Apps Script "My jobs" web app (MyJobsApi.gs) with one personal key per tech.
 * Local first: a tap, report, tick or photo is saved on the phone at once and shown at once; a queue sends them to the
 * sheet in order whenever there is signal. Every change carries an opid, so a change sent twice is saved once. The view
 * is always the last jobs from the sheet with the waiting changes laid over them. Once the sheet has confirmed a change
 * it is deleted from the phone (queue, report draft, photo data), so nothing piles up.
 * Texting: a tech's texts and the customer's replies on a job go through the office line and the office Inbox (open from
 * Start drive to 1 hour after Job complete). An office person's link also gets an Inbox tab. */
(function () {
  'use strict';
  var API = (window.PROTEC && window.PROTEC.api) || '';
  var $ = function (id) { return document.getElementById(id); };
  var state = { d: null, srv: null, key: '', sheet: null, note: '', tab: 'jobs', inbox: null, reqs: null, cal: null, cust: null, pend: null, place: null, calDay: 0, calTech: '', calNeed: 120, custQ: '' };
  var Q = [], flushing = false, probs = [], reloaded = false;

  /* ---- small helpers ---- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function nowHM() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function hm12(v) { if (!v) return ''; var p = String(v).split(':'), h = +p[0]; return ((h + 11) % 12 + 1) + ':' + p[1] + (h < 12 ? ' AM' : ' PM'); }
  function opid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function ls(k, v) {
    try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    return null;
  }
  function toast(m) { var t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 4000); }

  /* ---- the personal link: https://jobs.protecsvc.com/#k=<key> ---- */
  function readKey() {
    var m = /[#&]k=([a-f0-9]{32})/.exec(location.hash);
    if (m) { ls('pj:key', m[1]); try { history.replaceState(null, '', location.pathname); } catch (e) {} }
    var k = (m && m[1]) || ls('pj:key') || '';
    return /^[a-f0-9]{32}$/.test(k) ? k : '';
  }
  // iPhone gives the Home Screen app its own storage, so the icon must open with the key in its address.
  function manifest() {
    var m = { name: 'Protec My jobs', short_name: 'My jobs', display: 'standalone', background_color: '#ffffff', theme_color: '#033863',
      start_url: location.origin + '/#k=' + state.key, scope: location.origin + '/',
      icons: [{ src: location.origin + '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: location.origin + '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }] };
    var l = document.createElement('link'); l.rel = 'manifest';
    l.href = URL.createObjectURL(new Blob([JSON.stringify(m)], { type: 'application/manifest+json' }));
    document.head.appendChild(l);
  }

  /* ---- talking to the office's sheet ---- */
  // Plain words for what a phone on a weak signal gets.
  function friendly(e) {
    var m = String(e && e.message || e || '');
    if (e && e.code === 'offline' || /network|failed to fetch|load failed|abort/i.test(m)) return 'No signal right now, so that was not saved. Try again when you have signal.';
    return m || 'Something went wrong. Try again.';
  }
  function call(req, readOnly) {
    req.k = state.key; req.d = ls('pj:dev:' + state.key.slice(0, 8)) || '';
    var ctl = window.AbortController ? new AbortController() : null, t = ctl && setTimeout(function () { ctl.abort(); }, 40000);
    var p = readOnly
      ? fetch(API + '?api=1&q=' + encodeURIComponent(JSON.stringify(req)), { signal: ctl && ctl.signal })
      // text/plain keeps this a "simple" request, so the browser doesn't need a permission check first.
      : fetch(API + '?api=1', { method: 'POST', body: JSON.stringify(req), signal: ctl && ctl.signal });
    return p.then(function (r) { clearTimeout(t); return r.json(); }, function (err) { clearTimeout(t); var e = new Error('offline'); e.code = 'offline'; e.detail = String(err && (err.name + ': ' + err.message) || '').slice(0, 120); throw e; })
      .then(function (o) { if (!o || !o.ok) { var e = new Error(o && o.error || 'Something went wrong.'); e.code = o && o.code; if (e.code === 'pin') pinScreen(o.need); throw e; } return o; });
  }

  /* ---- the PIN: typed once per phone, then this phone keeps a pass the office can cancel by resetting the link ---- */
  var pinShown = false;
  function pinScreen(need, msg) {
    if (pinShown && !msg) return;
    pinShown = true; state.sheet = null; $('sheet').hidden = true; $('tabs').hidden = true; $('bar').hidden = true;
    ls(cacheKey(), null); thClear();   // nothing of the jobs or texts stays on screen or at hand until the PIN is right
    var set = need === 'set';
    $('page').innerHTML = '<h2>Protec - My jobs</h2><div class="msg">' + (set ? 'Choose a PIN for this app: 4 to 6 numbers. You type it once on this phone and not again. Remember it; the office can reset it if you forget.' : 'Enter your PIN.') + '</div>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<label>' + (set ? 'New PIN' : 'PIN') + '<input id="pin1" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off"></label>' +
      (set ? '<label>Same PIN again<input id="pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off"></label>' : '') +
      '<button class="btn" id="pinok">' + (set ? 'Save PIN' : 'Open my jobs') + '</button>';
    $('pinok').onclick = function () {
      var a = $('pin1').value, b = set ? $('pin2').value : a;
      if (!/^\d{4,6}$/.test(a)) return pinScreen(need, 'The PIN must be 4 to 6 numbers.');
      if (a !== b) return pinScreen(need, 'The two PINs do not match.');
      $('pinok').disabled = true;
      call({ op: set ? 'pinSet' : 'pinEnter', pin: a }).then(function (o) {
        ls('pj:dev:' + state.key.slice(0, 8), o.dev); pinShown = false; $('page').innerHTML = '<h2>Protec - My jobs</h2><div class="msg">Loading your jobs...</div>'; load();
      }, function (e) {
        if (e.code === 'pin') return;   // sent back to the right screen already
        pinScreen(need, friendly(e));
      });
    };
  }

  /* ---- the queue: changes waiting to go to the sheet ---- */
  function cacheKey() { return 'pj:jobs:' + state.key.slice(0, 8); }
  function qKey() { return 'pj:q:' + state.key.slice(0, 8); }
  function qSave() { ls(qKey(), Q); }
  /* A text to a customer that sat in the queue longer than this is never sent by itself: what it says (on my way, a time) may no longer be true,
   * and if the first try went through and only the answer was lost, sending it again would text them twice. It waits here for a tap. */
  var HELD = [], TEXT_OPS = /^(textSend|send|enroute)$/, TEXT_MAX = 15 * 60e3;
  function heldKey() { return 'pj:held:' + state.key.slice(0, 8); }
  function heldSave() { ls(heldKey(), HELD); }
  function probSave() { ls('pj:prob:' + state.key.slice(0, 8), probs); }

  // Photos are too big for localStorage, so their data waits in IndexedDB (kept in memory if the phone has none).
  var mem = {}, idb = null;
  function db() {
    if (idb) return idb;
    idb = new Promise(function (ok) {
      try { var r = indexedDB.open('pj', 1); r.onupgradeneeded = function () { r.result.createObjectStore('p'); }; r.onsuccess = function () { ok(r.result); }; r.onerror = function () { ok(null); }; } catch (e) { ok(null); }
    });
    return idb;
  }
  function idbDo(mode, fn) {
    return db().then(function (d) { return new Promise(function (ok) {
      if (!d) return ok(null);
      try { var rq = fn(d.transaction('p', mode).objectStore('p')); rq.onsuccess = function () { ok(rq.result); }; rq.onerror = function () { ok(null); }; } catch (e) { ok(null); }
    }); });
  }
  function photoPut(id, v) { mem[id] = v; return idbDo('readwrite', function (st) { return st.put(v, id); }); }
  function photoGet(id) { return idbDo('readonly', function (st) { return st.get(id); }).then(function (v) { return v || mem[id] || null; }); }
  function photoDel(id) { delete mem[id]; return idbDo('readwrite', function (st) { return st.delete(id); }); }

  // Photos already on the job (from the office or the customer): kept on this phone at full size once seen, so they open with no signal.
  // Only photos of the jobs now on the list are kept; older ones leave the phone.
  function phIdx() { return ls('pj:phidx:' + state.key.slice(0, 8)) || []; }
  function phSave(url, data) {
    var ix = phIdx().filter(function (u) { return u !== url; }); ix.push(url);
    while (ix.length > 40) photoDel('ph:' + ix.shift());
    ls('pj:phidx:' + state.key.slice(0, 8), ix); return photoPut('ph:' + url, data);
  }
  function phFetch(id, url) {
    return photoGet('ph:' + url).then(function (v) {
      if (v) return v;
      return call({ op: 'photoGet', id: id, url: url }, true).then(function (o) { return phSave(url, o.dataUrl).then(function () { return o.dataUrl; }); });
    });
  }
  function phPrune() {
    if (!state.srv) return;
    var keep = {}; state.srv.late.concat(state.srv.today).forEach(function (j) { (j.photos || []).forEach(function (u) { keep[u] = 1; }); });
    var ix = phIdx(), left = ix.filter(function (u) { return keep[u]; });
    ix.forEach(function (u) { if (!keep[u]) photoDel('ph:' + u); });
    if (left.length !== ix.length) ls('pj:phidx:' + state.key.slice(0, 8), left);
  }
  // With a good connection the job's photos are fetched in the background, so they are already there when the tech taps them.
  function phPrefetch() {
    var c = navigator.connection, todo = [];
    if (!state.srv || phPrefetch.busy || navigator.onLine === false || (c && (c.saveData || /2g/.test(c.effectiveType || '')))) return;
    var have = {}; phIdx().forEach(function (u) { have[u] = 1; });
    state.srv.late.concat(state.srv.today).forEach(function (j) { (j.photos || []).forEach(function (u) { if (!have[u] && todo.length < 12) todo.push({ id: j.id, url: u }); }); });
    if (!todo.length) return;
    phPrefetch.busy = true;
    todo.reduce(function (chain, t) { return chain.then(function () { return phFetch(t.id, t.url).then(null, function () {}); }); }, Promise.resolve())
      .then(function () { phPrefetch.busy = false; });
  }
  function phList(id) {
    if (state.sheet && state.sheet.id === id && state.sheet.photos) return state.sheet.photos;
    var j = state.srv && jobIn(state.srv, id); return j ? j.photos || [] : [];
  }
  // Full-screen viewer: one photo at a time, pinch to zoom, Back / Next through the job's photos.
  function viewPhoto(id, i) {
    var list = phList(id), v = $('viewer');
    if (!list.length) return;
    i = Math.max(0, Math.min(list.length - 1, i));
    if (!v) { v = document.createElement('div'); v.id = 'viewer'; document.body.appendChild(v); }
    v.innerHTML = '<div class="vbar"><b>Photo ' + (i + 1) + ' of ' + list.length + '</b><span>' +
      (i > 0 ? '<button class="btn plain" data-act="phview" data-id="' + esc(id) + '" data-i="' + (i - 1) + '">Back</button>' : '') +
      (i < list.length - 1 ? '<button class="btn plain" data-act="phview" data-id="' + esc(id) + '" data-i="' + (i + 1) + '">Next</button>' : '') +
      '<button class="btn" data-act="phclose">Close</button></span></div><div class="vimg" id="vimg"><div class="muted">Loading the photo...</div></div>';
    v.hidden = false; v.setAttribute('data-at', i);
    phFetch(id, list[i]).then(function (data) {
      if (v.hidden || $('vimg') === null || v.getAttribute('data-at') !== String(i)) return;
      $('vimg').innerHTML = '<img alt="Photo ' + (i + 1) + '" src="' + data + '">';
    }, function (e) {
      if (v.hidden || $('vimg') === null || v.getAttribute('data-at') !== String(i)) return;
      $('vimg').innerHTML = '<div class="err">' + esc(e && e.code === 'offline' ? 'This photo is not on your phone yet and there is no signal. Try again with signal.' : friendly(e)) + '</div>';
    });
  }

  var STEPS = { drive: 'Start drive', arrived: 'Arrived', complete: 'Job complete' }, TRIP = { left: 'Finished for now', drive: 'Start drive', back: 'Arrived' };
  function jobIn(d, id) { var all = d.late.concat(d.today), i; for (i = 0; i < all.length; i++) if (all[i].id === id) return all[i]; return null; }
  // Same rule as the sheet's "next tap": a trip away in progress, else the first main step not tapped yet.
  function setNext(j) {
    if (j.late || j.done) { j.next = null; return; }
    var n = j.away.length, open = n && !j.away[n - 1].back ? j.away[n - 1] : null, k;
    if (open) { k = ['left', 'drive', 'back'].filter(function (x) { return !open[x]; })[0]; j.next = { key: k + ':' + n, label: TRIP[k], leaveKey: '' }; return; }
    k = ['drive', 'arrived', 'complete'].filter(function (x) { return !j.times[x]; })[0];
    j.next = k ? { key: k + ':' + n, label: STEPS[k], leaveKey: k === 'complete' ? 'left:' + n : '' } : null;
  }
  // What a waiting change looks like on the card, until the sheet confirms it.
  function applyLocal(d, r) {
    var j = jobIn(d, r.id); if (!j) return;
    if (r.op === 'tap') {
      var p = String(r.expect || '').split(':'), k = p[0], n = +p[1];
      if (k === 'left') j.away.push({ left: r.hhmm, drive: '', back: '' });
      else if (n >= 1 && (k === 'drive' || k === 'back') && j.away[n - 1]) j.away[n - 1][k] = r.hhmm;
      else j.times[k] = r.hhmm;
      setNext(j);
    } else if (r.op === 'undo') {
      var t = j.away[j.away.length - 1];
      if (!j.times.complete && t) { var x = ['back', 'drive', 'left'].filter(function (y) { return t[y]; })[0]; if (x === 'left') j.away.pop(); else t[x] = ''; }
      else { var y = ['complete', 'arrived', 'drive'].filter(function (z) { return j.times[z]; })[0]; if (y) j.times[y] = ''; }
      setNext(j);
    } else if (r.op === 'report') {
      j.done = true; j.canEdit = true; j.next = null; j.times = { drive: r.r.drive, arrived: r.r.arrived, complete: r.r.complete };
      j.away = (r.r.away || []).map(function (a) { return { left: a[0], drive: a[1], back: a[2] }; });
      j.report = { done: r.r.done, parts: r.r.parts, todo: r.r.todo, stamp: 'local' };
    } else if (r.op === 'todo') {
      j.todo.forEach(function (t) { if (t.id === r.todoId) t.lines.forEach(function (l) { if (l.n === r.n) l.done = r.undo ? '' : 'just now'; }); });
    } else if (r.op === 'enroute') {
      if (j.thread) j.thread.enroute = false;
    } else if (r.op === 'photoRemove') {
      j.photos = j.photos.filter(function (u) { return u !== r.url; });
    }
  }
  function rebuild() {
    if (!state.srv) { state.d = null; return; }
    var d = JSON.parse(JSON.stringify(state.srv));
    Q.forEach(function (r) { applyLocal(d, r); });
    state.d = d;
  }
  function replaceSrv(job) {
    var d = state.srv; if (!d || !job) return;
    ['late', 'today'].forEach(function (k) { d[k] = d[k].map(function (x) { return x.id === job.id ? job : x; }); });
  }
  function enqueue(req) {
    req.opid = req.opid || opid(); req.at = req.at || Date.now(); Q.push(req); qSave(); rebuild(); draw(); syncBar(); flush();
  }
  function queuedPhotos(id) { return Q.filter(function (r) { return r.op === 'photo' && r.id === id; }).length; }

  function send(r) {
    if (r.op !== 'photo') return call(JSON.parse(JSON.stringify(r)));
    return photoGet(r.opid).then(function (data) {
      if (!data) { var e = new Error('A photo was lost from this phone before it could be sent. Add it again.'); e.code = 'refused'; throw e; }
      return call({ op: 'photo', id: r.id, dataUrl: data, name: r.name, opid: r.opid });
    });
  }
  // The sheet confirmed a change: it is cleaned off the phone.
  function confirmed(r, o) {
    if (o.job) replaceSrv(o.job);
    else if (r.op === 'enroute' && state.srv) applyLocal(state.srv, r);   // the answer carries no job: what it did is kept
    if (r.op === 'report') ls('pj:draft:' + r.id, null);
    if (r.op === 'photo') {
      photoDel(r.opid);
      var j = state.srv && jobIn(state.srv, r.id); if (j && o.photos) j.photos = o.photos;
      if (state.sheet && state.sheet.id === r.id && o.photos) { state.sheet.photos = o.photos; renderPics(); }
    }
    if (/^(textSend|send|enroute)$/.test(r.op) && state.sheet && state.sheet.thread) refreshThread();
    if (r.op === 'junk') loadInbox(true);
    if (r.op === 'photoRemove') { var j2 = state.srv && jobIn(state.srv, r.id); if (j2 && o.photos) j2.photos = o.photos; }
  }
  // Sends the waiting changes one at a time, in order. No signal or a busy sheet: they stay and are tried again later.
  // A change the sheet refuses (job cancelled, report already accepted) can never go through: it is dropped and said so.
  function flush() {
    if (flushing || !Q.length) return Promise.resolve();
    flushing = true;
    var step = function () {
      if (!Q.length) return;
      var r = Q[0];
      if (TEXT_OPS.test(r.op)) {
        if (!r.at) { r.at = Date.now(); qSave(); }
        if (Date.now() - r.at > TEXT_MAX) { Q.shift(); HELD.push(r); qSave(); heldSave(); syncBar(); return step(); }
      }
      return send(r).then(function (o) { Q.shift(); qSave(); confirmed(r, o); rebuild(); draw(); syncBar(); return step(); }, function (e) {
        if (e.code === 'offline' || e.code === 'busy' || e.code === 'link' || e.code === 'pin') { if (e.code === 'link') state.note = esc(e.message); return; }
        Q.shift(); qSave(); if (r.op === 'photo') photoDel(r.opid);
        probs.push((r.op === 'report' ? 'The job report could not be sent: ' : r.op === 'tap' ? 'A tap could not be saved: ' : /^(textSend|send|enroute)$/.test(r.op) ? 'A text was not sent: ' : 'A change could not be saved: ') + friendly(e));
        probSave(); rebuild(); draw(); syncBar(); return step();
      });
    };
    return Promise.resolve(step()).then(function () { flushing = false; syncBar(); }, function () { flushing = false; syncBar(); });
  }

  /* ---- loading ---- */
  // The top bar: problems to read, changes waiting, and when the jobs shown were last read.
  function syncBar() {
    var parts = probs.map(function (p, i) { return esc(p) + ' <a href="#" data-act="probok" data-i="' + i + '">OK</a>'; });
    HELD.forEach(function (h, i) {
      var what = h.op === 'enroute' ? 'The "on my way" text' : 'A text' + (h.text ? ' (\u201c' + esc(String(h.text).slice(0, 60)) + (String(h.text).length > 60 ? '...' : '') + '\u201d)' : '');
      parts.push('<b>' + what + ' was not sent: it waited more than 15 minutes for signal.</b> <a href="#" data-act="heldsend" data-i="' + i + '">Send now</a> &middot; <a href="#" data-act="helddrop" data-i="' + i + '">Throw away</a>');
    });
    if (Q.length) parts.push(Q.length + ' change' + (Q.length > 1 ? 's' : '') + ' waiting to send to the office. They are saved on this phone. <a href="#" data-act="reload">Try now</a>');
    if (state.note) parts.push(state.note);
    var b = $('bar'); b.innerHTML = parts.join('<br>'); b.hidden = !parts.length;
  }
  function stamp(t) { var d = new Date(t); return hm12(pad(d.getHours()) + ':' + pad(d.getMinutes())); }
  function load(quiet) {
    if (state.sheet) return flush();
    return flush().then(function () {
      if (Q.length) return;   // still waiting on signal: the jobs shown stay as they are, with the waiting changes on them
      return call({ op: 'jobs' }, true).then(function (d) {
        state.srv = d; state.note = ''; ls(cacheKey(), { t: Date.now(), d: d }); rebuild(); draw(); syncBar(); phPrune(); phPrefetch();
        restoreView();
        if (state.openTab && d.office) { state.tab = state.openTab; state.openTab = ''; drawTabs(); if (state.tab === 'requests') { drawRequests(); loadRequests(); } else drawInbox(); }
        if (d.office && state.tab === 'inbox') loadInbox(true);
        if (d.office && state.tab === 'requests') loadRequests(true);
        if (d.office) preload();
      }, function (e) {
        if (e.code === 'pin') return;
        if (e.code === 'link') { $('page').innerHTML = '<h2>Protec - My jobs</h2><div class="msg">' + esc(e.message) + '</div>'; return; }
        var c = ls(cacheKey());
        if (state.d) { state.note = 'No signal. Showing your jobs as of ' + (c ? stamp(c.t) : 'earlier') + '. <a href="#" data-act="reload">Try again</a>' + (e.detail ? '<br><span class="muted">(' + esc(e.detail) + ')</span>' : ''); syncBar(); }
        else if (!quiet) $('page').innerHTML = '<h2>Protec - My jobs</h2><div class="msg">' + esc(friendly(e)) + ' <a href="#" data-act="reload">Try again</a>' + (e.detail ? '<br><span class="muted">(' + esc(e.detail) + ')</span>' : '') + '</div>';
      });
    });
  }

  /* ---- drawing ---- */
  function phones(list, id, badge) {
    return String(list || '').split(',').map(function (p) { return p.trim(); }).filter(function (p) { return p.replace(/\D/g, '').length >= 7; }).map(function (p) {
      var d = p.replace(/[^\d+]/g, '');
      return '<div class="ph"><div class="phn">' + esc(p) + '</div><div class="pb"><a class="pbtn" href="tel:' + d + '">Call</a><a class="pbtn" href="#" data-act="text" data-id="' + esc(id || '') + '" data-to="' + d.replace(/^\+?1?(\d{10})$/, '$1') + '">Text' + (badge || '') + '</a></div></div>';
    }).join('');
  }
  function visitsText(j) {
    var t = function (l, v) { return v ? l + ': <b>' + hm12(v) + '</b>' : ''; };
    var lines = [[t('Start drive', j.times.drive), t('Arrived', j.times.arrived)]];
    (j.away || []).forEach(function (a) {
      lines[lines.length - 1].push(t('Finished for now', a.left));
      lines.push([t('Start drive', a.drive), t('Arrived', a.back)]);
    });
    lines[lines.length - 1].push(t('Job complete', j.times.complete));
    return lines.map(function (l) { return l.filter(Boolean).join(' &middot; '); }).filter(Boolean).join('<br>');
  }
  function lastTap(j) {
    var trips = j.away || [], last = !j.times.complete && trips.length ? trips[trips.length - 1] : null;
    if (last) { var k = ['back', 'drive', 'left'].filter(function (x) { return last[x]; })[0]; return k ? { left: 'Finished for now', drive: 'Start drive', back: 'Arrived' }[k] + ' ' + hm12(last[k]) : ''; }
    var s = [['complete', 'Job complete'], ['arrived', 'Arrived'], ['drive', 'Start drive']].filter(function (x) { return j.times[x[0]]; })[0];
    return s ? s[1] + ' ' + hm12(j.times[s[0]]) : '';
  }
  // "New text" on a job when the customer replied after the tech last opened its texts (the time is kept on this phone).
  function seenMap() { return ls('pj:seen:' + state.key.slice(0, 8)) || {}; }
  function newBadge(j) {
    var t = j.thread; if (!t || !t.open || !t.lastInMs) return '';
    return t.lastInMs > (seenMap()[j.id] || 0) ? ' <span class="badge new">New text</span>' : '';
  }
  function jobCard(j) {
    var id = esc(j.id), h = '<div class="job' + (j.done ? ' done' : j.late ? ' late' : '') + (!j.done && j.times.drive ? ' now' : '') + (!j.done && !j.times.drive && state.d.today.some(function (o) { return o !== j && !o.done && o.times.drive; }) ? ' later' : '') + '" data-job="' + id + '">' + (j.done ? '<span class="badge">Report sent</span>' : '') +
      '<div class="when">' + (j.late ? esc(j.when.split(',').slice(0, 2).join(',')) + ', ' : '') + esc(j.range) + '</div><div class="name">' + esc(j.who) + '</div>' +
      (j.address ? '<div class="addr">' + esc(j.address) + '</div><a class="nav" href="#" data-act="nav" data-id="' + id + '">Navigate</a>' : '') +
      phones(j.phone, j.id, newBadge(j).replace(' <span class="badge new">New text</span>', ' <span class="dot">New</span>')) +
      (j.customer ? '<details class="cust"><summary>Customer</summary>' + esc(j.customer.name) + '<br>' + phones(j.customer.phone, j.id) +
        (j.customer.email ? '<a href="mailto:' + esc(j.customer.email) + '">' + esc(j.customer.email) + '</a><br>' : '') + '</details>' : '') +
      (j.with.length ? '<span class="muted">With: ' + esc(j.with.join(', ')) + '</span><br>' : '') +
      (j.no ? '<span class="muted">Job #' + esc(j.no) + '</span>' : '') +
      (j.note ? '<div class="notes anote"><b>Address note:</b> ' + esc(j.note) + '</div>' : '') +
      (j.job ? '<div class="notes">' + esc(j.job) + '</div>' : '') +
      (visitsText(j) ? '<div class="times">' + visitsText(j) + '</div>' : '');
    h += todoBox(j);
    if (j.photos && j.photos.length) h += '<button class="btn plain" data-act="phview" data-id="' + id + '" data-i="0">View photos (' + j.photos.length + ')</button>';
    if (j.visits.length) h += '<details class="past"><summary>Past visits here (' + j.visits.length + ')</summary>' + j.visits.map(function (v) { return visit(v); }).join('') + '</details>';
    if (j.canEdit) h += '<button class="btn plain" data-act="report" data-id="' + id + '">Change the job report</button><div class="muted" style="margin-top:6px">Sent. You can change it until the office accepts it.</div>';
    else if (j.done) h += '<button class="btn off" disabled>Job report sent</button>' + (j.photoOk ? '<a class="small" href="#" data-act="photos" data-id="' + id + '">Add photos (' + j.photos.length + ')</a>' : '');
    else if (j.next) {
      h += '<button class="btn" data-act="tap" data-id="' + id + '" data-key="' + esc(j.next.key) + '" data-label="' + esc(j.next.label) + '">' + esc(j.next.label) + '</button>' +
        (j.next.leaveKey ? '<button class="btn plain" data-act="tap" data-id="' + id + '" data-key="' + esc(j.next.leaveKey) + '" data-label="Finished for now" data-leave="1">Not finished, back later</button>' : '') +
        (j.canReport ? '<a class="small" href="#" data-act="report" data-id="' + id + '">Fill in the job report</a>' : '');
    } else h += '<button class="btn go" data-act="report" data-id="' + id + '">Fill in the job report</button>';
    if (!j.done && j.thread && j.thread.enroute) h += '<button class="btn plain sm" data-act="enroute" data-id="' + id + '">Text customer: on my way</button>';
    var lt = lastTap(j);
    if (lt && !j.done) h += ' <a class="small" style="margin-left:14px" href="#" data-act="undo" data-id="' + id + '" data-what="' + esc(lt) + '">Undo last tap</a>';
    return h + '</div>';
  }
  function todoBox(j) {
    if (!j.todo.length) return '';
    var box = function (t, l) {
      return '<label class="tick"><input type="checkbox" data-act="tick" data-id="' + esc(j.id) + '" data-todo="' + esc(t.id) + '" data-n="' + l.n + '" data-text="' + esc(l.text) + '"' + (l.done ? ' checked' : '') + '> <span>' +
        esc(l.text.slice(0, 300)) + (l.done ? ' <span class="muted">done ' + esc(l.done) + '</span>' : '') + '</span></label>';
    };
    var left = j.todo.filter(function (t) { return t.lines.some(function (l) { return !l.done; }); }), fin = [];
    j.todo.forEach(function (t) { t.lines.filter(function (l) { return l.done; }).forEach(function (l) { fin.push(box(t, l)); }); });
    return '<div class="todo' + (left.length ? '' : ' clear') + '"><b>' + (left.length ? 'Still to do here' : 'Nothing left to do here') + '</b>' +
      (left.length ? ' <span class="muted">(from reports not billed yet)</span>' : '') + left.map(function (t) {
        return '<div class="visit"><b>' + esc(t.date) + '</b>' + (t.who ? ' <span class="muted">' + esc(t.who) + '</span>' : '') +
          t.lines.filter(function (l) { return !l.done; }).map(function (l) { return box(t, l); }).join('') + '</div>';
      }).join('') + (fin.length ? '<details class="fin"><summary>Finished (' + fin.length + ')</summary>' + fin.join('') + '</details>' : '') + '</div>';
  }
  function visit(v) {
    return '<details class="visit"><summary><b>' + esc(v.date) + '</b>' + (v.employees ? ' <span class="muted">' + esc(v.employees) + '</span>' : '') +
      (v.did ? '<br><span class="muted">' + esc(v.did.slice(0, 200)) + '</span>' : '') + '</summary>' +
      (v.did ? '<div class="notes">' + esc(v.did) + '</div>' : '') +
      (v.todo.length ? '<div><b>To-dos</b>' + v.todo.map(function (l) { return '<div>' + (l.done ? '&#10003; ' : '&#9633; ') + esc(l.text.slice(0, 300)) + '</div>'; }).join('') + '</div>' : '') +
      (v.editable ? '<button class="btn sm" data-act="report" data-id="' + esc(v.id) + '">Edit report</button>' : '<button class="btn sm off" disabled>Edit report (can\'t be changed)</button>') + '</details>';
  }
  function draw() {
    var d = state.d; if (!d) return;
    drawTabs();
    if (state.tab === 'inbox' && d.office) return state.sheet ? undefined : drawInbox();
    if (state.tab === 'requests' && d.office) return state.sheet ? undefined : drawRequests();
    if (state.tab === 'cal' && d.office) return state.sheet ? undefined : drawCal();
    if (state.tab === 'cust' && d.office) return state.sheet ? undefined : drawCust();
    var h = '<div class="hdr"><img src="icons/logo.png" alt="Protec Services"><div class="hr"><b>' + esc(d.me.name) + '</b><div class="muted">' + esc(d.day) + '</div></div><a href="#" class="bell" data-act="reload" title="Refresh">&#8635;</a></div>' + pushRow();
    if (d.office) h += pendSection();
    if (d.late.length) h += '<h3 class="sec warn">Reports still to send</h3>' + d.late.map(jobCard).join('');
    h += '<h3 class="sec">Today</h3>' + (d.today.length ? d.today.map(jobCard).join('') : '<div class="msg">No jobs for you today.</div>');
    h += '<h3 class="sec">Coming up</h3>' + (d.ahead.length ? d.ahead.map(function (a) {
      return '<div class="ahead"><b>' + esc(a.when) + '</b> ' + esc(a.who) + (a.address ? '<br><span class="muted">' + esc(a.address) + '</span>' : '') + (a.job ? '<br><span class="muted">' + esc(a.job) + '</span>' : '') + '</div>';
    }).join('') : '<div class="muted">Nothing in the next 7 days.</div>');
    $('page').innerHTML = h;
  }

  /* ---- phone alerts (web push): a bell row on the Jobs page; works with the app closed once it is on the Home Screen ---- */
  var push = { mode: '' };   // '' not looked at yet, 'unsupported', 'ios' (add to Home Screen first), 'blocked', 'off', 'on'
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function keyBytes(s) {
    var p = (s + '===='.slice(s.length % 4 || 4)).replace(/-/g, '+').replace(/_/g, '/'), raw = atob(p), u = new Uint8Array(raw.length), i;
    for (i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    return u;
  }
  /** Works out which of the modes this phone is in, and quietly re-sends a saved address (once a day) so the office never loses it. */
  function pushLook() {
    if (!pushSupported()) {
      var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone;
      push.mode = ios ? 'ios' : 'unsupported'; return Promise.resolve();
    }
    if (Notification.permission === 'denied') { push.mode = 'blocked'; return Promise.resolve(); }
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      push.mode = sub && Notification.permission === 'granted' ? 'on' : 'off';
      var last = ls('pj:pushsent') || 0;
      if (sub && push.mode === 'on' && Date.now() - last > 18e5) call({ op: 'pushSub', sub: sub.toJSON() }).then(function () { ls('pj:pushsent', Date.now()); }, function () {});
    }).catch(function () { push.mode = 'off'; });
  }
  function pushRow() {
    if (push.mode === 'off') return '<button class="btn sm plain" data-act="alertson">&#128276; Turn on alerts for customer texts</button>';
    if (push.mode === 'on') return '';
    if (push.mode === 'ios') return '<div class="muted">To get alerts: tap the Share button, choose Add to Home Screen, and open My jobs from that icon.</div>';
    if (push.mode === 'blocked') return '<div class="muted">Alerts are blocked for this app. Turn them on in the phone\'s Settings, then open My jobs again.</div>';
    return '';
  }
  function alertsOn() {
    if (!pushSupported()) return;
    // Asking has to happen straight from the tap, so the phone will show its question.
    Notification.requestPermission().then(function (p) {
      if (p !== 'granted') { push.mode = p === 'denied' ? 'blocked' : 'off'; draw(); return; }
      // Each step says which one failed: a phone that cannot reach its own push service is not "no signal".
      var step = 'asking the office';
      return call({ op: 'pushKey' }).then(function (k) {
        step = 'registering with this phone\'s alert service';
        return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(k.key) }); });
      }).then(function (sub) { step = 'saving this phone at the office'; return call({ op: 'pushSub', sub: sub.toJSON() }); }).then(function () {
        ls('pj:pushsent', Date.now()); push.mode = 'on'; toast('Alerts are on.'); draw();
      }).catch(function (e) {
        var why = e && e.code === 'offline' ? 'no answer from the office: ' + (e.detail || '') : String(e && (e.name ? e.name + ': ' : '') + (e.message || e)).slice(0, 160);
        toast('Alerts could not be turned on while ' + step + ' (' + why + ').');
      });
    }).catch(function (e) { toast(friendly(e)); });
  }
  function alertsOff() {
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      if (!sub) return;
      var ep = sub.endpoint;
      return sub.unsubscribe().then(function () { return call({ op: 'pushOff', endpoint: ep }); });
    }).then(function () { push.mode = 'off'; draw(); }, function (e) { toast(friendly(e)); });
  }

  /* ---- finding a job or visit by id ---- */
  function findJob(id) {
    var d = state.d, all = d ? d.late.concat(d.today) : [], hit = null;
    all.forEach(function (j) {
      if (j.id === id) hit = { id: j.id, title: j.who, when: j.when, times: j.times, away: j.away, photos: j.photos, report: j.report || null, sent: j.canEdit, photoOk: j.photoOk };
      j.visits.forEach(function (v) {
        if (v.id === id && v.report) hit = { id: v.id, title: j.who, when: v.date, times: v.report.times, away: v.report.away, photos: v.report.photos, report: v.report, sent: true, photoOk: false };
      });
    });
    return hit;
  }
  /* ---- sheets (time pop-up, job report) ---- */
  function openSheet(h) { state.sheet = true; var s = $('sheet'); s.innerHTML = h; s.hidden = false; s.scrollTop = 0; }
  function closeSheet() { state.sheet = null; $('sheet').hidden = true; $('sheet').innerHTML = ''; }
  function sheetErr(m) { var e = $('sErr'); if (e) e.innerHTML = m ? '<div class="err">' + esc(m) + '</div>' : ''; }
  var gone = /not on your list any more|already sent the report|already accepted|changed this report after you opened|too old/;

  // The latest time already tapped on a job ("HH:mm"), so a time before it can be caught while the tech is still there to fix it.
  function lastTime(j) {
    var all = [j.times.drive, j.times.arrived, j.times.complete];
    (j.away || []).forEach(function (a) { all.push(a.left, a.drive, a.back); });
    return all.filter(Boolean).sort().pop() || '';
  }
  function timeProblem(j, t, label) {
    var d = new Date(), soon = new Date(d.getTime() + 15 * 60000), lim = pad(soon.getHours()) + ':' + pad(soon.getMinutes());
    if (soon.getDate() === d.getDate() && t > lim) return hm12(t) + ' hasn\'t happened yet. Check the time (AM or PM?).';
    var last = lastTime(j);
    if (last && t < last) return label + ' can\'t be before ' + hm12(last) + '. Check the time.';
    return '';
  }
  function askTime(id, key, label, leave) {
    var j = jobIn(state.d, id); if (!j) return load();
    openSheet('<div class="card low"><div style="font-weight:bold;font-size:18px">' + esc(label) + ' at:</div>' +
      '<input id="sTime" type="time" value="' + nowHM() + '" style="margin:12px 0"><div id="sErr"></div>' +
      '<button class="btn" id="sGo">Save</button><button class="btn plain" data-act="timecancel">Cancel</button></div>');
    $('sGo').onclick = function () {
      var t = $('sTime').value; if (!t) return;
      var bad = timeProblem(j, t, label); if (bad) return sheetErr(bad);
      // Saved on the phone and shown at once; the queue sends it to the office whenever there is signal.
      closeSheet(); enqueue({ op: 'tap', id: id, hhmm: t, expect: key, leave: !!leave });
      if (/^drive:/.test(key)) askNotify(id); else mapAfter = '';
      if (!state.sheet) mapNow();   // no on-my-way question to answer first
    };
  }

  /* Navigate: the tech picks Map only, or Map and start drive (which then offers the on-my-way text). */
  function mapUrl(j) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(j.address || ''); }
  // "Map and start drive": the map opens last, after the time is saved and the on-my-way text is answered.
  var mapAfter = '';
  function mapNow() { if (mapAfter) { var u = mapAfter; mapAfter = ''; window.open(u, 'protecmap'); } }
  function navSheet(id) {
    var j = jobIn(state.d, id); if (!j) return load();
    var canDrive = j.next && /^(drive):/.test(j.next.key);
    openSheet('<div class="card low"><div style="font-weight:bold;font-size:18px">' + esc(j.address) + '</div>' +
      '<button class="btn plain" data-act="mapgo" data-id="' + esc(id) + '">Map only</button>' +
      (canDrive ? '<button class="btn" data-act="mapdrive" data-id="' + esc(id) + '">Map and start drive</button>' : '<div class="muted" style="margin-top:10px">You already started this drive.</div>') +
      '<button class="btn plain" data-act="close">Cancel</button></div>');
  }
  // After Start drive is saved: offer the on-my-way text (the office line, once per visit). Skipped when texting is closed or no cell number.
  function askNotify(id) {
    var j = jobIn(state.d, id);
    if (!j || !j.thread || !j.thread.open || !j.thread.phones || !j.thread.phones.length) return;
    openSheet('<div class="card low"><div style="font-weight:bold;font-size:18px">Tell ' + esc(j.who) + ' you are on the way?</div>' +
      '<div class="muted" style="margin-top:6px">They get a text from Protec Services with your first name.</div>' +
      '<button class="btn" data-act="notifyyes" data-id="' + esc(id) + '">Yes, send the text</button><button class="btn plain" data-act="notifyno">No</button></div>');
  }

  function tripRow(t) {
    t = t || {};
    var f = function (k, label) { return '<div><label>' + label + '</label><input type="time" class="tr-' + k + '" value="' + esc(t[k] || '') + '"></div>'; };
    return '<div class="trip"><div class="row3">' + f('left', 'Finished for now') + f('drive', 'Start drive') + f('back', 'Arrived') + '</div>' +
      '<a class="small" href="#" data-act="tripdel">Remove this visit</a></div>';
  }
  function renderPics() {
    var s = state.sheet, n = s && s.id ? queuedPhotos(s.id) : 0;
    if ($('rPics')) $('rPics').innerHTML = picsHtml(s.photos) + (n ? '<div class="pic">' + n + ' photo' + (n > 1 ? 's' : '') + ' waiting to send</div>' : '');
    if (n) Q.filter(function (r) { return r.op === 'photo' && r.id === s.id; }).forEach(function (r) {
      photoGet(r.opid).then(function (d) { var b = $('rPics'); if (d && b && state.sheet === s) b.insertAdjacentHTML('beforeend', '<img class="thumb" alt="Waiting to send" src="' + d + '">'); });
    });
  }
  function picsHtml(list) {
    return (list || []).map(function (u, i) { return '<div class="pic"><a href="#" data-act="phview" data-id="' + esc(state.sheet && state.sheet.id || '') + '" data-i="' + i + '">Photo ' + (i + 1) + '</a>' +
      (state.sheet && state.sheet.canDel ? ' <a href="#" data-act="picdel" data-url="' + esc(u) + '">remove</a>' : '') + '</div>'; }).join('');
  }
  function reportSheet(id, photosOnly) {
    var j = findJob(id); if (!j) return load();
    var d = ls('pj:draft:' + id);
    if (d && j.sent && j.report && d.stamp !== j.report.stamp) d = null;     // an older change typed over a report the office has since changed
    d = d || (j.sent && j.report ? { done: j.report.done, parts: j.report.parts, todo: j.report.todo } : {});
    var trips = d.away ? d.away.map(function (t) { return { left: t[0], drive: t[1], back: t[2] }; }) : (j.away || []);
    openSheet('<div class="card"><div style="font-weight:bold;font-size:18px">' + (photosOnly ? 'Photos: ' : j.sent ? 'Change job report: ' : 'Job report: ') + esc(j.title) + '</div><div class="muted">' + esc(j.when) + '</div>' +
      '<div id="rFields"' + (photosOnly ? ' hidden' : '') + '><div class="row3"><div><label>Start drive</label><input type="time" id="rDrive" value="' + esc(d.drive || j.times.drive || '') + '"></div>' +
      '<div><label>Arrived</label><input type="time" id="rArr" value="' + esc(d.arrived || j.times.arrived || '') + '"></div>' +
      '<div><label>Job complete</label><input type="time" id="rDone" value="' + esc(d.complete || j.times.complete || (j.times.arrived ? nowHM() : '')) + '"></div></div>' +
      '<div id="rTrips">' + trips.map(tripRow).join('') + '</div><a class="small" href="#" data-act="tripadd">+ Came back later (another visit)</a>' +
      '<label>What was done</label><textarea id="rWhat" rows="4">' + esc(d.done || '') + '</textarea>' +
      '<label>Parts and materials</label><textarea id="rParts" rows="3">' + esc(d.parts || '') + '</textarea>' +
      '<label>Still to do (if anything)</label><textarea id="rTodo" rows="2">' + esc(d.todo || '') + '</textarea></div>' +
      '<label>Photos</label><div class="pics" id="rPics">' + picsHtml(j.photos) + '</div>' +
      '<input type="file" id="rFile" accept="image/*" multiple hidden><button class="btn plain" data-act="addphoto">Add photos</button>' +
      '<div id="sErr"></div>' +
      (photosOnly ? '' : '<button class="btn go" id="rSend">' + (j.sent ? 'Save the changes' : 'Send the job report') + '</button>') +
      '<button class="btn plain" data-act="close">' + (photosOnly ? 'Done' : 'Close (your answers are kept)') + '</button></div>');
    state.sheet = { id: id, job: j, sent: j.sent, photos: (j.photos || []).slice(), uploads: 0, canDel: j.photoOk !== false };
    renderPics();
    $('rFile').onchange = function () { addPhotos(this.files); this.value = ''; };
    if ($('rSend')) $('rSend').onclick = sendReport;
    var keep = function () { keepDraft(); };
    $('sheet').oninput = keep;
  }
  function tripsRead() {
    return [].map.call(document.querySelectorAll('#rTrips .trip'), function (r) { return ['left', 'drive', 'back'].map(function (k) { return r.querySelector('.tr-' + k).value; }); });
  }
  function keepDraft() {
    var s = state.sheet; if (!s || !s.id || !$('rWhat')) return;
    ls('pj:draft:' + s.id, { drive: $('rDrive').value, arrived: $('rArr').value, complete: $('rDone').value, away: tripsRead(), done: $('rWhat').value,
      parts: $('rParts').value, todo: $('rTodo').value, stamp: s.job.report && s.job.report.stamp });
  }
  function sendReport() {
    var s = state.sheet; if (!s) return;
    var r = { drive: $('rDrive').value, arrived: $('rArr').value, complete: $('rDone').value, done: $('rWhat').value, parts: $('rParts').value, todo: $('rTodo').value, away: tripsRead() };
    if (r.away.some(function (t) { return t.some(function (v) { return !v; }); })) return sheetErr('Fill in all three times for each trip away, or remove the trip.');
    if (!r.drive || !r.arrived || !r.complete) return sheetErr('Fill in all three times.');
    if (!r.done.trim()) return sheetErr('Fill in What was done.');
    var id = s.id, waiting = Q.filter(function (q) { return q.op === 'report' && q.id === id; })[0];
    if (waiting) {
      // This report hasn't reached the office yet: the newer answers take its place.
      waiting.r = r; if (s.sent && s.job.report && s.job.report.stamp !== 'local') { r.edit = true; r.was = s.job.report.stamp; }
      qSave(); closeSheet(); rebuild(); draw(); syncBar(); flush(); return;
    }
    if (s.sent) { r.edit = true; r.was = s.job.report && s.job.report.stamp; }
    // Saved on the phone and shown as sent at once. The answers stay as a draft until the office has them.
    closeSheet(); enqueue({ op: 'report', id: id, r: r });
  }

  /* ---- photos: made smaller on the phone first, sent one at a time, nothing kept on the phone afterwards ---- */
  function shrink(file) {
    return new Promise(function (ok, no) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var m = 1600, w = img.width, h = img.height, k = Math.min(1, m / Math.max(w, h)), c = document.createElement('canvas');
        c.width = Math.round(w * k); c.height = Math.round(h * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); ok(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = function () { URL.revokeObjectURL(url); no(new Error('That photo could not be read. Try taking it again.')); };
      img.src = url;
    });
  }
  function addPhotos(files) {
    var s = state.sheet; if (!s) return;
    [].slice.call(files).reduce(function (chain, f) {
      return chain.then(function () {
        var o = opid();
        return shrink(f).then(function (data) { return photoPut(o, data); }).then(function () {
          Q.push({ op: 'photo', id: s.id, name: f.name || 'photo.jpg', opid: o }); qSave(); renderPics(); syncBar(); flush();
        }, function (e) { sheetErr(friendly(e)); });
      });
    }, Promise.resolve());
  }

  /* ---- texting: a job's conversation (tech) and the Inbox (office link) ---- */
  function msgMs(m) { return m.ms || m.time || 0; }
  function paintThread() {
    var s = state.sheet; if (!s || !s.thread || !$('tMsgs')) return;
    var list = (s.msgs || []).map(function (m) { return { ms: msgMs(m), dir: m.dir, text: m.text, bad: /fail/i.test(m.status || '') }; });
    // Texts still waiting on this phone to go out show at the bottom, marked as sending.
    Q.forEach(function (r) {
      if ((s.kind === 'job' && r.op === 'textSend' && r.id === s.id) || (s.kind === 'office' && r.op === 'send' && r.phone === s.phone)) list.push({ ms: 9e15, dir: 'Out', text: r.text, wait: true });
      if (s.kind === 'job' && r.op === 'enroute' && r.id === s.id) list.push({ ms: 9e15, dir: 'Out', text: 'On-my-way text', wait: true });
    });
    list.sort(function (a, b) { return a.ms - b.ms; });
    var box = $('tMsgs'), atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = list.length ? list.map(function (m) {
      var when = m.wait ? 'Sending...' : new Date(m.ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      return '<div class="bub ' + (m.dir === 'In' ? 'in' : 'out') + (m.bad ? ' bad' : '') + '">' + esc(m.text) + '<span>' + esc(when) + (m.bad ? ' - not delivered' : '') + '</span></div>';
    }).join('') : '<div class="muted">' + (s.msgs ? 'No texts yet.' : 'Loading...') + '</div>';
    if (atEnd || !s.scrolled) { box.scrollTop = box.scrollHeight; s.scrolled = true; }
    if (s.note) $('tNote').innerHTML = esc(s.note);
  }
  // Conversations kept on the phone so a thread opens already filled in; the newest texts then load behind it.
  function thKey(s) { return 'pj:th:' + state.key.slice(0, 8) + ':' + (s.kind === 'job' ? 'j' + s.id : 'p' + s.phone); }
  function thSave(s, msgs) {
    var k = thKey(s), idx = ls('pj:thidx:' + state.key.slice(0, 8)) || [];
    ls(k, { t: Date.now(), msgs: (msgs || []).slice(-60) });
    idx = idx.filter(function (x) { return x !== k; }); idx.push(k);
    while (idx.length > 15) ls(idx.shift(), null);   // oldest conversations leave the phone
    ls('pj:thidx:' + state.key.slice(0, 8), idx);
  }
  function thClear() { var q = 'pj:thidx:' + state.key.slice(0, 8); (ls(q) || []).forEach(function (k) { ls(k, null); }); ls(q, null); }
  // The office Inbox fills the cache for its top conversations in the background, so tapping one shows its texts at once.
  function prefetchThreads() {
    if (!state.inbox || prefetchThreads.busy) return;
    var list = state.inbox.convs.filter(function (c) { return !c.junk; }).slice(0, 6).filter(function (c) {
      var h = ls(thKey({ kind: 'office', phone: c.phone })); return !h || !h.last || h.last !== (c.last && c.last.text) + '|' + (c.last && c.last.time);
    });
    prefetchThreads.busy = true;
    list.reduce(function (chain, c) {
      return chain.then(function () {
        return call({ op: 'thread', phone: c.phone }, true).then(function (o) {
          thSave({ kind: 'office', phone: c.phone }, o.msgs);
          var h = ls(thKey({ kind: 'office', phone: c.phone })); h.last = (c.last && c.last.text) + '|' + (c.last && c.last.time); ls(thKey({ kind: 'office', phone: c.phone }), h);
        }, function () {});
      });
    }, Promise.resolve()).then(function () { prefetchThreads.busy = false; }, function () { prefetchThreads.busy = false; });
  }
  function refreshThread() {
    var s = state.sheet; if (!s || !s.thread) return;
    call(s.kind === 'job' ? { op: 'texts', id: s.id } : { op: 'thread', phone: s.phone }, true).then(function (o) {
      if (state.sheet !== s) return;
      s.msgs = o.msgs; thSave(s, o.msgs); s.note = o.stopped ? 'This number replied STOP, so it can\'t be texted.' : (s.kind === 'job' && o.thread && !o.thread.open ? 'Texting for this job is closed. Call the customer or the office.' : '');
      if ($('tNote')) $('tNote').textContent = s.note;
      paintThread();
      if (s.kind === 'job' && o.msgs.length) { var m = seenMap(); m[s.id] = Date.now(); ls('pj:seen:' + state.key.slice(0, 8), m); }
    }, function (e) { if (state.sheet === s) { s.note = e.code === 'offline' ? 'No signal. Texts you write are saved and sent when you have signal.' : friendly(e); if (!s.msgs) s.msgs = []; paintThread(); } });
  }
  function threadSheet(kind, id, to, title, phone) {
    var j = kind === 'job' ? jobIn(state.d, id) : null;
    if (kind === 'job') {
      if (!j || !j.thread) return;
      if (!j.thread.open) return toast('Texting is open on the day of the job, until an hour after your last job. Until then, call the customer.');
      title = j.who; phone = to || j.thread.phones[0].digits;
    }
    openSheet('<div class="card"><div style="font-weight:bold;font-size:18px">' + esc(title) + '</div><div class="muted">' + esc(kind === 'job' ? 'Texts go out from the Protec office number. Replies come to you here and to the office.' : phone) + '</div>' +
      '<div id="tMsgs" class="thread"></div><div id="tNote" class="muted"></div>' +
      '<textarea id="tText" rows="2" placeholder="Write a text"></textarea><button class="btn" id="tSend">Send</button>' +
      (kind !== 'job' && state.srv && state.srv.office ? '<a href="#" class="btn plain" data-act="mkjob" data-name="' + esc(title) + '" data-phone="' + esc(phone) + '">Make a job for this customer</a>' + junkBtn(phone) : '') +
      '<button class="btn plain" data-act="close">Close</button></div>');
    state.sheet = { thread: true, kind: kind, id: id, phone: phone, msgs: null, scrolled: false, note: '' };
    var held = ls(thKey(state.sheet)); if (held && held.msgs) state.sheet.msgs = held.msgs;   // shown at once; fresh texts replace it in a moment
    $('tText').onkeydown = function (ev) { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('tSend').click(); } };   // Enter sends; Shift+Enter is a new line
    $('tSend').onclick = function () {
      var text = $('tText').value.trim(); if (!text) return;
      $('tText').value = '';
      enqueue(kind === 'job' ? { op: 'textSend', id: id, to: phone, text: text } : { op: 'send', phone: phone, text: text });
      paintThread();
    };
    paintThread(); refreshThread();
  }
  function loadInbox(quiet) {
    if (!state.srv || !state.srv.office) return Promise.resolve();
    return call({ op: 'inbox' }, true).then(function (o) {
      state.inbox = o; ls('pj:inbox:' + state.key.slice(0, 8), { t: Date.now(), d: o }); drawTabs(); prefetchThreads();
      if (state.tab === 'inbox' && !state.sheet) drawInbox();
    }, function (e) { if (!quiet && state.tab === 'inbox' && !state.inbox) $('page').innerHTML = '<h2>Inbox</h2><div class="msg">' + esc(friendly(e)) + ' <a href="#" data-act="reload">Try again</a></div>'; });
  }
  // Junk, same rule as the office page: offered for a number that is not a customer yet, and for one already in Junk (to put it back).
  function convOf(phone) { return ((state.inbox && state.inbox.convs) || []).filter(function (c) { return c.phone === phone; })[0]; }
  function junkBtn(phone) {
    var c = convOf(phone); if (!c || (c.name && !c.junk)) return '';
    return '<a href="#" class="btn plain" data-act="junk" data-phone="' + esc(phone) + '" data-on="' + (c.junk ? '' : '1') + '">' + (c.junk ? 'Not junk: back to the Inbox' : 'Move to Junk') + '</a>';
  }
  // Shown at once; the save waits in the queue like a text, so a dropped signal loses nothing (repeating it changes nothing).
  function junkSet(phone, on) {
    if (on && !confirm('Move this number to Junk? Its texts stay saved and no longer alert you. You can move it back any time.')) return;
    var c = convOf(phone); if (c) { c.junk = on; ls('pj:inbox:' + state.key.slice(0, 8), { t: Date.now(), d: state.inbox }); }
    closeSheet(); drawInbox();
    enqueue({ op: 'junk', phone: phone, on: on });
  }
  function drawInbox() {
    var o = state.inbox;
    if (!o) { $('page').innerHTML = '<h2>Inbox</h2><div class="msg">Loading...</div>'; return; }
    var rows = o.convs.filter(function (c) { return !c.junk; }), junk = o.convs.filter(function (c) { return c.junk; });
    var row = function (c) {
      return '<a href="#" class="conv" data-act="conv" data-phone="' + esc(c.phone) + '" data-name="' + esc(c.name || c.phone) + '"><b>' + esc(c.name || c.phone) + '</b>' + (c.unread && !c.junk ? ' <span class="badge new">' + c.unread + ' new</span>' : '') +
        '<br><span class="muted">' + (c.last.dir === 'Out' ? 'You: ' : '') + esc(c.last.text) + '</span></a>';
    };
    $('page').innerHTML = '<h2>Inbox</h2><div class="muted"><a href="#" data-act="reload">Refresh</a></div>' + (rows.length ? rows.map(row).join('') : '<div class="msg">No texts yet.</div>') +
      (junk.length ? '<p><a href="#" data-act="junkopen">' + (state.junkOpen ? 'Hide' : 'Show') + ' Junk (' + junk.length + ')</a></p>' + (state.junkOpen ? junk.map(row).join('') : '') : '');
  }
  /* ---- service requests (office link): the website form's requests, red until someone handles them ---- */
  function ago(ms) {
    var m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago' : new Date(ms).toLocaleDateString();
  }
  function loadRequests(quiet) {
    if (!state.srv || !state.srv.office) return Promise.resolve();
    return call({ op: 'requests' }, true).then(function (o) {
      state.reqs = o; ls('pj:reqs:' + state.key.slice(0, 8), { t: Date.now(), d: o }); drawTabs();
      if (state.tab === 'requests' && !state.sheet) drawRequests();
    }, function (e) { if (!quiet && state.tab === 'requests' && !state.reqs) $('page').innerHTML = '<h2>Requests</h2><div class="msg">' + esc(friendly(e)) + ' <a href="#" data-act="reload">Try again</a></div>'; });
  }
  function reqCard(r) {
    var mins = Math.floor((Date.now() - r.time) / 60000), tel = r.phone.replace(/\D/g, ''), fresh = r.status === 'New';
    var warn = (r.note || '').split(' · ').filter(function (x) { return x.indexOf('Past customer') !== 0; }).join(' · ');
    return '<div class="req' + (fresh ? ' fresh' + (mins >= 60 ? ' old' : mins >= 15 ? ' late' : '') : '') + '"><b>' + esc(r.name) + '</b> <span class="badge' + (fresh ? ' new' : '') + '">' + esc(r.status) + '</span> <span class="muted">' + ago(r.time) + '</span>' +
      (r.customer ? '<div class="muted">Past customer: ' + esc(r.customer) + '</div>' : '') + (warn ? '<div class="msg">' + esc(warn) + '</div>' : '') +
      '<div>' + esc(r.phone) + (r.email ? ' &middot; ' + esc(r.email) : '') + '</div><div>' + esc(r.address || '(no address given)') + '</div>' +
      '<div class="notes">' + esc(r.what) + '</div>' + (r.when ? '<div>Best times: <b>' + esc(r.when) + '</b></div>' : '') +
      '<div class="btnrow"><a class="btn" href="tel:' + tel + '" data-act="reqcall" data-id="' + esc(r.id) + '">Call</a>' +
      (r.textOk || r.customer ? '<a href="#" class="btn" data-act="conv" data-name="' + esc(r.name) + '" data-phone="' + esc(r.phone) + '">Text</a>' : '') +
      (r.status === 'New' || r.status === 'Called' ? '<a href="#" class="btn go" data-act="mkreq" data-id="' + esc(r.id) + '">Make a job</a>' : '') +
      (r.status === 'Not a fit' || r.status === 'Booked' ? '<a href="#" class="btn" data-act="reqset" data-id="' + esc(r.id) + '" data-status="New">Back to New</a>' : '<a href="#" class="btn" data-act="reqset" data-id="' + esc(r.id) + '" data-status="Not a fit" data-ask="1">Not a fit</a>') + '</div></div>';
  }
  function drawRequests() {
    var o = state.reqs;
    if (!o) { $('page').innerHTML = '<h2>Requests</h2><div class="msg">Loading...</div>'; return; }
    var open = o.rows.filter(function (r) { return r.status === 'New' || r.status === 'Called'; });
    var done = o.rows.filter(function (r) { return r.status !== 'New' && r.status !== 'Called'; });
    $('page').innerHTML = '<h2>Requests</h2><div class="muted"><a href="#" data-act="reload">Refresh</a></div>' +
      (open.length ? open.map(reqCard).join('') : '<div class="msg">Nothing waiting. New requests from the website show up here.</div>') +
      (done.length ? '<p><a href="#" data-act="reqold">' + (state.reqOld ? 'Hide' : 'Show') + ' handled requests (' + done.length + ')</a></p>' + (state.reqOld ? done.map(reqCard).join('') : '') : '');
  }
  function reqSet(id, status) {
    call({ op: 'requestSet', id: id, status: status, opid: 'rq' + Date.now() }).then(function () { loadRequests(true); load(true); }, function (e) { alert(friendly(e)); });
  }
  /* Jobs made but not on the calendar yet (office link only): tap Schedule to place it. */
  function pendSection() {
    var rows = (state.pend && state.pend.d.rows) || []; if (!rows.length) return '';
    return '<h3 class="sec">Unscheduled (' + rows.length + ')</h3>' + rows.map(function (r) {
      return '<div class="job pend"><b>' + esc(r.customer) + '</b>' + (r.request ? ' <span class="badge">From a request</span>' : '') + '<div class="muted">' + esc(r.address) + '</div><div style="white-space:pre-wrap;margin-top:6px">' + esc(r.job) + '</div>' +
        '<div class="muted" style="margin-top:6px">' + durText(r.minutes) + (r.employees.length ? ' &middot; ' + esc(r.employees.join(', ')) : ' &middot; no one picked yet') + '</div>' +
        '<div class="btnrow"><a href="#" class="btn go" data-act="pschedule" data-id="' + esc(r.id) + '">Schedule</a><a href="#" class="btn" data-act="pedit" data-id="' + esc(r.id) + '">Edit</a><a href="#" class="btn plain" data-act="pdel" data-id="' + esc(r.id) + '">Delete</a></div></div>';
    }).join('');
  }
  function drawTabs() {
    var t = $('tabs'), office = state.srv && state.srv.office;
    t.hidden = !office; document.body.classList.toggle('hastabs', !!office);
    if (!office) return;
    var n = state.inbox ? state.inbox.unread : state.srv.unread, rn = state.reqs ? state.reqs.fresh : state.srv.requests;
    var tab = function (k, label, badge) { return '<a href="#" data-act="tab" data-tab="' + k + '"' + (state.tab === k ? ' class="on"' : '') + '>' + label + (badge ? ' <span class="badge new">' + badge + '</span>' : '') + '</a>'; };
    t.innerHTML = tab('requests', 'Requests', rn) + tab('cal', 'Calendar') + tab('jobs', 'Jobs', state.pend ? state.pend.d.rows.length : 0) + tab('inbox', 'Inbox', n) + tab('cust', 'Customers');
  }


  /* ---- office mode: Calendar and Customers (phone-sized; the full calendar with drag and drop stays on the office computer) ----
   * Why they are kept on the phone: the whole window (4 weeks back, 8 ahead) and the customer list are fetched in the
   * background as soon as the app opens, so every tab opens at once and still works with no signal (with an "as of" time). */
  var CAL_BACK = 28, CAL_AHEAD = 56, DAY_FROM = 8, DAY_TO = 17;
  function dayMs(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function calKey() { return 'pj:cal:' + state.key.slice(0, 8); }
  function custKey() { return 'pj:cust:' + state.key.slice(0, 8); }
  function clock(ms) { var d = new Date(ms); return hm12(pad(d.getHours()) + ':' + pad(d.getMinutes())); }
  function preload() {
    var now = Date.now(), l = preload.last || (preload.last = {});
    if (now - (l.cal || 0) > 2 * 60e3) { l.cal = now; loadCal(true); }
    if (now - (l.cust || 0) > 30 * 60e3) { l.cust = now; loadCust(true); }
    if (now - (l.pend || 0) > 2 * 60e3) { l.pend = now; loadPend(true); }
    if (now - (l.box || 0) > 2 * 60e3) { l.box = now; if (state.tab !== 'inbox') loadInbox(true); if (state.tab !== 'requests') loadRequests(true); }
  }
  function loadCal(quiet) {
    if (!state.srv || !state.srv.office) return Promise.resolve();
    var from = dayMs(Date.now()) - CAL_BACK * 864e5;
    return call({ op: 'calendar', from: from, days: CAL_BACK + CAL_AHEAD }, true).then(function (o) {
      state.cal = { t: Date.now(), d: o }; ls(calKey(), state.cal);
      if (state.tab === 'cal' && !state.sheet) drawCal();
    }, function (e) { if (!quiet && state.tab === 'cal' && !state.cal) $('page').innerHTML = '<h2>Calendar</h2><div class="msg">' + esc(friendly(e)) + ' <a href="#" data-act="reload">Try again</a></div>'; });
  }
  /* A change the server just made (schedule, move, change, cancel): drawn at once from the entry it sends back; the full reload follows quietly. */
  function applyEvent(ev) {
    if (!ev || !state.cal) return;
    var evs = state.cal.d.events, at = -1; evs.forEach(function (x, i) { if (x.id === ev.id) at = i; });
    if (at >= 0) evs[at] = ev; else evs.push(ev);
    ls(calKey(), state.cal);
  }
  /* Tapping a button shows it was tapped: its words change and it ignores more taps until the answer (or an error) comes back. */
  function busyBtn(el, label) {
    if (!el) return function () {};
    var old = el.textContent; el.textContent = label; el.classList.add('busy');
    return function () { el.textContent = old; el.classList.remove('busy'); };
  }
  function pendKey() { return 'pj:pend:' + state.key.slice(0, 8); }
  function pendById(id) { return ((state.pend && state.pend.d.rows) || []).filter(function (r) { return r.id === id; })[0]; }
  function loadPend(quiet) {
    if (!state.srv || !state.srv.office) return Promise.resolve();
    return call({ op: 'pendList' }, true).then(function (o) {
      state.pend = { t: Date.now(), d: o }; ls(pendKey(), state.pend); drawTabs();
      if (state.tab === 'jobs' && !state.sheet) draw();
    }, function () {});
  }
  function loadCust(quiet) {
    if (!state.srv || !state.srv.office) return Promise.resolve();
    return call({ op: 'customers' }, true).then(function (o) {
      state.cust = { t: Date.now(), d: o }; ls(custKey(), state.cust);
      if (state.tab === 'cust' && !state.sheet) drawCust(true);
    }, function (e) { if (!quiet && state.tab === 'cust' && !state.cust) $('page').innerHTML = '<h2>Customers</h2><div class="msg">' + esc(friendly(e)) + ' <a href="#" data-act="reload">Try again</a></div>'; });
  }
  /* Free time for one tech on one day: gaps of an hour or more inside working hours, between that tech's jobs. */
  /* The calendar is a plain hour-by-hour day (like Google Calendar's day view) under a week strip. Why a grid and not a list:
   * Matthew on a call needs to SEE the free space, and to drop a job into it with one tap. */
  var HOUR_PX = 48, GRID_FROM = 7, GRID_TO = 19;
  function gridTop(ms, day) { return Math.max(0, Math.min((GRID_TO - GRID_FROM) * HOUR_PX, (ms - day - GRID_FROM * 36e5) / 36e5 * HOUR_PX)); }
  /* Side-by-side lanes for jobs that overlap (two techs at the same time), so nothing hides behind anything. */
  function lanes(evs) {
    var ends = [], out = [];
    evs.slice().sort(function (a, b) { return a.startMs - b.startMs; }).forEach(function (e) {
      var i = 0; while (i < ends.length && ends[i] > e.startMs) i++;
      ends[i] = e.endMs; out.push({ e: e, lane: i });
    });
    var n = Math.max(1, ends.length); out.forEach(function (o) { o.n = n; });
    return out;
  }
  /* The soonest start (for these people, this long) after `after`: the answer to "when can we do it?" while someone is on the phone. */
  function nextOpen(techs, mins, after, skipId, twin, skipped, group) {
    var d0 = dayMs(after || Date.now()), best = null;
    // group: a job for several people needs all of them free at once; otherwise the soonest time for anyone.
    (group ? [techs] : techs.map(function (t) { return [t]; })).forEach(function (tg) {
      var t = tg.join(' + ');
      for (var i = 0; i < 28; i++) {
        var day = d0 + i * 864e5; if (new Date(day).getDay() === 0) continue;
        var tw = twin && twin(day); if (tw) { if (skipped && !skipped.some(function (s) { return s.day === day; })) skipped.push({ day: day, ev: tw }); continue; }
        var ws = freeWindows(day, tg, mins, skipId).filter(function (w) { return w[0] >= (after || 0); });
        if (ws.length) { if (!best || ws[0][0] < best.ms) best = { ms: ws[0][0], tech: t }; return; }
      }
    });
    return best;
  }
  function drawCal() {
    var c = state.cal;
    if (!c) { $('page').innerHTML = '<h2>Calendar</h2><div class="msg">Loading...</div>'; return; }
    var o = c.d, today = dayMs(Date.now()), pl = state.place, sel = state.calDay || (state.calDay = today), wk = new Date(sel); wk.setDate(wk.getDate() - wk.getDay()); wk = dayMs(wk.getTime());
    var picked = pl ? pl.techs : (state.calTech ? [state.calTech] : []);
    var inView = function (e) { return !picked.length || picked.some(function (t) { return e.employees.indexOf(t) >= 0; }); };
    var live = o.events.filter(function (e) { return !e.cancelled && inView(e); });
    var days = [0, 1, 2, 3, 4, 5, 6].map(function (i) { var d = new Date(wk); d.setDate(d.getDate() + i); return dayMs(d.getTime()); });
    var span = function (d) { return live.filter(function (e) { return e.startMs >= d && e.startMs < d + 864e5; }); };
    var DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var h = '<h2>Calendar</h2>';
    if (pl) {
      var clash = placeClash(pl);
      h += '<div class="placebar"><div><b>' + esc(pl.label) + '</b> &middot; ' + durText(pl.minutes) + ' &middot; ' + esc(pl.techs.join(' + ')) + '</div>' +
        '<div class="placewhen">' + dayName(pl.startMs) + ' &middot; <b>' + clock(pl.startMs) + ' - ' + clock(pl.startMs + pl.minutes * 6e4) + '</b></div>' +
        (pl.note ? '<div class="placenote">' + esc(pl.note) + '</div>' : '') + (clash ? '<div class="placeclash">' + esc(clash) + '</div>' : '<div class="muted">Open. Tap another open time to move it.</div>') +
        (pl.busy ? '<div class="btnrow"><span class="btn go busy">Saving... one moment</span></div></div>' : '<div class="btnrow"><a href="#" class="btn go" data-act="placego">Confirm</a><a href="#" class="btn" data-act="placenext">Next open time</a><a href="#" class="btn plain" data-act="placecancel">' + (pl.kind === 'pend' ? 'Not now' : 'Cancel') + '</a></div></div>');
    } else {
      var need = state.calNeed || 120, techs = picked.length ? picked : o.techs, no = nextOpen(techs, need, Date.now());
      h += '<a href="#" class="btn go" data-act="newjob">+ New job</a>' +
        '<div class="nextopen">' + (no ? '<a href="#" data-act="nextjump" data-ms="' + no.ms + '" data-tech="' + esc(no.tech) + '"><span>Next open</span> <b>' + dayName(no.ms) + ' ' + clock(no.ms) + '</b>' + (picked.length ? '' : ' <span class="muted">(' + esc(no.tech) + ')</span>') + '</a>' : '<span class="muted">No open time in the next 4 weeks.</span>') +
        '<select id="calNeed">' + DURS.map(function (d) { return '<option value="' + d[0] + '"' + (d[0] === need ? ' selected' : '') + '>' + d[1] + '</option>'; }).join('') + '</select></div>' +
        '<label class="calflt">Whose jobs<select id="calTech"><option value="">Everyone</option>' + o.techs.map(function (n) { return '<option' + (n === state.calTech ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select></label>';
    }
    h += '<div class="calnav"><a href="#" class="pbtn" data-act="calweek" data-n="-1">&lsaquo; Prev</a><a href="#" class="pbtn" data-act="caltoday">Today</a><a href="#" class="pbtn" data-act="calweek" data-n="1">Next &rsaquo;</a></div>' +
      '<div class="weekstrip">' + days.map(function (d) {
        var evs = span(d), hrs = evs.reduce(function (a, e) { return a + (e.endMs - e.startMs) / 36e5; }, 0), pct = Math.min(100, Math.round(hrs / ((picked.length || 1) * 8) * 100)), dt = new Date(d);
        return '<a href="#" class="dchip' + (d === sel ? ' on' : '') + (d === today ? ' today' : '') + '" data-act="calday" data-ms="' + d + '"><span>' + DN[dt.getDay()] + '</span><b>' + dt.getDate() + '</b><span class="cnt">' + (evs.length || '-') + '</span><i style="width:' + pct + '%"></i></a>';
      }).join('') + '</div>';
    var sd = new Date(sel);
    h += '<h3 class="sec">' + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][sd.getDay()] + ', ' + MN[sd.getMonth()] + ' ' + sd.getDate() + '</h3>';
    if (sel < o.from || sel >= o.from + o.days * 864e5) h += '<div class="msg">That day is outside the days kept on this phone. Use Today to come back.</div>';
    else {
      var dayEvs = o.events.filter(function (e) { return e.startMs < sel + 864e5 && e.endMs > sel && inView(e); });
      var shown = lanes(dayEvs.filter(function (e) { return !e.cancelled; })), total = (GRID_TO - GRID_FROM) * HOUR_PX;
      h += '<div class="grid' + (pl ? ' placing' : '') + '" data-act="gridtap" data-day="' + sel + '" style="height:' + total + 'px">';
      for (var hr = GRID_FROM; hr <= GRID_TO; hr++) h += '<div class="gl" style="top:' + (hr - GRID_FROM) * HOUR_PX + 'px"><span>' + ((hr + 11) % 12 + 1) + (hr < 12 ? ' AM' : ' PM') + '</span></div>';
      shown.forEach(function (x) {
        var e = x.e, top = gridTop(e.startMs, sel), bot = gridTop(e.endMs, sel), w = 100 / x.n;
        h += '<' + (pl ? 'div' : 'a href="#" data-act="caljob" data-id="' + esc(e.id) + '"') + ' class="ev' + (e.done ? ' fin' : '') + '" style="top:' + top + 'px;height:' + Math.max(22, bot - top - 2) + 'px;left:calc(46px + (100% - 50px) * ' + (x.lane / x.n) + ');width:calc((100% - 50px) * ' + (1 / x.n) + ' - 3px)">' +
          '<b>' + esc(e.who) + '</b><br><span>' + clock(e.startMs) + ' &middot; ' + esc(e.employees.join(', ')) + '</span></' + (pl ? 'div' : 'a') + '>';
      });
      if (pl && pl.startMs >= sel && pl.startMs < sel + 864e5) {
        var gt = gridTop(pl.startMs, sel), gb = gridTop(pl.startMs + pl.minutes * 6e4, sel);
        h += '<div class="ev ghost' + (placeClash(pl) ? ' bad' : '') + '" style="top:' + gt + 'px;height:' + Math.max(22, gb - gt - 2) + 'px;left:46px;right:4px"><b>' + esc(pl.label) + '</b><br><span>' + clock(pl.startMs) + ' - ' + clock(pl.startMs + pl.minutes * 6e4) + '</span></div>';
      }
      if (sel === today) { var nt = gridTop(Date.now(), today); if (nt > 0 && nt < total) h += '<div class="nowline" style="top:' + nt + 'px"></div>'; }
      h += '</div>';
      var gone = o.events.filter(function (e) { return e.cancelled && e.startMs >= sel && e.startMs < sel + 864e5 && inView(e); });
      if (gone.length) h += '<div class="muted" style="margin-top:8px">Cancelled: ' + gone.map(function (e) { return '<a href="#" data-act="caljob" data-id="' + esc(e.id) + '">' + esc(e.who) + ' ' + clock(e.startMs) + '</a>'; }).join(', ') + '</div>';
    }
    h += '<div class="muted" style="margin-top:14px">As of ' + stamp(c.t) + ' &middot; <a href="#" data-act="reload">Refresh</a></div>';
    var y = window.scrollY; $('page').innerHTML = h; if (pl || state.calKeep) window.scrollTo(0, y);
    var s1 = $('calTech'); if (s1) s1.onchange = function () { state.calTech = this.value; drawCal(); };
    var s2 = $('calNeed'); if (s2) s2.onchange = function () { state.calNeed = +this.value; drawCal(); };
    state.calKeep = true;
  }
  function durText(m) { return m % 60 === 0 ? (m / 60) + ' h' : m < 60 ? m + ' min' : (m / 60).toFixed(1) + ' h'; }
  /* The same customer at the same address already booked that day: the server allows one job per customer and address per day. */
  function streetOf(a) { return String(a || '').split(',')[0].trim().toLowerCase(); }
  function twinFor(customer, address, skipId) {
    if (!customer) return null;
    return function (day) {
      return ((state.cal && state.cal.d.events) || []).filter(function (e) {
        return !e.cancelled && e.id !== skipId && e.startMs >= day && e.startMs < day + 864e5 &&
          String(e.who || '').trim().toLowerCase() === String(customer).trim().toLowerCase() && streetOf(e.address) === streetOf(address);
      })[0] || null;
    };
  }
  function twinNote(sk, label) {
    if (!sk.length) return '';
    var e = sk[0].ev; return 'Skipped ' + dayName(sk[0].day) + ': ' + label + ' already has a job at ' + (String(e.address || '').split(',')[0] || 'this address') + ' that day (' + clock(e.startMs) + '). One job per customer and address per day, so the next open time is on a different day.';
  }
  /* Plain words when the placed job overlaps another job of the same people (the server asks again before saving). */
  function placeClash(pl) {
    var tw = pl.twin && pl.twin(dayMs(pl.startMs)); if (tw) return pl.label + ' already has a job at ' + (String(tw.address || '').split(',')[0] || 'this address') + ' on ' + dayName(tw.startMs) + ' (' + clock(tw.startMs) + '). Only one job per customer and address per day: pick another day.';
    var end = pl.startMs + pl.minutes * 6e4, hit = ((state.cal && state.cal.d.events) || []).filter(function (e) {
      return !e.cancelled && e.id !== pl.skipId && e.startMs < end && e.endMs > pl.startMs && pl.techs.some(function (t) { return e.employees.indexOf(t) >= 0; });
    })[0];
    return hit ? hit.employees.filter(function (t) { return pl.techs.indexOf(t) >= 0; }).join(' + ') + ' already has ' + hit.who + ' at ' + clock(hit.startMs) + '.' : '';
  }
  /* Placing a job on the calendar (new unscheduled job, or moving an existing one): a dashed block sits in the first open slot;
   * tapping any open spot moves it; Confirm saves. Nothing is saved before Confirm. */
  function startPlace(p) {
    var twin = twinFor(p.customer, p.address, p.skipId), sk = [];
    var first = nextOpen(p.techs, p.minutes, Date.now(), p.skipId, twin, sk, true), at = p.startMs || (first ? first.ms : dayMs(Date.now()) + 8.5 * 36e5);
    state.place = { kind: p.kind, id: p.id, label: p.label, techs: p.techs, minutes: p.minutes, startMs: at, skipId: p.skipId || '', ev: p.ev || null, opid: opid(), twin: twin, note: p.startMs ? '' : twinNote(sk, p.label) };
    state.tab = 'cal'; state.calDay = dayMs(at); state.calKeep = false; closeSheet(); drawTabs(); drawCal();
    var g = document.querySelector('.ghost'); if (g) window.scrollTo(0, Math.max(0, g.getBoundingClientRect().top + window.scrollY - 220));
  }
  function placeGo(force) {
    var pl = state.place; if (!pl || pl.busy) return;
    pl.busy = true; drawCal();
    var oid = sendId({ opid: pl.opid }, [pl.id, pl.startMs, pl.minutes, pl.techs], force);
    var fail = function (e) {
      pl.busy = false; drawCal();
      if (/already scheduled or removed|moved by someone else/.test(e.message)) { state.place = null; loadPend(true); loadCal(true); toast(e.message); return drawCal(); }
      toast(e.code === 'offline' ? 'No signal. Nothing was saved. Tap Confirm again when you have signal.' : friendly(e));
    };
    var ok = function (o) {
      if (o.clash) { pl.busy = false; drawCal(); if (confirm(o.clash + '\n\nBook it anyway?')) placeGo(true); return; }
      var id = pl.kind === 'pend' ? o.id : pl.id, moved = pl.kind === 'move';
      applyEvent(o.event); state.place = null; toast(moved ? 'Job moved to ' + dayName(pl.startMs) + ' ' + clock(pl.startMs) : 'Job ' + o.jobNo + ' scheduled for ' + dayName(pl.startMs) + ' ' + clock(pl.startMs));
      drawCal(); offerConfirm(id, moved);
      setTimeout(function () { loadCal(true); loadPend(true); loadRequests(true); load(true); }, 1500);
    };
    if (pl.kind === 'pend') call({ op: 'pendSchedule', id: pl.id, start: pl.startMs, minutes: pl.minutes, employees: pl.techs, force: !!force, opid: oid }).then(ok, fail);
    else call({ op: 'jobMove', id: pl.id, start: pl.startMs, end: pl.startMs + pl.minutes * 6e4, was: pl.ev.startMs, wasEnd: pl.ev.endMs, force: !!force, opid: oid }).then(ok, fail);
  }
  function calJobSheet(id) {
    var e = ((state.cal && state.cal.d.events) || []).filter(function (x) { return x.id === id; })[0]; if (!e) return;
    var d = String(e.phone || '').replace(/[^\d+]/g, ''), t = d.replace(/^\+?1?(\d{10})$/, '$1'), dt = new Date(e.startMs);
    openSheet('<div class="card"><div style="font-weight:bold;font-size:20px">' + esc(e.who) + '</div>' +
      '<div class="muted">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()] + ' ' + (dt.getMonth() + 1) + '/' + dt.getDate() + ' &middot; ' + clock(e.startMs) + ' - ' + clock(e.endMs) + (e.no ? ' &middot; Job ' + esc(e.no) : '') + ' &middot; ' + esc(e.status) + '</div>' +
      '<div style="margin-top:10px"><b>' + esc(e.employees.join(', ') || 'No one assigned') + '</b></div>' +
      (e.address ? '<div style="margin-top:8px"><a href="' + mapUrl(e) + '" target="protecmap">' + esc(e.address) + '</a></div>' : '') +
      (e.job ? '<div style="margin-top:10px;white-space:pre-wrap">' + esc(e.job) + '</div>' : '') +
      (e.note ? '<div class="muted" style="margin-top:8px;white-space:pre-wrap">' + esc(e.note) + '</div>' : '') +
      (t.length === 10 ? '<div class="ph"><div class="phn">' + esc(e.phone) + '</div><div class="pb"><a class="pbtn" href="tel:' + d + '">Call</a><a class="pbtn" href="#" data-act="ctext" data-name="' + esc(e.who) + '" data-phone="' + t + '">Text</a></div></div>' : '') +
      (e.open && !e.cancelled ? '<button class="btn" data-act="jmove" data-id="' + esc(e.id) + '">Move to another time</button><button class="btn plain" data-act="jedit" data-id="' + esc(e.id) + '">Change details</button>' : '') +
      (e.cancelled ? '<button class="btn plain" data-act="jcancel" data-id="' + esc(e.id) + '">Bring back</button>' : e.open ? '<button class="btn plain" data-act="jcancel" data-id="' + esc(e.id) + '">Cancel job</button>' : '') +
      '<button class="btn plain" data-act="close">Close</button></div>');
  }
  function drawCust(keepFocus) {
    var c = state.cust;
    if (!c) { $('page').innerHTML = '<h2>Customers</h2><div class="msg">Loading...</div>'; return; }
    if (!$('cQ') || !keepFocus) {
      $('page').innerHTML = '<h2>Customers</h2><input id="cQ" type="search" class="cq" placeholder="Search name, phone or street" value="' + esc(state.custQ) + '" autocomplete="off"><div id="cList"></div><div class="muted" style="margin-top:14px">As of ' + stamp(c.t) + ' &middot; <a href="#" data-act="reload">Refresh</a></div>';
      $('cQ').oninput = function () { state.custQ = this.value; drawCust(true); };
    }
    var q = state.custQ.trim().toLowerCase(), qd = q.replace(/\D/g, '');
    var rows = c.d.rows.filter(function (r) { return !q || (r.name + ' ' + r.address + ' ' + r.places.join(' ') + ' ' + r.email).toLowerCase().indexOf(q) >= 0 || (qd.length >= 3 && String(r.phone).replace(/\D/g, '').indexOf(qd) >= 0); });
    $('cList').innerHTML = rows.slice(0, 40).map(function (r) {
      var d = String(r.phone || '').replace(/[^\d+]/g, ''), t = d.replace(/^\+?1?(\d{10})$/, '$1'), no = r.tags.indexOf('No texts') >= 0;
      var key = r.name + '|' + r.phone, open = state.custOpen === key;
      return '<div class="cust' + (open ? ' open' : '') + '"><a href="#" class="custhead" data-act="custopen" data-key="' + esc(key) + '"><b>' + esc(r.name) + '</b>' + (r.tags.length ? ' <span class="badge">' + esc(r.tags.join(', ')) + '</span>' : '') + '<div class="muted">' + esc(r.address || (r.places[0] || '')) + '</div></a>' +
        (!open ? '' : (t.length === 10 ? '<div class="ph"><div class="phn">' + esc(r.phone) + '</div><div class="pb"><a class="pbtn" href="tel:' + d + '">Call</a>' + (no ? '' : '<a class="pbtn" href="#" data-act="ctext" data-name="' + esc(r.name) + '" data-phone="' + t + '">Text</a>') + '</div></div>' : '') + (r.tags.indexOf('No service') >= 0 ? '' : '<a href="#" class="pbtn" style="margin-top:6px" data-act="mkjob" data-name="' + esc(r.name) + '" data-phone="' + t + '">Make a job</a>')) + '</div>';
    }).join('') + (rows.length > 40 ? '<div class="muted" style="margin-top:8px">' + (rows.length - 40) + ' more. Type more of the name to narrow it down.</div>' : '') + (rows.length ? '' : '<div class="msg">Nobody matches that.</div>');
  }


  /* ---- office mode: make, edit, move, cancel and confirm jobs from the phone ----
   * Why these are NOT queued for later like a tech's taps: a job booked blind could land on a slot someone else took, and
   * the office is the one place that must never double-book without knowing. So each one is sent at once; with no signal
   * nothing is saved, the form keeps what was typed, and it says so. The server checks again (same-day twin, tech already
   * booked, job changed by someone else since it was opened) and a sent-twice request is saved once (opid kept for the
   * life of the open form). */
  var SLOT_FROM = 8.5, SLOT_TO = 17, DURS = [[60, '1 hour'], [120, '2 hours'], [180, '3 hours'], [240, 'Half day'], [480, 'Full day']];
  function pickedTechs() { return [].map.call(document.querySelectorAll('#jTechs input:checked'), function (c) { return c.value; }); }
  function dateVal(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function timeVal(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function msOf(dateStr, timeStr) { var a = String(dateStr).split('-'), b = String(timeStr).split(':'); if (a.length < 3 || b.length < 2) return 0; return new Date(+a[0], +a[1] - 1, +a[2], +b[0], +b[1]).getTime(); }
  function dayName(ms) { var d = new Date(ms); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate(); }
  /* Free windows (inside working hours) of at least `mins` on a day, for ALL the picked techs at once: a window is free only if none of them is busy. */
  function freeWindows(day, techs, mins, skipId) {
    var evs = ((state.cal && state.cal.d.events) || []).filter(function (e) {
      return !e.cancelled && e.id !== skipId && e.startMs < day + 864e5 && e.endMs > day && techs.some(function (t) { return e.employees.indexOf(t) >= 0; });
    }).sort(function (a, b) { return a.startMs - b.startMs; });
    var at = day + SLOT_FROM * 36e5, hi = day + SLOT_TO * 36e5, out = [];
    if (day === dayMs(Date.now())) at = Math.max(at, Math.ceil(Date.now() / 18e5) * 18e5);
    evs.forEach(function (e) { if (e.startMs - at >= mins * 6e4) out.push([at, e.startMs]); at = Math.max(at, e.endMs); });
    if (hi - at >= mins * 6e4) out.push([at, hi]);
    return out;
  }
  function openings(techs, mins, skipId) {
    var out = [], d0 = dayMs(Date.now());
    for (var i = 0; i < 21 && out.length < 3; i++) {
      var day = d0 + i * 864e5; if (new Date(day).getDay() === 0) continue;
      var w = freeWindows(day, techs, mins, skipId)[0]; if (w) out.push(w[0]);
    }
    return out;
  }
  function techBoxes(sel) {
    var names = (state.cal && state.cal.d.techs) || [];
    return '<div id="jTechs" class="techs">' + names.map(function (n) { return '<label class="tk"><input type="checkbox" value="' + esc(n) + '"' + (sel.indexOf(n) >= 0 ? ' checked' : '') + '> ' + esc(n) + '</label>'; }).join('') + '</div>';
  }
  function custMatch(name) {
    var n = String(name || '').trim().toLowerCase(); if (!n || !state.cust) return null;
    return state.cust.d.rows.filter(function (r) { return r.name.toLowerCase() === n; })[0] || null;
  }
  function custByPhone(ph) {
    var d = String(ph || '').replace(/\D/g, '').slice(-10); if (d.length < 10 || !state.cust) return null;
    return state.cust.d.rows.filter(function (r) { return String(r.phone).replace(/\D/g, '').slice(-10) === d; })[0] || null;
  }
  /* The job form. mode 'new' = a new job (no time asked: it is placed on the calendar next, or kept under Jobs > Unscheduled);
   * 'pend' = change a waiting job; 'edit' = change a job already on the calendar. pre: what to start with. */
  function jobSheet(mode, pre) {
    pre = pre || {}; var ev = pre.ev || null, pd = pre.pend || null;
    var techs = ev ? ev.employees : pd ? pd.employees : (pre.techs || []), mins = ev ? Math.round((ev.endMs - ev.startMs) / 6e4) : pd ? pd.minutes : 120;
    var v = function (k, k2) { return esc(pre[k] || (ev && ev[k2 || k]) || (pd && pd[k2 || k]) || ''); };
    var h = '<div class="card"><div style="font-weight:bold;font-size:20px">' + (mode === 'edit' ? 'Change job' : mode === 'pend' ? 'Change waiting job' : 'Make a job') + '</div>';
    if (pre.note) h += '<div class="msg">' + pre.note + '</div>';
    h += '<label>Customer<input id="jCust" list="jCustList" autocomplete="off" value="' + esc(pre.customer || (ev && ev.customer) || (pd && pd.customer) || '') + '"></label><datalist id="jCustList">' +
      ((state.cust && state.cust.d.rows) || []).slice(0, 400).map(function (r) { return '<option value="' + esc(r.name) + '">'; }).join('') + '</datalist><div id="jWho" class="muted"></div>' +
      '<label>Phone<input id="jPhone" type="tel" value="' + v('phone') + '"></label>' +
      '<label>Email (optional)<input id="jEmail" type="email" value="' + v('email') + '"></label>' +
      '<label>Service address<input id="jAddr" list="jAddrList" value="' + v('address') + '"></label><datalist id="jAddrList"></datalist>' +
      '<label>What the job is<textarea id="jWhat" rows="3">' + esc(pre.what || (ev && ev.job) || (pd && pd.job) || '') + '</textarea></label>' +
      '<label>On-site contact (if not the customer)<input id="jCn" value="' + esc((ev && ev.contactName) || (pd && pd.contactName) || '') + '" placeholder="Name"></label><input id="jCp" type="tel" value="' + esc((ev && ev.contactPhone) || (pd && pd.contactPhone) || '') + '" placeholder="Their phone" style="margin-top:6px">' +
      '<label>Who is going' + (mode === 'new' ? ' (you can pick when you schedule it)' : '') + '</label>' + techBoxes(techs);
    if (mode !== 'edit') h += '<label>How long<select id="jDur">' + DURS.map(function (d) { return '<option value="' + d[0] + '"' + (d[0] === mins ? ' selected' : '') + '>' + d[1] + '</option>'; }).join('') + '</select></label>';
    h += '<div id="sErr"></div><button class="btn go" id="jGo">' + (mode === 'edit' || mode === 'pend' ? 'Save changes' : 'Create job') + '</button><button class="btn plain" data-act="close">Cancel</button></div>';
    openSheet(h);
    state.sheet = { jobform: true, mode: mode, id: ev ? ev.id : pd ? pd.id : '', skipId: ev && ev.id, ev: ev, request: pre.request || '', opid: opid(), busy: false };
    var who = function () {
      var c = custMatch($('jCust').value), w = $('jWho'); if (!w) return;
      var dl = $('jAddrList'); if (dl) dl.innerHTML = c ? c.places.concat(c.address ? [c.address] : []).map(function (a) { return '<option value="' + esc(a) + '">'; }).join('') : '';
      w.innerHTML = !$('jCust').value.trim() ? '' : c ? 'Existing customer' + (c.tags.length ? ' &middot; <b>' + esc(c.tags.join(', ')) + '</b>' : '') : 'New customer. They are added to the customer list when the job is created.';
      if (c) { if (!$('jPhone').value) $('jPhone').value = c.phone || ''; if (!$('jAddr').value) $('jAddr').value = c.address || (c.places[0] || ''); if (!$('jEmail').value) $('jEmail').value = c.email || ''; }
    };
    $('jCust').onchange = who; $('jCust').oninput = who; who();
    $('jGo').onclick = function () { jobGo(); };
  }
  function jobForm() {
    var f = { customer: $('jCust').value, address: $('jAddr').value, phone: $('jPhone').value, email: $('jEmail').value, job: $('jWhat').value,
      contactName: $('jCn').value, contactPhone: $('jCp').value, employees: pickedTechs() };
    if ($('jDur')) f.minutes = +$('jDur').value;
    return f;
  }
  // Plain-words problems found on the phone before anything is sent.
  function jobCheck(s, f) {
    if (!f.customer.trim()) return 'Type the customer\'s name.';
    if (!f.address.trim()) return 'Type the service address.';
    if (f.phone && f.phone.replace(/\D/g, '').length < 10) return 'That phone number is short. Use all 10 digits with the area code.';
    if (s.mode === 'edit' && !f.employees.length) return 'Tick who is going.';
    return '';
  }
  // One id per (this open form + exactly what is being sent + force): a repeat of the same send is answered from the first, but changed details, or a 'book it anyway', are a new send.
  function sendId(s, f, force) {
    var t = s.opid + JSON.stringify([f, !!force]), h = 5381, i; for (i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
    return s.opid + h.toString(36);
  }
  function jobGo() {
    var s = state.sheet; if (!s || !s.jobform || s.busy) return;
    var f = jobForm(), bad = jobCheck(s, f); if (bad) return sheetErr(bad);
    var oid = sendId(s, f, false);
    sheetErr(''); s.busy = true; $('jGo').disabled = true; var jgoText = $('jGo').textContent; $('jGo').textContent = 'Saving...';
    var done = function () { s.busy = false; if ($('jGo')) { $('jGo').disabled = false; $('jGo').textContent = jgoText; } };
    var fail = function (e) {
      done();
      if (e.code === 'offline') return sheetErr('No signal. Nothing was saved. Everything you typed is still here: tap again when you have signal.');
      sheetErr(friendly(e));
    };
    if (s.mode === 'edit') {
      f.fp = s.ev.fp;
      call({ op: 'jobUpdate', id: s.id, f: f, opid: oid }).then(function (o) { done(); applyEvent(o.event); closeSheet(); toast('Job changed'); if (state.tab === 'cal') drawCal(); setTimeout(function () { loadCal(true); }, 1500); }, function (e) { if (/Someone else changed/.test(e.message)) { done(); loadCal(true); return sheetErr(esc(e.message) + ' Close this and open the job again.'); } fail(e); });
      return;
    }
    var save = function () {
      call({ op: 'pendSave', f: f, id: s.mode === 'pend' ? s.id : '', request: s.mode === 'new' ? s.request : '', opid: oid }).then(function (o) {
        done(); loadPend(true); loadRequests(true);
        if (s.mode === 'pend') { closeSheet(); toast('Job changed'); return; }
        madeSheet(o.id, f);
      }, fail);
    };
    // A name the customer list has never seen is added first (QuickBooks). If that cannot be done the job is still made and the push adds them later.
    if (s.mode === 'new' && !custMatch(f.customer) && !s.custDone) {
      var digits = f.phone.replace(/\D/g, '').slice(-10);
      call({ op: 'custSave', f: { name: f.customer.trim(), mobile: digits.length === 10 ? f.phone : '', email: f.email, address: f.address }, opid: oid + 'c' }).then(function () { s.custDone = true; loadCust(true); save(); }, function (e) {
        if (e.code === 'offline') return fail(e);
        s.custDone = true; toast('Customer not added to the list yet (' + friendly(e) + '). The job is still made.'); save();
      });
    } else save();
  }
  /* The job exists (unscheduled). Now: put it on the calendar, or leave it under Jobs > Unscheduled. */
  function madeSheet(id, f) {
    state.sheet = { made: true, id: id };
    openSheet('<div class="card low"><div style="font-weight:bold;font-size:18px">Job made for ' + esc(f.customer) + '</div><div class="muted" style="margin-top:6px">Put it on the calendar now?</div>' +
      (f.employees.length ? '' : '<label>Who is going</label>' + techBoxes([])) + '<div id="sErr"></div>' +
      '<button class="btn go" data-act="sched" data-id="' + esc(id) + '" data-label="' + esc(f.customer) + '" data-mins="' + (f.minutes || 120) + '" data-techs="' + esc(f.employees.join('|')) + '">Schedule now</button>' +
      '<button class="btn plain" data-act="later">Later (keep it under Jobs)</button></div>');
  }
  // After a job is added or moved: show the confirmation text and offer to send it (never sent without a tap).
  function offerConfirm(id, moved) {
    call({ op: 'confirmPreview', id: id }, true).then(function (p) {
      if (!p.can || p.confirmed) return;
      openSheet('<div class="card"><div style="font-weight:bold;font-size:18px">Tell the customer ' + (moved ? 'the new time' : 'it is booked') + '?</div>' +
        (p.cell ? '<div class="thread" style="margin:10px 0">' + esc(p.text) + '</div>' : '<div class="muted" style="margin:10px 0">' + esc(p.why || 'No cell number to text.') + '</div>') +
        '<div id="sErr"></div>' + (p.cell ? '<button class="btn go" data-act="cfsend" data-id="' + esc(id) + '" data-how="text">Send the text</button>' : '') +
        (p.email ? '<button class="btn" data-act="cfsend" data-id="' + esc(id) + '" data-how="email">Send an email</button>' : '') + '<button class="btn plain" data-act="close">Not now</button></div>');
      state.sheet = { confirm: true };
    }, function () {});
  }
  function cancelSheet(id) {
    var e = ((state.cal && state.cal.d.events) || []).filter(function (x) { return x.id === id; })[0]; if (!e) return;
    openSheet('<div class="card low"><div style="font-weight:bold;font-size:18px">' + (e.cancelled ? 'Bring back' : 'Cancel') + ' ' + esc(e.who) + '\'s job on ' + dayName(e.startMs) + ' at ' + clock(e.startMs) + '?</div>' +
      (e.cancelled ? '' : '<div class="muted" style="margin-top:6px">The job stays on the calendar in grey and is never billed. The customer is not told automatically: call or text them.</div>') +
      '<div id="sErr"></div><button class="btn" style="background:#d93025" data-act="cxgo" data-id="' + esc(id) + '" data-back="' + (e.cancelled ? '1' : '') + '">' + (e.cancelled ? 'Yes, bring it back' : 'Yes, cancel the job') + '</button><button class="btn plain" data-act="close">No, keep it</button></div>');
    state.sheet = { cancel: true };
  }

  /* ---- clicks ---- */
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest && ev.target.closest('[data-act]'); if (!el) return;
    if (el.classList.contains('busy')) { if (ev.preventDefault) ev.preventDefault(); return; }
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id');
    if (act === 'tick') return;
    if (act === 'reqcall') { call({ op: 'requestSet', id: id, status: 'Called', opid: 'rq' + Date.now() }).then(function () { loadRequests(true); }, function () {}); return; }   // the phone dials; no preventDefault
    ev.preventDefault();
    if (act === 'reload') { state.note = ''; syncBar(); load(); if (state.tab === 'cal') loadCal(); if (state.tab === 'cust') loadCust(); }
    else if (act === 'calday') { state.calDay = +el.getAttribute('data-ms'); drawCal(); }
    else if (act === 'calweek') { state.calDay = dayMs(state.calDay || Date.now()) + 7 * 864e5 * +el.getAttribute('data-n'); drawCal(); }
    else if (act === 'caltoday') { state.calDay = dayMs(Date.now()); drawCal(); }
    else if (act === 'caljob') calJobSheet(id);
    else if (act === 'ctext') threadSheet('office', null, null, el.getAttribute('data-name'), el.getAttribute('data-phone'));
    else if (act === 'reqold') { state.reqOld = !state.reqOld; drawRequests(); }
    else if (act === 'newjob') jobSheet('new', { techs: state.calTech ? [state.calTech] : [] });
    else if (act === 'mkjob') jobSheet('new', { customer: /\d{7}/.test(el.getAttribute('data-name') || '') ? '' : el.getAttribute('data-name'), phone: el.getAttribute('data-phone'), address: (custByPhone(el.getAttribute('data-phone')) || {}).address || '', techs: state.calTech ? [state.calTech] : [], note: el.getAttribute('data-note') || '' });
    else if (act === 'mkreq') { var rq = ((state.reqs && state.reqs.rows) || []).filter(function (r) { return r.id === id; })[0]; if (rq) jobSheet('new', { customer: rq.customer || rq.name, phone: rq.phone, email: rq.email, address: rq.address, what: rq.what, request: rq.id, techs: state.calTech ? [state.calTech] : [], note: rq.when ? 'They asked for: <b>' + esc(rq.when) + '</b>' : '' }); }
    else if (act === 'jedit') { var ev0 = ((state.cal && state.cal.d.events) || []).filter(function (x) { return x.id === id; })[0]; if (ev0) jobSheet('edit', { ev: ev0 }); }
    else if (act === 'jmove') { var ev1 = ((state.cal && state.cal.d.events) || []).filter(function (x) { return x.id === id; })[0]; if (ev1) startPlace({ kind: 'move', id: id, label: ev1.who, techs: ev1.employees.length ? ev1.employees : (state.cal.d.techs || []).slice(0, 1), minutes: Math.round((ev1.endMs - ev1.startMs) / 6e4), startMs: ev1.startMs, skipId: id, ev: ev1, customer: ev1.who, address: ev1.address }); }
    else if (act === 'jcancel') cancelSheet(id);
    else if (act === 'cxgo') { var undoBusy = busyBtn(el, 'Saving...'); call({ op: 'jobCancel', id: id, back: !!el.getAttribute('data-back'), opid: opid() }).then(function (o) { applyEvent(o.event); closeSheet(); toast(el.getAttribute('data-back') ? 'Job is back on the calendar' : 'Job cancelled'); if (state.tab === 'cal') drawCal(); setTimeout(function () { loadCal(true); }, 1500); }, function (e) { undoBusy(); sheetErr(e.code === 'offline' ? 'No signal. Nothing was saved. Try again when you have signal.' : friendly(e)); }); }
    else if (act === 'cfsend') { el.disabled = true; call({ op: 'confirm', id: id, how: el.getAttribute('data-how'), opid: opid() }).then(function () { closeSheet(); toast('Sent'); loadCal(true); }, function (e) { el.disabled = false; sheetErr(e.code === 'offline' ? 'No signal. Nothing was sent. Try again when you have signal.' : friendly(e)); }); }
    else if (act === 'gridtap') {
      var pl = state.place; if (!pl) return;
      var r = el.getBoundingClientRect(), mins = Math.round((ev.clientY - r.top) / HOUR_PX * 4) * 15, day = +el.getAttribute('data-day');
      pl.startMs = day + GRID_FROM * 36e5 + mins * 6e4 - 15 * 6e4 * 0; drawCal();
    }
    else if (act === 'custopen') { var ck = el.getAttribute('data-key'); state.custOpen = state.custOpen === ck ? '' : ck; drawCust(true); }
    else if (act === 'placego') placeGo(false);
    else if (act === 'placenext') { var q = state.place; if (q) { var sk2 = [], nx = nextOpen(q.techs, q.minutes, q.startMs + 15 * 6e4, q.skipId, q.twin, sk2, true); if (nx) { q.startMs = nx.ms; q.note = twinNote(sk2, q.label); state.calDay = dayMs(nx.ms); drawCal(); } else toast('No other open time in the next 4 weeks.'); } }
    else if (act === 'placecancel') { var kind = state.place && state.place.kind; state.place = null; drawCal(); if (kind === 'pend') toast('Kept under Jobs > Unscheduled.'); }
    else if (act === 'nextjump') { state.calDay = dayMs(+el.getAttribute('data-ms')); if (!state.calTech) state.calTech = el.getAttribute('data-tech'); state.calKeep = false; drawCal(); }
    else if (act === 'sched') {
      var tl = el.getAttribute('data-techs'), techs = tl ? tl.split('|') : pickedTechs();
      if (!techs.length) return sheetErr('Tick who is going, then tap Schedule now.');
      var pdx = pendById(id) || {}; startPlace({ kind: 'pend', id: id, label: el.getAttribute('data-label'), techs: techs, minutes: +el.getAttribute('data-mins') || 120, customer: pdx.customer, address: pdx.address });
    }
    else if (act === 'later') { closeSheet(); toast('Kept under Jobs > Unscheduled.'); state.tab = 'jobs'; draw(); }
    else if (act === 'pschedule') { var pd = pendById(id); if (!pd) return; if (!pd.employees.length) { jobSheet('pend', { pend: pd, note: 'Tick who is going, then save and schedule.' }); return; } startPlace({ kind: 'pend', id: pd.id, label: pd.customer, techs: pd.employees, minutes: pd.minutes, customer: pd.customer, address: pd.address }); }
    else if (act === 'pedit') { var pe = pendById(id); if (pe) jobSheet('pend', { pend: pe }); }
    else if (act === 'pdel') {
      var pn = pendById(id); if (!pn) return;
      openSheet('<div class="card low"><div style="font-weight:bold;font-size:18px">Delete the waiting job for ' + esc(pn.customer) + '?</div><div class="muted" style="margin-top:6px">' + (pn.request ? 'Their website request goes back to the waiting list.' : 'It has not been scheduled, so nothing else is affected.') + '</div><div id="sErr"></div>' +
        '<button class="btn" style="background:#d93025" data-act="pdelgo" data-id="' + esc(id) + '">Yes, delete it</button><button class="btn plain" data-act="close">No, keep it</button></div>');
    }
    else if (act === 'pdelgo') { call({ op: 'pendDelete', id: id, opid: opid() }).then(function () { closeSheet(); loadPend(true); loadRequests(true); toast('Deleted'); }, function (e) { sheetErr(e.code === 'offline' ? 'No signal. Nothing was deleted. Try again when you have signal.' : friendly(e)); }); }
    else if (act === 'alertson') alertsOn();
    else if (act === 'alertsoff') alertsOff();
    else if (act === 'heldsend') { var hs = HELD.splice(+el.getAttribute('data-i'), 1)[0]; if (hs) { hs.at = Date.now(); Q.push(hs); qSave(); heldSave(); syncBar(); flush(); } }
    else if (act === 'helddrop') { if (confirm('Throw this text away? It will not be sent.')) { HELD.splice(+el.getAttribute('data-i'), 1); heldSave(); syncBar(); } }
    else if (act === 'probok') { probs.splice(+el.getAttribute('data-i'), 1); probSave(); syncBar(); }
    else if (act === 'text') threadSheet('job', id, el.getAttribute('data-to'))
    else if (act === 'nav') navSheet(id);
    else if (act === 'mapgo') { window.open(mapUrl(jobIn(state.d, id) || {}), 'protecmap'); closeSheet(); }
    else if (act === 'mapdrive') { var jj = jobIn(state.d, id); if (jj) { mapAfter = mapUrl(jj); closeSheet(); askTime(id, jj.next.key, jj.next.label, false); } }
    else if (act === 'notifyyes') { closeSheet(); enqueue({ op: 'enroute', id: id }); mapNow(); }
    else if (act === 'notifyno') { closeSheet(); mapNow(); load(); }
    else if (act === 'timecancel') { mapAfter = ''; closeSheet(); load(); }
    else if (act === 'enroute') { if (confirm('Text the customer that you are on the way?')) enqueue({ op: 'enroute', id: id }); }
    else if (act === 'reqset') { if (!el.getAttribute('data-ask') || confirm('Not a fit? It leaves the waiting list and is kept, not deleted.')) reqSet(id, el.getAttribute('data-status')); }
    else if (act === 'tab') goTab(el.getAttribute('data-tab'));
    else if (act === 'junk') junkSet(el.getAttribute('data-phone'), !!el.getAttribute('data-on'))
    else if (act === 'junkopen') { state.junkOpen = !state.junkOpen; drawInbox(); }
    else if (act === 'conv') threadSheet('office', null, null, el.getAttribute('data-name'), el.getAttribute('data-phone'))
    else if (act === 'tap') askTime(id, el.getAttribute('data-key'), el.getAttribute('data-label'), !!el.getAttribute('data-leave'));
    else if (act === 'undo') { if (confirm('Take back ' + el.getAttribute('data-what') + '?')) enqueue({ op: 'undo', id: id }); }
    else if (act === 'report') reportSheet(id);
    else if (act === 'photos') reportSheet(id, true);
    else if (act === 'phview') viewPhoto(id, +el.getAttribute('data-i'));
    else if (act === 'phclose') { $('viewer').hidden = true; $('viewer').innerHTML = ''; }
    else if (act === 'close') { keepDraft(); var wasThread = state.sheet && state.sheet.thread; closeSheet(); load(); if (wasThread) { loadInbox(true); draw(); } }
    else if (act === 'tripadd') { $('rTrips').insertAdjacentHTML('beforeend', tripRow()); keepDraft(); }
    else if (act === 'tripdel') { el.parentNode.remove(); keepDraft(); }
    else if (act === 'addphoto') $('rFile').click();
    else if (act === 'picdel') {
      var url = el.getAttribute('data-url'), s = state.sheet;
      if (s && confirm('Remove this photo?')) { s.photos = s.photos.filter(function (u) { return u !== url; }); renderPics(); enqueue({ op: 'photoRemove', id: s.id, url: url }); }
    }
  });
  // Checking off a still-to-do line saves it on the report it came from; tapping a finished one unchecks it.
  document.addEventListener('change', function (ev) {
    var el = ev.target; if (el.getAttribute && el.getAttribute('data-act') !== 'tick') return;
    var on = el.checked;
    enqueue({ op: 'todo', id: el.getAttribute('data-id'), todoId: el.getAttribute('data-todo'), n: +el.getAttribute('data-n'), text: el.getAttribute('data-text'), undo: !on });
  });

  /* ---- start ---- */
  function start() {
    state.key = readKey();
    if (!state.key) {
      $('page').innerHTML = '<h2>Protec - My jobs</h2><div class="msg">Open your own My jobs link, the one the office sent you. If you don\'t have it, ask the office to send it to you again.</div>';
      return;
    }
    manifest();
    // Straight away: the jobs saved from last time with any changes still waiting on them (marked with when), then fresh ones.
    HELD = ls(heldKey()) || []; Q = ls(qKey()) || []; probs = ls('pj:prob:' + state.key.slice(0, 8)) || [];
    var c = ls(cacheKey());
    if (c && c.d) { state.srv = c.d; rebuild(); draw(); state.note = 'Showing your jobs as of ' + stamp(c.t) + ' &middot; updating...'; }
    var ci = ls(calKey()), cu = ls(custKey()), ib = ls('pj:inbox:' + state.key.slice(0, 8)), rq = ls('pj:reqs:' + state.key.slice(0, 8));
    var pc = ls('pj:pend:' + state.key.slice(0, 8)); if (pc && pc.d) state.pend = pc;
    if (ci && ci.d) state.cal = ci; if (cu && cu.d) state.cust = cu; if (ib && ib.d) state.inbox = ib.d; if (rq && rq.d) state.reqs = rq.d;
    syncBar(); if (!/[?&]open=/.test(location.search)) restoreView(); load();
    document.addEventListener('visibilitychange', function () { if (document.hidden) saveView(); else load(true); });
    window.addEventListener('pagehide', saveView);
    setInterval(saveView, 2000);
    window.addEventListener('online', function () { load(true); });
    // While changes are waiting, try again every 20 seconds; otherwise just keep the jobs fresh once a minute.
    setInterval(function () { if (!document.hidden && Q.length) flush().then(function () { if (!Q.length) load(true); }); }, 20 * 1000);
    setInterval(function () { if (!document.hidden && !Q.length) load(true); }, 60 * 1000);
    // An open conversation checks for replies every 8 seconds; the office Inbox every 20.
    setInterval(function () { if (!document.hidden && state.sheet && state.sheet.thread) refreshThread(); }, 8 * 1000);
    setInterval(function () { if (!document.hidden && state.tab === 'inbox' && !state.sheet) loadInbox(true); }, 20 * 1000);
    setInterval(function () { if (!document.hidden && state.tab === 'cal' && !state.sheet) loadCal(true); }, 60 * 1000);
    setInterval(function () { if (!document.hidden && state.srv && state.srv.office) preload(); }, 60 * 1000);
    setInterval(function () { if (!document.hidden && state.tab === 'requests' && !state.sheet) loadRequests(true); }, 20 * 1000);
    if ('serviceWorker' in navigator) {
      // A new app version is picked up by itself: when the new copy takes over, the page reloads once (nothing is mid-edit at that moment unless a form is open, so then it waits).
      var hadSw = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadSw || reloaded) return; reloaded = true;
        var go = function () { if (state.sheet) return setTimeout(go, 5000); location.reload(); }; go();
      });
      navigator.serviceWorker.register('sw.js').catch(function () {});
      // A tap on an alert while the app is open: the Inbox for the office's, the Jobs page for a tech's.
      navigator.serviceWorker.addEventListener('message', function (ev) { if (ev.data && ev.data.open) openFromAlert(ev.data.open); });
    }
    pushLook().then(function () { draw(); });
    var om = /[?&]open=(inbox|requests)/.exec(location.search);
    if (om) { state.openTab = om[1]; try { history.replaceState(null, '', location.pathname); } catch (e) {} }
  }
  /* Where you were: the tab, calendar day, tech filter, search and scroll spot are kept on the phone, so a refresh (or the app being closed
   * and opened again) lands exactly there. Only for the office; a view older than half a day is dropped. */
  function viewKey() { return 'pj:view:' + state.key.slice(0, 8); }
  function goTab(t) {
    state.tab = t;
    if (t === 'inbox') { drawTabs(); drawInbox(); loadInbox(); } else if (t === 'requests') { drawTabs(); drawRequests(); loadRequests(); } else if (t === 'cal') { drawTabs(); drawCal(); loadCal(true); } else if (t === 'cust') { drawTabs(); drawCust(); loadCust(true); } else draw();
    saveView();
  }
  function saveView() {
    if (!state.srv || !state.srv.office || !state.restored) return;
    ls(viewKey(), { tab: state.tab, calDay: state.calDay, calTech: state.calTech, calNeed: state.calNeed, custQ: state.custQ, y: window.scrollY, t: Date.now() });
  }
  function restoreView() {
    if (state.restored || !state.srv || !state.srv.office) return;
    state.restored = true;
    var v = ls(viewKey()); if (!v || !v.tab || Date.now() - v.t > 12 * 36e5 || state.openTab || state.sheet) return;
    if (['jobs', 'requests', 'cal', 'inbox', 'cust'].indexOf(v.tab) < 0) return;
    if (v.calDay) state.calDay = v.calDay; state.calTech = v.calTech || ''; state.calNeed = v.calNeed || state.calNeed; state.custQ = v.custQ || '';
    state.calKeep = true; goTab(v.tab);
    [60, 500, 1500].forEach(function (ms) { setTimeout(function () { if (!state.sheet) window.scrollTo(0, v.y || 0); }, ms); });
  }
  function openFromAlert(where) {
    if (where === 'requests' && state.d && state.d.office) { state.tab = 'requests'; drawTabs(); drawRequests(); loadRequests(); }
    else if (where === 'inbox' && state.d && state.d.office) { state.tab = 'inbox'; drawTabs(); drawInbox(); loadInbox(); }
    else { state.tab = 'jobs'; draw(); }
    load(true);
  }
  start();
})();
