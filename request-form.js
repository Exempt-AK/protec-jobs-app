/* The Request service form for protecsvc.com. Published with the My jobs app (jobs.protecsvc.com/request-form.js) so the WordPress page
 * only holds three safe lines (office-app/website/request-embed.html) and a change to the form needs no re-paste.
 * It posts to the Texts web app (?req=1); the request lands on the office app's Requests tab. Nothing private is in this file. */
(function () {
  var st = document.createElement('style'); st.textContent = "#protec-request{--navy:#033863;--cyan:#00b3e6;max-width:560px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#202124;line-height:1.4}\n#protec-request *{box-sizing:border-box}\n#protec-request h2{margin:0 0 4px;color:var(--navy);font-size:26px}\n#protec-request .sub{margin:0 0 18px;color:#5f6368;font-size:16px}\n#protec-request label.f{display:block;margin:14px 0 0;font-weight:bold;font-size:15px;color:var(--navy)}\n#protec-request input[type=text],#protec-request input[type=tel],#protec-request input[type=email],#protec-request select,#protec-request textarea{display:block;width:100%;margin-top:6px;padding:14px;font-size:18px;border:1px solid #bdc1c6;border-radius:10px;background:#fff;color:#202124;font-family:inherit}\n#protec-request textarea{min-height:110px;resize:vertical}\n#protec-request input:focus,#protec-request select:focus,#protec-request textarea:focus{outline:3px solid rgba(0,179,230,.35);border-color:var(--cyan)}\n#protec-request .tip{margin-top:5px;font-size:14px;color:#b3261e;min-height:0}\n#protec-request .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}\n#protec-request .chip{border:1px solid var(--cyan);color:var(--navy);background:#fff;border-radius:20px;padding:10px 14px;font-size:15px;cursor:pointer;font-family:inherit}\n#protec-request .chip.on{background:var(--cyan);color:#fff}\n#protec-request .consent{display:flex;gap:12px;align-items:flex-start;margin-top:18px;font-size:14px;color:#3c4043}\n#protec-request .consent input{width:26px;height:26px;margin:2px 0 0;flex:none}\n#protec-request .go{display:block;width:100%;margin-top:20px;padding:18px;font-size:20px;font-weight:bold;color:#fff;background:var(--navy);border:0;border-radius:12px;cursor:pointer;font-family:inherit}\n#protec-request .go:disabled{opacity:.6}\n#protec-request .msg{margin-top:14px;padding:12px;border-radius:10px;background:#fef7e0;color:#5f4300}\n#protec-request .done{text-align:center;padding:30px 12px}\n#protec-request .done h2{font-size:28px}\n#protec-request .call{display:inline-block;margin-top:12px;padding:14px 22px;border-radius:12px;background:var(--cyan);color:#fff;font-weight:bold;font-size:20px;text-decoration:none}\n#protec-request .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}"; document.head.appendChild(st);
})();
(function () {
  // The Texts web app address (Protec sheet > Texting > Website request form: show the address). Paste it between the quotes.
  var TEXTS_URL = 'https://script.google.com/macros/s/AKfycbwt1C2m2DEmDkEsiUGNl3gZh5ZWjaw7_e0HPNwMV8FuB_kGWHB2ynBzbwP18M0q2Ac-/exec';
  var PHONE = '(325) 248-9515', KEY = 'protec-request-queue';
  var root = document.getElementById('protec-request'), busy = false, mine = '';
  var CHIPS = ['Leak', 'No hot water', 'Clogged drain', 'Toilet problem', 'Water heater', 'Something else'];
  var TIMES = ['As soon as possible', 'Weekday mornings', 'Weekday afternoons', 'Weekends', 'A certain day (tell us below)'];

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
  function save(q) { try { localStorage.setItem(KEY, JSON.stringify(q)); } catch (e) {} }

  function draw() {
    root.innerHTML = '<h2>Request service</h2><p class="sub">Tell us what is going on. We will get back to you shortly.</p>' +
      '<form id="prForm" novalidate autocomplete="on">' +
      '<label class="f" for="prName">Your name</label><input type="text" id="prName" name="name" autocomplete="name" maxlength="80"><div class="tip" id="prNameT"></div>' +
      '<label class="f" for="prPhone">Mobile phone</label><input type="tel" id="prPhone" name="tel" autocomplete="tel" inputmode="tel" maxlength="20" placeholder="(325) 555-1234"><div class="tip" id="prPhoneT"></div>' +
      '<label class="f" for="prEmail">Email</label><input type="email" id="prEmail" name="email" autocomplete="email" maxlength="120" placeholder="We will send your quote and receipt here"><div class="tip" id="prEmailT"></div>' +
      '<label class="f" for="prStreet">Street address of the job</label><input type="text" id="prStreet" name="street-address" autocomplete="address-line1" maxlength="100" placeholder="1708 Vernon Ave"><div class="tip" id="prStreetT"></div>' +
      '<label class="f" for="prTown">Town</label><input type="text" id="prTown" name="city" autocomplete="address-level2" maxlength="60" placeholder="Llano"><div class="tip" id="prTownT"></div>' +
      '<label class="f" for="prZip">ZIP code</label><input type="text" id="prZip" name="zip" autocomplete="postal-code" inputmode="numeric" maxlength="5" placeholder="78643"><div class="tip" id="prZipT"></div>' +
      '<label class="f" for="prWhat">What is going on?</label>' +
      '<div class="chips" id="prChips">' + CHIPS.map(function (c, i) { return '<button type="button" class="chip" data-i="' + i + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
      '<textarea id="prWhat" maxlength="1500" placeholder="A few words is fine"></textarea><div class="tip" id="prWhatT"></div>' +
      '<label class="f" for="prWhen">Best time for us to come out</label><select id="prWhen">' + TIMES.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('') + '</select>' +
      '<div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" id="prHp" tabindex="-1" autocomplete="off" name="hp_note"></label></div>' +
      '<label class="consent"><input type="checkbox" id="prText"><span>Text me about this request. Message and data rates may apply. Message count varies. Reply STOP anytime to stop, HELP for help. <a href="/sms" target="_blank" rel="noopener">Text policy</a></span></label>' +
      '<div class="msg" id="prMsg" style="display:none"></div>' +
      '<button class="go" id="prGo" type="submit">Send my request</button></form>';
    el('prForm').addEventListener('submit', submit);
    el('prPhone').addEventListener('input', fmtPhone);
    el('prPhone').addEventListener('blur', function () { var d = digits(el('prPhone').value); tip('prPhoneT', d && d.length < 10 ? 'That looks short. Please include the area code, like (325) 555-1234.' : ''); });
    el('prEmail').addEventListener('blur', function () { var v = el('prEmail').value.trim(); tip('prEmailT', v && !mailOk(v) ? 'Please check the email. It should look like name@example.com.' : ''); });
    el('prChips').addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('.chip'); if (!b) return;
      var w = el('prWhat'), t = CHIPS[+b.getAttribute('data-i')];
      b.classList.toggle('on');
      w.value = b.classList.contains('on') ? (w.value ? w.value.replace(/\s*$/, ' ') : '') + t + '. ' : w.value.replace(t + '. ', '').replace(t, '');
    });
  }
  function digits(s) { var d = String(s).replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; }
  function mailOk(v) { return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(v); }
  function tip(id, t) { el(id).textContent = t; }
  // Types the number the way people read it: (325) 555-1234.
  function fmtPhone() {
    var d = el('prPhone').value.replace(/\D/g, '').replace(/^1(?=\d{10})/, '').slice(0, 10), o = d;
    if (d.length > 6) o = '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
    else if (d.length > 3) o = '(' + d.slice(0, 3) + ') ' + d.slice(3);
    el('prPhone').value = o;
  }

  function submit(ev) {
    ev.preventDefault();
    if (busy) return;
    var name = el('prName').value.trim(), d = digits(el('prPhone').value), what = el('prWhat').value.trim(), bad = false;
    tip('prNameT', name.length < 2 ? (bad = true, 'Please add your name.') : '');
    tip('prPhoneT', d.length !== 10 ? (bad = true, 'Please add your 10-digit mobile number so we can reach you.') : '');
    tip('prWhatT', what.length < 3 ? (bad = true, 'Please tell us a little about what is going on.') : '');
    var street = el('prStreet').value.trim().replace(/\s+/g, ' '), town = el('prTown').value.trim().replace(/\s+/g, ' '), zip = el('prZip').value.replace(/\D/g, '');
    tip('prStreetT', !(street.length >= 5 && /\d/.test(street) && /[a-z]{2}/i.test(street)) ? (bad = true, 'Please add the full street address, with the house number, like 1708 Vernon Ave.') : '');
    tip('prTownT', !/[a-z]{3}/i.test(town) ? (bad = true, 'Please add the town, like Llano.') : '');
    tip('prZipT', zip.length !== 5 ? (bad = true, 'Please add the 5-digit ZIP code.') : '');
    var em = el('prEmail').value.trim();
    tip('prEmailT', em && !mailOk(em) ? 'Please check the email. It should look like name@example.com.' : '');   // a tip only: it never stops the request
    if (bad) { var first = root.querySelector('.tip:not(:empty)'); if (first && first.previousElementSibling && first.previousElementSibling.scrollIntoView) first.previousElementSibling.scrollIntoView({ block: 'center' }); return; }
    var req = { id: newId(), name: name, phone: d, email: mailOk(em) ? em : '', street: street, town: town, zip: zip, what: what,
      when: el('prWhen').value, textOk: el('prText').checked, hp: el('prHp').value, at: Date.now() };
    var q = load(); q.push(req); save(q);   // kept on this phone until the office has it
    mine = req.id; busy = true; el('prGo').disabled = true; el('prGo').textContent = 'Sending...';
    send(req).then(function (r) { busy = false; finish(r); });
  }

  // Answers {ok:true} (the office has it), {ok:false,error} (it will never be accepted: say why) or {offline:true} (try again later).
  function send(req) {
    if (/PASTE_TEXTS/.test(TEXTS_URL)) return Promise.resolve({ ok: false, error: 'This form is not set up yet. Please call us at ' + PHONE + '.' });
    var ctl = window.AbortController ? new AbortController() : null, t = ctl && setTimeout(function () { ctl.abort(); }, 30000);
    // text/plain keeps this a simple request, so the browser needs no permission check first. The same id on a retry is saved once.
    return fetch(TEXTS_URL.split('?')[0] + '?req=1', { method: 'POST', body: JSON.stringify(req), signal: ctl && ctl.signal })
      .then(function (r) { clearTimeout(t); return r.json(); })
      .then(function (o) { return o && o.ok ? { ok: true, id: req.id } : { ok: false, error: (o && o.error) || 'Something went wrong. Please call us at ' + PHONE + '.', id: req.id }; },
        function () { clearTimeout(t); return { offline: true, id: req.id }; });
  }
  function drop(id) { save(load().filter(function (r) { return r.id !== id; })); }

  function finish(r) {
    el('prGo').disabled = false; el('prGo').textContent = 'Send my request';
    if (r.ok) { drop(r.id); return thanks(); }
    if (r.offline) {
      var m = el('prMsg'); m.style.display = 'block';
      m.innerHTML = 'No signal right now, so your request is saved on this phone. Keep this page open and it will send itself when you are back online, or call us at <a href="tel:3252489515">' + PHONE + '</a>.';
      return;
    }
    drop(r.id);
    var m2 = el('prMsg'); m2.style.display = 'block'; m2.textContent = r.error;
  }
  function thanks() {
    root.innerHTML = '<div class="done"><h2>Thank you. We got your request.</h2><p class="sub">We will text or call you shortly.<br>If it is an emergency, please call now.</p>' +
      '<a class="call" href="tel:3252489515">' + PHONE + '</a></div>';
    try { root.scrollIntoView({ block: 'start' }); } catch (e) {}
  }

  // A request saved while offline is sent again when the phone has signal (the same id, so it is never doubled).
  function retry() {
    var q = load(); if (!q.length || busy || !el('prGo')) return;
    busy = true;
    send(q[0]).then(function (r) {
      busy = false;
      // Only the request typed on this page shows the thank-you; an older one saved on the phone is sent quietly.
      if (r.ok) { drop(q[0].id); if (q[0].id === mine) thanks(); }
      else if (!r.offline) drop(q[0].id);
    });
  }
  window.addEventListener('online', retry);
  setInterval(retry, 20000);
  draw();
})();
