// Customer signing page: shows the contract (with drawings), lets the signer adopt a signature,
// initial, tick and fill their boxes, agree to e-sign, and submit. Works on phones, tablets and computers.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// the live app uses /sign/<token>; the demo uses sign.html#<token>
const token = decodeURIComponent(location.pathname.split('/sign/')[1] || location.hash.slice(1) || '').replace(/\/.*$/, '');
const API = `/api/sign/${encodeURIComponent(token)}`;
const ROLE = { customer: 'Customer', cobuyer: 'Co-buyer', company: 'Seller' };
let info, values = {}, sigPng = null, initPng = null;

async function j(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Something went wrong. Please try again.'), { status: r.status });
  return d;
}
const message = (title, body, extra = '') => { $('#bar').hidden = true; $('#app').innerHTML = `<div class="card center" style="max-width:560px;margin:30px auto">${title}${body ? `<p class="sub">${body}</p>` : ''}${extra}</div>`; };

async function boot() {
  try { info = await j('GET', API); }
  catch (e) { return message('<h1>Link not valid</h1>', esc(e.message)); }
  const c = info.company, k = info.contract, me = info.signer;
  document.documentElement.style.setProperty('--brand', c.brand_color || '#2f6b4f');
  document.title = `Sign ${k.number}${c.name ? ' — ' + c.name : ''}`;
  if (c.logo_url) { $('#logo').src = c.logo_url; $('#logo').hidden = false; } else $('#co').textContent = c.name;
  $('#num').textContent = k.number;
  const dl = info.signed_pdf ? `<p style="margin-top:18px"><a class="btn" href="${esc(info.signed_pdf)}">Download your signed contract (PDF)</a></p>` : '';
  if (k.status === 'void') return message('<h1>This contract was cancelled</h1>', `${esc(c.name)} voided contract ${esc(k.number)}${k.void_reason ? ': ' + esc(k.void_reason) : ''}. Contact them${c.phone ? ' at ' + esc(c.phone) : ''} if you have questions.`);
  if (me.status === 'signed') return message('<div class="big-ok">✓</div><h1>You already signed</h1>', k.status === 'completed' ? 'Everyone has signed. Your copy is ready.' : "We'll send you the signed copy as soon as everyone has signed.", dl);
  if (k.expired) return message('<h1>This link has expired</h1>', `Ask ${esc(c.name)}${c.phone ? ' (' + esc(c.phone) + ')' : ''} to send you a new signing link.`);

  const mine = info.fields.filter(f => f.mine);
  const first = String(me.name || '').split(' ')[0];
  const rto = k.rto;
  $('#app').innerHTML = `<div class="card"><h1>${first ? `Hi ${esc(first)}, ` : ''}please review &amp; sign</h1>
    <p class="sub">${esc(k.template_name || 'Your contract')} from ${esc(c.name)}${me.role !== 'customer' ? ` · signing as <b>${esc(ROLE[me.role])}</b>` : ''}. Your 3D rendering, floor plan and elevations are included — scroll through everything before you sign.</p>
    <div class="facts">${k.shed ? `<div><small>Building</small><b>${esc(k.shed)}</b></div>` : ''}${rto?.monthly_total ? `<div><small>Monthly payment</small><b>${esc(rto.monthly_total)}</b></div><div><small>Term</small><b>${esc(rto.term_months)} months</b></div><div><small>Due at signing</small><b>${esc(rto.deposit)}</b></div>` : k.total ? `<div><small>Total</small><b>${esc(k.total)}</b></div>` : ''}
      <div><small>Your boxes</small><b>${mine.length} to complete</b></div></div>
    ${info.others.length ? `<p class="muted" style="margin:12px 0 0">Also signing: ${info.others.map(o => `${esc(o.name)} (${esc(ROLE[o.role])}${o.status === 'signed' ? ' — signed' : ''})`).join(', ')}</p>` : ''}</div>
    <div class="pages" id="pages"><div class="loading"><span class="spin"></span>Loading document…</div></div>`;
  $('#consentT').textContent = info.consent_text;
  $('#bar').hidden = false;
  j('POST', API + '/viewed', {}).catch(() => {});
  // auto-filled for this signer
  const today = new Date().toLocaleDateString('en-US');
  for (const f of mine) if (f.type === 'date_signed') values[f.id] = today;
  await renderPages();
  refresh();
}

async function renderPages() {
  const pf = window.__pdfjsFiles || { lib: '/vendor/pdfjs/pdf.min.mjs', worker: '/vendor/pdfjs/pdf.worker.min.mjs' };
  const lib = await import(/* webpackIgnore: true */ pf.lib);
  lib.GlobalWorkerOptions.workerSrc = pf.worker;
  const buf = await (await fetch(API + '/document.pdf')).arrayBuffer();
  const doc = await lib.getDocument({ data: buf }).promise;
  const host = $('#pages'); host.innerHTML = '';
  const W = host.clientWidth || 360; lastW = W; const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  for (let i = 0; i < doc.numPages; i++) {
    const pg = await doc.getPage(i + 1);
    const v1 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: (W / v1.width) * dpr });
    const box = document.createElement('div'); box.className = 'page'; box.style.aspectRatio = `${v1.width} / ${v1.height}`;
    const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height); box.appendChild(cv);
    const layer = document.createElement('div'); layer.className = 'layer'; layer.dataset.page = i; box.appendChild(layer);
    host.appendChild(box);
    pg.render({ canvasContext: cv.getContext('2d'), viewport: vp });
  }
  drawFields();
}

function fieldHTML(f) {
  const st = `left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%`;
  if (!f.mine) return `<div class="fld other" style="${st}" title="${esc(ROLE[f.role])}">${f.type === 'signature' ? esc(ROLE[f.role]) + ' signs' : f.type === 'initials' ? '' : ''}</div>`;
  const v = values[f.id]; const done = isDone(f);
  const cls = `fld mine ${done ? 'done' : ''} ${f.required === false ? 'optional' : ''}`;
  if (f.type === 'signature' || f.type === 'initials') return `<div class="${cls}" style="${st}" data-f="${f.id}" role="button" tabindex="0" aria-label="${f.type === 'initials' ? 'Initial here' : 'Sign here'}">${v ? `<img src="${v}" alt="">` : (f.type === 'initials' ? 'Initial' : 'Sign here')}</div>`;
  if (f.type === 'date_signed') return `<div class="${cls} done" style="${st};justify-content:flex-start;padding-left:4px;color:var(--ink);font-weight:600;font-size:var(--fs)">${esc(v || '')}</div>`;
  if (f.type === 'text') return `<div class="${cls}" style="${st};justify-content:flex-start;padding-left:4px;font-size:var(--fs);font-weight:600;color:${v ? 'var(--ink)' : '#6b4f00'}" data-t="${f.id}" role="button" tabindex="0">${esc(v || f.label || (f.required === false ? 'Optional — tap to type' : 'Tap to type'))}</div>`;
  if (f.type === 'checkbox') return `<div class="${cls}" style="${st}" data-c="${f.id}" role="checkbox" aria-checked="${v === true}" tabindex="0">${v === true ? '<span class="tick">✓</span>' : ''}</div>`;
  return '';
}
function drawFields() {
  for (const L of $$('.layer')) {
    const p = Number(L.dataset.page), H = L.clientHeight || 600;
    L.innerHTML = info.fields.filter(f => f.page === p).map(f => fieldHTML(f).replace('var(--fs)', Math.max(7, Math.min(14, f.h * H * 0.68)).toFixed(1) + 'px')).join('');
  }
}
function textSheet(f) {
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><h2>${esc(f.label || 'Fill in')}</h2>
    <input class="typed" maxlength="500" value="${esc(values[f.id] || '')}" placeholder="${f.required === false ? 'Optional' : ''}">
    <div style="display:flex;gap:10px"><button class="btn ghost" data-cancel style="flex:1">Cancel</button><button class="btn" data-ok style="flex:2">Done</button></div></div>`;
  document.body.appendChild(m);
  const inp = $('input', m); setTimeout(() => inp.focus(), 50);
  const ok = () => { values[f.id] = inp.value.trim(); m.remove(); drawFields(); refresh(); };
  $('[data-ok]', m).onclick = ok; inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
  $('[data-cancel]', m).onclick = () => m.remove(); m.addEventListener('click', e => { if (e.target === m) m.remove(); });
}
const isDone = f => (f.type === 'checkbox' ? values[f.id] === true : f.type === 'date_signed' ? true : !!String(values[f.id] ?? '').trim());
const required = () => info.fields.filter(f => f.mine && f.required !== false && f.type !== 'date_signed');
function refresh() {
  const req = required(); const done = req.filter(isDone).length;
  $('#progT').textContent = req.length ? `${done} of ${req.length} required boxes done` : 'Ready to sign';
  $('#progB').style.width = (req.length ? (done / req.length) * 100 : 100) + '%';
  const all = done === req.length;
  $('#next').hidden = all; $('#next').textContent = done ? 'Next' : 'Start';
  $('#consentRow').hidden = !all; $('#finish').hidden = !all;
  $('#finish').disabled = !$('#consent').checked;
}
function goNext() {
  const f = required().find(x => !isDone(x)); if (!f) return refresh();
  const el = $(`[data-f="${f.id}"], [data-c="${f.id}"], [data-t="${f.id}"]`);
  const box = el?.closest('.fld') || el;
  box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box?.classList.add('flash'); setTimeout(() => box?.classList.remove('flash'), 1200);
  if (f.type === 'text') setTimeout(() => textSheet(f), 450);
  else if (f.type === 'signature' || f.type === 'initials') setTimeout(() => adopt(f), 450);
}

// ---- adopt signature / initials -------------------------------------------
function trim(cv) {
  const ctx = cv.getContext('2d'); const { width: w, height: h } = cv; const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
function adopt(field) {
  const isInit = field.type === 'initials';
  const existing = isInit ? initPng : sigPng;
  if (existing && !values[field.id]) { values[field.id] = existing; drawFields(); refresh(); return; }
  const name = info.signer.name || '';
  const typedDefault = isInit ? name.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('') : name;
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><h2>${isInit ? 'Your initials' : 'Your signature'}</h2>
    <div class="tabs"><button class="on" data-mode="draw">Draw</button><button data-mode="type">Type</button></div>
    <div data-pane="draw"><div class="pad ${isInit ? 'init' : ''}"><canvas></canvas><div class="line"></div><div class="x">✕</div></div><div class="muted" style="margin-top:6px;display:flex;justify-content:space-between"><span>Use your finger or mouse</span><button class="btn ghost" style="padding:4px 12px;font-size:13px" data-clear>Clear</button></div></div>
    <div data-pane="type" hidden><input class="typed" value="${esc(typedDefault)}" maxlength="${isInit ? 5 : 60}" aria-label="Type your ${isInit ? 'initials' : 'name'}"><div class="typed-prev" style="margin-top:8px"></div></div>
    <p class="muted" style="margin:0">By clicking Adopt, I agree this is my electronic ${isInit ? 'initials' : 'signature'} and it will be used everywhere I ${isInit ? 'initial' : 'sign'} on this contract.</p>
    <div style="display:flex;gap:10px"><button class="btn ghost" data-cancel style="flex:1">Cancel</button><button class="btn" data-ok style="flex:2">Adopt &amp; ${isInit ? 'initial' : 'sign'}</button></div></div>`;
  document.body.appendChild(m);
  const cv = $('canvas', m), pad = $('.pad', m);
  let mode = 'draw', ink = false, drawing = false, last = null;
  const size = () => { const r = cv.getBoundingClientRect(); const dpr = Math.min(3, window.devicePixelRatio || 1); cv.width = r.width * dpr; cv.height = r.height * dpr; const c = cv.getContext('2d'); c.scale(dpr, dpr); c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = '#0d1b4c'; c.lineWidth = 2.6; };
  size();
  const pt = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.addEventListener('pointerdown', e => { drawing = true; last = pt(e); cv.setPointerCapture(e.pointerId); const c = cv.getContext('2d'); c.beginPath(); c.arc(last.x, last.y, 1.2, 0, Math.PI * 2); c.fillStyle = '#0d1b4c'; c.fill(); ink = true; e.preventDefault(); });
  cv.addEventListener('pointermove', e => { if (!drawing) return; const p = pt(e); const c = cv.getContext('2d'); c.beginPath(); c.moveTo(last.x, last.y); c.lineTo(p.x, p.y); c.stroke(); last = p; ink = true; e.preventDefault(); });
  const up = () => { drawing = false; }; cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  $('[data-clear]', m).onclick = () => { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); ink = false; };
  const typed = $('.typed', m), prev = $('.typed-prev', m);
  const updPrev = () => { prev.textContent = typed.value; }; typed.oninput = updPrev; updPrev();
  $$('[data-mode]', m).forEach(b => (b.onclick = () => { mode = b.dataset.mode; $$('[data-mode]', m).forEach(x => x.classList.toggle('on', x === b)); $$('[data-pane]', m).forEach(p => (p.hidden = p.dataset.pane !== mode)); if (mode === 'draw') size(); else typed.focus(); }));
  const close = () => m.remove();
  $('[data-cancel]', m).onclick = close;
  m.addEventListener('click', e => { if (e.target === m) close(); });
  $('[data-ok]', m).onclick = async () => {
    let png = null;
    if (mode === 'draw') { if (!ink) { pad.style.borderColor = 'var(--bad)'; return; } png = trim(cv); }
    else {
      const t = typed.value.trim(); if (!t) { typed.focus(); return; }
      try { await document.fonts.load('600 64px "Dancing Script"'); } catch { /* fallback font */ }
      const c = document.createElement('canvas'); const ctx = c.getContext('2d');
      ctx.font = '600 72px "Dancing Script", cursive'; const w = Math.ceil(ctx.measureText(t).width) + 30;
      c.width = Math.max(60, w); c.height = 110; const x = c.getContext('2d'); x.font = '600 72px "Dancing Script", cursive'; x.fillStyle = '#0d1b4c'; x.textBaseline = 'middle'; x.fillText(t, 14, 58);
      png = trim(c);
    }
    if (!png) return;
    if (isInit) initPng = png; else sigPng = png;
    // apply everywhere this signer signs / initials
    for (const f of info.fields.filter(x => x.mine && x.type === field.type)) values[f.id] = png;
    close(); drawFields(); refresh();
    setTimeout(goNext, 250);
  };
}

document.addEventListener('click', e => {
  const s = e.target.closest('[data-f]'); if (s) { const f = info.fields.find(x => x.id === s.dataset.f); if (values[f.id] && !confirm(`Change your ${f.type === 'initials' ? 'initials' : 'signature'}?`)) return; if (values[f.id]) { if (f.type === 'initials') initPng = null; else sigPng = null; values[f.id] = null; } adopt(f); return; }
  const t = e.target.closest('[data-t]'); if (t) { textSheet(info.fields.find(x => x.id === t.dataset.t)); return; }
  const c = e.target.closest('[data-c]'); if (c) { values[c.dataset.c] = values[c.dataset.c] !== true; drawFields(); refresh(); }
});
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-f], [data-c], [data-t]')) { e.preventDefault(); e.target.click(); } });
$('#next').onclick = goNext;
$('#consent').onchange = refresh;
$('#finish').onclick = async () => {
  const btn = $('#finish'); btn.disabled = true; btn.textContent = 'Signing…'; $('#err').hidden = true;
  try {
    const out = {}; for (const f of info.fields.filter(x => x.mine)) if (values[f.id] != null && f.type !== 'date_signed') out[f.id] = values[f.id];
    const r = await j('POST', API + '/sign', { consent: true, values: out });
    window.scrollTo({ top: 0 });
    message('<div class="big-ok">✓</div><h1>Signed — thank you!</h1>',
      r.completed ? `Everyone has signed. ${esc(info.company.name)} has been notified and a copy is on its way to you.` : `We'll send you the fully signed copy once ${r.waiting_on === 1 ? 'the other signer finishes' : 'everyone has signed'}.`,
      r.signed_pdf ? `<p style="margin-top:18px"><a class="btn" href="${esc(r.signed_pdf)}">Download your signed contract (PDF)</a></p>` : '');
  } catch (e) {
    $('#err').textContent = e.message; $('#err').hidden = false; btn.disabled = false; btn.textContent = 'Finish & sign';
    if (e.status === 409 || e.status === 410) setTimeout(boot, 1500);
  }
};
// re-draw sharper when the page width really changes (rotating a phone), not when the URL bar hides
let rw, lastW = 0;
window.addEventListener('resize', () => { clearTimeout(rw); rw = setTimeout(() => { const w = $('#pages')?.clientWidth || 0; if (info && w && Math.abs(w - lastW) > 40) renderPages(); }, 400); });
boot();
