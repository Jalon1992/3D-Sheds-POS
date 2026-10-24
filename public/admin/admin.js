// Admin dashboard (vanilla JS SPA).
import { ShedScene, BUILTIN_KINDS } from '../js/shed3d.js';
import { defaultConfig, money, WALLS, DEFAULT_ROOFING, MAX_TIERS, roofingList } from '../js/shared/pricing.js';
import { shedGeometry, roofSections } from '../js/shared/geometry.js';
import { buildDrawingPackage } from '../js/drawings.js';
import { crmContacts, crmConversations, crmPipeline, crmTasks, ordersBoard, messagingPage } from './crm.js';
import { posPage } from './pos.js';
const roofing = () => (Array.isArray(settings.roofing) && settings.roofing.length ? settings.roofing : DEFAULT_ROOFING);

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => money(n);
const ftIn = v => { const t = Math.round(Number(v || 0) * 12 * 4) / 4, f = Math.floor(t / 12), i = +(t - f * 12).toFixed(2); return `${f}' ${i}"`; };
const fmtDate = s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';
const PENCIL = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const COPY = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>';

const CATEGORIES = [['doors', 'Doors'], ['windows', 'Windows'], ['interior', 'Shelves & loft'], ['electrical', 'Electrical'], ['exterior', 'Exterior'], ['upgrades', 'Upgrades']];
const PLACEMENTS = [
  ['opening', 'Opening in wall (doors, windows, vents)'], ['wall_exterior', 'On outside of wall (flower box, lights)'],
  ['wall_interior', 'On inside of wall (shelves, benches, outlets)'], ['ceiling', 'Ceiling (lights)'], ['loft', 'Loft (runs full wall length)'],
  ['ground', 'Ground in front of a wall (ramps)'], ['roof', 'On the roof ridge (cupola)'], ['none', 'No 3D placement — line item / toggle'],
];
const PRICE_UNITS = [['each', 'Each'], ['per_ft_wall', 'Per ft of the wall it is on'], ['per_ft_width', 'Per ft of shed width'], ['per_ft_depth', 'Per ft of shed depth'], ['per_sqft', 'Per sq ft of floor'], ['per_ft_perimeter', 'Per ft of perimeter']];
const STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'];
const CONFIG_URL = window.__configuratorUrl || '/';
const planUrl = id => (window.__planUrl ? window.__planUrl(id) : `/api/v1/quotes/${id}/floorplan.svg`);
function saveFile(blob, name) {
  if (window.__shedSave) return window.__shedSave(blob, name);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
}

// ---------------------------------------------------------------------------
// API + UI helpers
// ---------------------------------------------------------------------------
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (r.status === 401 && !url.includes('/auth/')) { showLogin(); throw new Error('Please log in'); }
  if (r.status === 204) return null;
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data?.error || data || r.statusText);
  return data;
}
function toast(msg, bad = false) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }
const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

function field(f, v) {
  const full = f.full ? ' full' : '';
  const help = f.help ? `<small>${f.help}</small>` : '';
  const val = v ?? f.default ?? '';
  switch (f.type) {
    case 'section': return `<div class="section-t">${esc(f.label)}</div>`;
    case 'html': return f.html;
    case 'checkbox': return `<label class="fld${full}"><span>&nbsp;</span><label class="chk"><input type="checkbox" name="${f.key}" ${val === true || val === 1 || val === '1' ? 'checked' : ''}>${esc(f.label)}</label>${help}</label>`;
    case 'multi': { const sel = Array.isArray(val) && val.length ? val : f.options.map(o => o[0]);
      return `<div class="fld${full}"><span>${esc(f.label)}</span><div class="row">${f.options.map(([k, l]) => `<label class="chk"><input type="checkbox" data-multi="${f.key}" value="${esc(k)}" ${sel.includes(k) ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>${help}</div>`; }
    case 'select': return `<label class="fld${full}"><span>${esc(f.label)}</span><select name="${f.key}">${(typeof f.options === 'function' ? f.options() : f.options).map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${help}</label>`;
    case 'textarea': return `<label class="fld${full}"><span>${esc(f.label)}</span><textarea name="${f.key}" ${f.ph ? `placeholder="${esc(f.ph)}"` : ''}>${esc(val)}</textarea>${help}</label>`;
    case 'json': return `<label class="fld${full}"><span>${esc(f.label)}</span><textarea class="code" name="${f.key}" data-json>${esc(typeof val === 'string' ? val : JSON.stringify(val || f.empty || {}, null, 2))}</textarea>${help}</label>`;
    case 'color': return `<label class="fld${full}"><span>${esc(f.label)}</span><div class="color-in"><input type="color" value="${esc(val || '#888888')}" data-mirror="${f.key}"><input name="${f.key}" value="${esc(val)}" class="in" style="flex:1"></div>${help}</label>`;
    case 'upload': return `<div class="fld${full}"><span>${esc(f.label)}</span><div class="upl"><input type="hidden" name="${f.key}" value="${esc(val)}"><div class="fn" data-fn="${f.key}">${val ? esc(val.split('/').pop()) : 'None'}</div>
      <label class="btn ghost sm">Upload<input type="file" accept="${f.accept}" data-upload="${f.key}" hidden></label>${'<button type="button" class="btn link sm" data-clear="' + f.key + '">Clear</button>'}</div>${help}</div>`;
    default: return `<label class="fld${full}"><span>${esc(f.label)}</span><input name="${f.key}" type="${f.type || 'text'}" value="${esc(val)}" ${f.step ? `step="${f.step}"` : ''} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''} ${f.list ? `list="${f.list}"` : ''} ${f.required ? 'required' : ''}>${help}</label>`;
  }
}
function readFields(root, fields) {
  const out = {};
  for (const f of fields) {
    if (!f.key) continue;
    if (f.type === 'multi') { out[f.key] = [...root.querySelectorAll(`[data-multi="${f.key}"]:checked`)].map(x => x.value); continue; }
    const el = root.querySelector(`[name="${f.key}"]`); if (!el) continue;
    if (f.type === 'checkbox') out[f.key] = el.checked ? 1 : 0;
    else if (f.type === 'number') out[f.key] = el.value === '' ? null : Number(el.value);
    else if (f.type === 'json') { try { out[f.key] = el.value.trim() ? JSON.parse(el.value) : (f.empty || {}); } catch { throw new Error(`"${f.label}" is not valid JSON`); } }
    else out[f.key] = el.value;
  }
  return out;
}
function wireInputs(root, onChange) {
  root.addEventListener('input', e => {
    const m = e.target.dataset.mirror; if (m) root.querySelector(`[name="${m}"]`).value = e.target.value;
    if (e.target.name && e.target.closest('.color-in')) { const c = e.target.closest('.color-in').querySelector('[type=color]'); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) c.value = e.target.value; }
    onChange && onChange();
  });
  root.addEventListener('change', guard(async e => {
    const k = e.target.dataset.upload; if (!k || !e.target.files[0]) return onChange && onChange();
    const fd = new FormData(); fd.append('file', e.target.files[0]);
    root.querySelector(`[data-fn="${k}"]`).textContent = 'Uploading…';
    const r = await api('POST', '/api/admin/upload', fd);
    root.querySelector(`[name="${k}"]`).value = r.url; root.querySelector(`[data-fn="${k}"]`).textContent = r.name;
    toast('Uploaded ' + r.name); onChange && onChange();
  }));
  // drag a file onto an upload box
  root.addEventListener('dragover', e => { const u = e.target.closest('.upl'); if (u) { e.preventDefault(); u.classList.add('drop'); } });
  root.addEventListener('dragleave', e => { e.target.closest('.upl')?.classList.remove('drop'); });
  root.addEventListener('drop', e => {
    const u = e.target.closest('.upl'); if (!u) return; e.preventDefault(); u.classList.remove('drop');
    const inp = u.querySelector('input[type=file]'); const f = e.dataTransfer?.files?.[0]; if (!inp || !f) return;
    const dt = new DataTransfer(); dt.items.add(f); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  root.addEventListener('click', e => {
    const k = e.target.dataset.clear; if (!k) return;
    root.querySelector(`[name="${k}"]`).value = ''; root.querySelector(`[data-fn="${k}"]`).textContent = 'None'; onChange && onChange();
  });
}

let modalScene = null;
function openModal({ title, body, narrow = false, foot = '', onMount }) {
  const dlg = $('#modal');
  dlg.className = 'modal' + (narrow ? ' narrow' : '');
  $('#modalBody').innerHTML = `<div class="m-head"><h2>${esc(title)}</h2><button class="icon-btn" data-x>&times;</button></div><div class="m-body">${body}</div>${foot ? `<div class="m-foot">${foot}</div>` : ''}`;
  $('[data-x]', dlg).onclick = closeModal;
  dlg.showModal();
  onMount && onMount($('#modalBody'));
}
function closeModal() { if (modalScene) { modalScene.dispose(); modalScene = null; } $('#modal').close(); }
$('#modal').addEventListener('close', () => { if (modalScene) { modalScene.dispose(); modalScene = null; } });
function confirmBox(msg) { return window.confirm(msg); }

// ---------------------------------------------------------------------------
// Auth + routing
// ---------------------------------------------------------------------------
let me = null, catalog = null, settings = {};
function showLogin() { $('#app').hidden = true; $('#login').hidden = false; }
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  try { me = await api('POST', '/api/auth/login', fd); $('#login').hidden = true; start(); }
  catch (err) { $('#loginErr').textContent = err.message; $('#loginErr').hidden = false; }
};
$('#logout').onclick = async () => { await api('POST', '/api/auth/logout'); location.hash = ''; location.reload(); };

const ROUTES = { dashboard, quotes, crm: crmContacts, conversations: crmConversations, pipeline: crmPipeline, tasks: crmTasks, pos: posPage, orders: ordersBoard,
  styles, colors, options, pricing: pricingPage, integrations, messaging: messagingPage, settings: settingsPage, account };
const ROLE_LABEL = { admin: 'Admin', sales: 'Sales', production: 'Production', delivery: 'Delivery' };
const isAdmin = () => (me?.role || 'admin') === 'admin';
const canEditQuotes = () => ['admin', 'sales'].includes(me?.role || 'admin');
const ROLE_PAGES = { sales: ['crm', 'conversations', 'pipeline', 'tasks', 'pos', 'quotes', 'orders', 'account'], production: ['orders', 'quotes', 'account'], delivery: ['orders', 'account'] };
const HOME = { admin: 'dashboard', sales: 'crm', production: 'orders', delivery: 'orders' };
const allowed = name => isAdmin() || (ROLE_PAGES[me.role] || []).includes(name);
const can = perm => (me?.permissions || []).includes(perm);
/** Live updates: pages register handlers here; they're dropped on every route change. */
const liveHandlers = new Set();
function onLive(fn) { liveHandlers.add(fn); }
const hashQuery = () => new URLSearchParams(location.hash.split('?')[1] || '');
let routeSeq = 0;
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').map(decodeURIComponent);
  const r = parts[0], arg = parts[1];
  const home = HOME[me?.role || 'admin'] || 'quotes';
  let name = ROUTES[r] ? r : home;
  if (!allowed(name)) name = home;
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === name));
  liveHandlers.clear();
  const seq = ++routeSeq;
  const old = $('#main'), fresh = old.cloneNode(false); old.replaceWith(fresh); // drop old listeners
  $('#main').innerHTML = '<div class="empty">Loading…</div>';
  try { await ROUTES[name](arg, parts.slice(1)); } catch (e) { if (seq === routeSeq) $('#main').innerHTML = `<div class="card card-pad err">${esc(e.message)}</div>`; }
}
// one live connection per tab: new leads, texts, signed contracts and board moves show up for everyone signed in
function connectLive() {
  if (!window.EventSource || window.__noLive) return;
  const es = new EventSource('/api/crm/stream');
  for (const type of ['contact', 'message', 'opportunity', 'contract', 'notification']) es.addEventListener(type, ev => {
    let data = {}; try { data = JSON.parse(ev.data); } catch { /* */ }
    if (type === 'notification') { refreshBell(); toast(data.title + (data.body ? ' — ' + data.body : '')); }
    if (type === 'message' && data.direction === 'in') refreshBell();
    for (const fn of [...liveHandlers]) { try { fn(type, data); } catch (e) { console.error(e); } }
  });
}
async function refreshBell() {
  try {
    const n = await api('GET', '/api/crm/notifications');
    $('#bellCount').textContent = n.unread > 99 ? '99+' : n.unread; $('#bellCount').hidden = !n.unread;
    $('#bellList').innerHTML = n.data.length ? n.data.map(x => `<a class="bell-item ${x.read ? '' : 'unread'}" href="${esc(x.link || '#')}"><b>${esc(x.title)}</b>${x.body ? `<span>${esc(x.body)}</span>` : ''}<small>${fmtDate(x.created_at)}</small></a>`).join('') : '<div class="empty" style="padding:20px">Nothing yet</div>';
  } catch { /* offline */ }
}
async function loadCatalog() { catalog = await api('GET', '/api/admin/catalog'); return catalog; }
async function start() {
  $('#app').hidden = false;
  // hide admin-only navigation for sales / production accounts
  $$('#nav a').forEach(a => { a.hidden = !allowed(a.dataset.r); });
  $$('#nav .nav-h').forEach(h => { let n = h.nextElementSibling, any = false; while (n && !n.classList.contains('nav-h')) { if (n.tagName === 'A' && !n.hidden) any = true; n = n.nextElementSibling; } h.hidden = !any; });
  if (!isAdmin()) $('#sideName').insertAdjacentHTML('afterend', `<span class="pill" style="margin-left:6px">${ROLE_LABEL[me.role]}</span>`);
  $('#bellBtn').onclick = e => { e.stopPropagation(); const open = $('#bellPanel').hidden; $('#bellPanel').hidden = !open; if (open) { refreshBell(); api('POST', '/api/crm/notifications/read').then(() => { $('#bellCount').hidden = true; }).catch(() => {}); } };
  document.addEventListener('click', e => { if (!e.target.closest('#bellPanel')) $('#bellPanel').hidden = true; });
  refreshBell(); connectLive();
  settings = await api('GET', '/api/admin/settings');
  $('#sideName').textContent = settings.company_name || 'Shed Builder';
  if (settings.brand_color) document.documentElement.style.setProperty('--brand', settings.brand_color);
  window.onhashchange = route; route();
}
(async () => {
  const cfg = document.querySelector('.side-foot a.btn'); if (cfg) cfg.href = CONFIG_URL;
  try { me = await api('GET', '/api/auth/me'); start(); } catch { showLogin(); }
})();

export { $, $$, esc, api, toast, guard, openModal, closeModal, confirmBox, fmt, fmtDate, saveFile, field, readFields, wireInputs, loadCatalog, me, settings, catalog, can, isAdmin, onLive, hashQuery, ROLE_LABEL, CHECK, PENCIL, TRASH, COPY, downloadDrawings, quoteDetail, CONFIG_URL };
export function head(title, sub, actions = '') { return `<div class="head"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="row">${actions}</div></div>`; }

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
async function dashboard() {
  const [s, keys, hooks] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/api-keys'), api('GET', '/api/v1/webhooks')]);
  const days = []; for (let i = 29; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); days.push([d, s.daily.find(x => x.d === d)?.n || 0]); }
  const max = Math.max(1, ...days.map(d => d[1]));
  const won = s.byStatus.find(x => x.status === 'won')?.n || 0;
  const checks = [
    [settings.company_name && settings.company_name !== 'Your Shed Co.', 'Add your company name, logo and brand color', '#/settings'],
    [me.email !== 'admin@example.com', 'Change the default admin login', '#/account'],
    [settings.ghl_enabled || settings.ghl_inbound_webhook_url, 'Connect GoHighLevel', '#/integrations'],
    [hooks.length > 0 || keys.length > 0, 'Add a webhook or API key for other software', '#/integrations/webhooks'],
    [true, 'Review styles, sizes and prices', '#/styles'],
  ];
  $('#main').innerHTML = head('Dashboard', `Welcome back${me.name ? ', ' + esc(me.name) : ''}.`, `<a class="btn ghost" href="${CONFIG_URL}" target="_blank" title="Opens the dealer-facing configurator: prices always shown">Open configurator (dealer mode) ↗</a>`) + `
  <div class="grid g4">
    <div class="card card-pad stat"><div class="lbl">Quotes (30 days)</div><div class="val">${s.last30}</div></div>
    <div class="card card-pad stat"><div class="lbl">Quoted value (30 days)</div><div class="val">${fmt(s.value30)}</div></div>
    <div class="card card-pad stat"><div class="lbl">All-time quotes</div><div class="val">${s.total}</div></div>
    <div class="card card-pad stat"><div class="lbl">Won</div><div class="val">${won}</div></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card card-pad"><h2>Quotes per day</h2><p class="muted" style="margin:0">Last 30 days</p>
      <div class="bars">${days.map(([d, n]) => `<div style="height:${(n / max) * 100}%" title="${d}: ${n}"></div>`).join('')}</div></div>
    <div class="card card-pad"><h2>Getting set up</h2>${checks.map(([ok, t, href]) => `<a class="check ${ok ? 'done' : ''}" href="${href}" style="color:inherit;text-decoration:none"><span class="dot">${ok ? CHECK : ''}</span><span>${t}</span></a>`).join('')}</div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-pad" style="padding-bottom:6px"><h2>Popular styles</h2></div>
    ${s.byStyle.length ? `<table class="tbl"><tr><th>Style</th><th class="num">Quotes</th><th class="num">Avg. price</th></tr>${s.byStyle.map(r => `<tr><td>${esc(r.style_name)}</td><td class="num">${r.n}</td><td class="num">${fmt(r.avg)}</td></tr>`).join('')}</table>` : '<div class="empty">No quotes yet.</div>'}
  </div>`;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------
async function quotes(id) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const render = async () => {
    const search = $('#qs')?.value || '', status = $('#qst')?.value || '';
    const res = await api('GET', `/api/v1/quotes?limit=200&q=${encodeURIComponent(search)}&status=${status}`);
    $('#qtable').innerHTML = res.data.length ? `<table class="tbl"><tr><th>Quote</th><th>Date</th><th>Customer</th><th>Shed</th><th>Dealer / tier</th><th class="num">Total</th><th>Status</th><th>CRM</th><th></th></tr>
      ${res.data.map(x => `<tr class="click" data-id="${x.id}"><td><b>${esc(x.number)}</b></td><td class="muted">${fmtDate(x.created_at)}</td>
      <td>${esc(x.customer.full_name)}<div class="muted" style="font-size:12.5px">${esc(x.customer.email)} ${x.customer.phone ? '· ' + esc(x.customer.phone) : ''}</div></td>
      <td>${esc(x.shed.style)} <span class="muted">${esc(x.shed.size)}</span></td>
      <td>${x.dealer ? esc(x.dealer.name) : ''}<div class="muted" style="font-size:12.5px">${esc(x.pricing.tier || '')}${x.pricing.pricing_zip ? ' · ZIP ' + esc(x.pricing.pricing_zip) : ''}</div></td><td class="num"><b>${fmt(x.pricing.total)}</b></td>
      <td><span class="pill ${esc(x.status)}">${esc(x.status)}</span></td><td>${x.integrations.ghl_contact_id ? '<span class="pill on">GHL ✓</span>' : '<span class="muted">—</span>'}</td>
      <td class="num" style="white-space:nowrap">${canEditQuotes() ? `<button class="btn ghost sm" data-qpdf="${x.id}" title="Prices + drawings in one PDF">Quote PDF</button> ` : ''}<button class="btn ghost sm" data-draw="${x.id}" title="Floor plan + elevations, no prices">Drawings PDF</button></td></tr>`).join('')}</table>`
      : '<div class="empty">No quotes found. Submit one from the configurator to see it here.</div>';
    $('#qcount').textContent = `${res.total} quote${res.total === 1 ? '' : 's'}`;
  };
  $('#main').innerHTML = head('Quotes', 'Every quote submitted from the configurator or the API.', `<a class="btn ghost" href="#" id="csv">Export CSV</a>`) + `
    <div class="row" style="margin-bottom:12px"><input class="in" id="qs" placeholder="Search name, email, phone or quote #" style="max-width:340px">
      <select class="in" id="qst" style="max-width:160px"><option value="">All statuses</option>${STATUSES.map(s => `<option>${s}</option>`).join('')}</select><span class="muted" id="qcount"></span></div>
    <div class="card tbl-wrap" id="qtable"></div>`;
  let t; $('#qs').oninput = () => { clearTimeout(t); t = setTimeout(render, 250); };
  $('#qst').onchange = render;
  $('#qtable').onclick = e => {
    const d = e.target.closest('[data-draw]'); if (d) { e.stopPropagation(); return downloadDrawings(Number(d.dataset.draw), d); }
    const qp = e.target.closest('[data-qpdf]'); if (qp) { e.stopPropagation(); return downloadDrawings(Number(qp.dataset.qpdf), qp, true); }
    const tr = e.target.closest('tr[data-id]'); if (tr) quoteDetail(Number(tr.dataset.id), render);
  };
  $('#csv').onclick = guard(async e => {
    e.preventDefault();
    const res = await api('GET', '/api/v1/quotes?limit=500');
    const rows = [['Quote', 'Date', 'Status', 'First', 'Last', 'Email', 'Phone', 'Address', 'City', 'State', 'ZIP', 'Style', 'Size', 'Options', 'Dealer lot', 'Price tier', 'Total', '3D link']];
    for (const x of res.data) rows.push([x.number, x.created_at, x.status, x.customer.first_name, x.customer.last_name, x.customer.email, x.customer.phone, x.customer.address, x.customer.city, x.customer.state, x.customer.zip, x.shed.style, x.shed.size, x.options.map(o => o.name).join('; '), x.dealer?.name || '', x.pricing.tier || '', x.pricing.total, x.links.view_3d]);
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    saveFile(new Blob([csv], { type: 'text/csv' }), 'shed-quotes.csv');
  });
  await render();
  if (id) quoteDetail(Number(id), render);
}
async function downloadDrawings(id, btn, withPricing = false) {
  const label = btn?.textContent;
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Building PDF…'; }
    const [x, cat] = await Promise.all([api('GET', `/api/v1/quotes/${id}`), catalog ? Promise.resolve(catalog) : loadCatalog()]);
    const blob = await buildDrawingPackage(cat, x, { company: settings.company_name || '', withPricing, showTier: withPricing, terms: settings.quote_terms || '', money: fmt });
    saveFile(blob, `${x.number}-${withPricing ? 'quote' : 'drawings'}.pdf`);
    toast(withPricing ? 'Quote PDF ready' : 'Drawings PDF ready');
  } catch (e) { toast(e.message, true); }
  finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
}
async function quoteDetail(id, refresh) {
  const x = await api('GET', `/api/v1/quotes/${id}`);
  const c = x.customer;
  openModal({
    title: `Quote ${x.number} — ${c.full_name}`,
    body: `<div class="drawer"><div>
      <div class="row" style="margin-bottom:14px"><a class="btn ghost sm" target="_blank" href="${esc(x.links.view_3d)}">Open in 3D ↗</a>
        <a class="btn ghost sm" target="_blank" href="${esc(x.links.download_3d_model)}">Download 3D model (.glb)</a>
        <button class="btn ghost sm" id="qPlanDl">Download floor plan</button>
        ${canEditQuotes() ? '<button class="btn primary sm" id="qQuotePdf">Quote PDF (prices + drawings)</button>' : ''}
        <button class="btn ${canEditQuotes() ? 'ghost' : 'primary'} sm" id="qDraw">Drawings PDF (no prices)</button>
        ${can('pos.create') ? `<a class="btn primary sm" href="#/pos/new?quote=${x.id}" data-close>Start contract</a>` : ''}
        ${can('crm.view') && x.contact_id ? `<a class="btn ghost sm" href="#/crm/contacts/${x.contact_id}" data-close>Open in CRM</a>` : ''}</div>
      <div class="plan-prev"><img src="${planUrl(x.id)}" alt="Floor plan"></div>
      <h3 style="margin:18px 0 6px">Line items</h3><div class="lines">${x.pricing_lines.map(l => `<div class="ln"><div>${esc(l.label)}${l.note ? `<small>${esc(l.note)}</small>` : ''}${l.wall ? `<small>${esc(l.wall)}</small>` : ''}</div><div>${fmt(l.amount)}</div></div>`).join('')}
      ${x.pricing.delivery ? `<div class="ln"><div>Delivery</div><div>${fmt(x.pricing.delivery)}</div></div>` : ''}${x.pricing.tax ? `<div class="ln"><div>Tax</div><div>${fmt(x.pricing.tax)}</div></div>` : ''}
      <div class="ln tot"><div>Total</div><div>${fmt(x.pricing.total)}</div></div></div>
    </div><div>
      <div class="card card-pad"><dl class="kv">
        <dt>Name</dt><dd>${esc(c.full_name)}</dd><dt>Email</dt><dd><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd>
        <dt>Phone</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</dd>
        <dt>Address</dt><dd>${esc([c.address, c.city, c.state, c.zip].filter(Boolean).join(', ')) || '—'}</dd>
        <dt>SMS consent</dt><dd>${c.sms_consent ? 'Yes' : 'No'}</dd><dt>Notes</dt><dd>${esc(c.notes) || '—'}</dd>
        <dt>Submitted</dt><dd>${fmtDate(x.created_at)}</dd><dt>Source</dt><dd>${esc(x.source) || '—'}</dd>
        <dt>Dealer lot</dt><dd>${x.dealer ? esc(x.dealer.name) : '—'}</dd><dt>Price tier</dt><dd>${esc(x.pricing.tier || '—')}${x.pricing.pricing_zip ? ' (ZIP ' + esc(x.pricing.pricing_zip) + ')' : ''}</dd>
        <dt>GHL</dt><dd>${x.integrations.ghl_contact_id ? `Contact <code>${esc(x.integrations.ghl_contact_id)}</code>` : 'Not synced'}</dd>
      </dl></div>
      ${canEditQuotes() ? `<div class="card card-pad" style="margin-top:14px;display:grid;gap:12px">
        <label class="fld"><span>Status</span><select id="qStatus">${STATUSES.map(s => `<option ${s === x.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="fld"><span>Internal notes</span><textarea id="qNotes">${esc(x.internal_notes || '')}</textarea></label>
        <button class="btn primary" id="qSave">Save</button>
        ${isAdmin() ? `<button class="btn ghost" id="qResend">Re-send to webhooks / GHL</button>
        <button class="btn danger" id="qDel">Delete quote</button>` : ''}
      </div>` : `<div class="card card-pad" style="margin-top:14px"><dl class="kv"><dt>Status</dt><dd><span class="pill ${esc(x.status)}">${esc(x.status)}</span></dd>${x.internal_notes ? `<dt>Notes</dt><dd>${esc(x.internal_notes)}</dd>` : ''}</dl></div>`}</div></div>`,
    onMount: root => {
      $('#qPlanDl', root).onclick = guard(async () => {
        const r = await fetch(planUrl(x.id)); if (!r.ok) throw new Error('Could not load the floor plan');
        saveFile(new Blob([await r.text()], { type: 'image/svg+xml' }), `${x.number}-floor-plan.svg`);
      });
      $('#qDraw', root).onclick = () => downloadDrawings(x.id, $('#qDraw', root));
      $$('[data-close]', root).forEach(a => a.addEventListener('click', () => closeModal()));
      if ($('#qQuotePdf', root)) $('#qQuotePdf', root).onclick = () => downloadDrawings(x.id, $('#qQuotePdf', root), true);
      if ($('#qSave', root)) $('#qSave', root).onclick = guard(async () => { await api('PATCH', `/api/v1/quotes/${id}`, { status: $('#qStatus').value, internal_notes: $('#qNotes').value }); toast('Saved'); refresh && refresh(); });
      if ($('#qResend', root)) $('#qResend', root).onclick = guard(async () => { await api('POST', `/api/v1/quotes/${id}/resend`); toast('Queued — check Integrations → Delivery log'); });
      if ($('#qDel', root)) $('#qDel', root).onclick = guard(async () => { if (!confirmBox('Delete this quote permanently?')) return; await api('DELETE', `/api/v1/quotes/${id}`); closeModal(); refresh && refresh(); toast('Deleted'); });
    },
  });
}

// ---------------------------------------------------------------------------
// Styles & sizes
// ---------------------------------------------------------------------------
const STYLE_FIELDS = () => [
  { key: 'name', label: 'Style name', required: true },
  { key: 'sort', label: 'Sort order', type: 'number' },
  { key: 'description', label: 'Short description (shown to customers)', type: 'textarea', full: true },
  { key: 'roof_type', label: 'Roof style', type: 'select', options: [['gable', 'Gable (A-frame)'], ['barn', 'Barn / gambrel'], ['lean_to', 'Lean-to (single slope)'], ['saltbox', 'Saltbox (offset gable)']] },
  { key: 'ridge_axis', label: 'Front wall', type: 'select', options: [['depth', 'Gable end faces front'], ['width', 'Eave (long side) faces front']] },
  { key: 'wall_height', label: 'Wall height (ft)', type: 'number', step: '0.25' },
  { type: 'section', label: 'Roof pitches & section lengths' },
  { key: 'roof_pitch', label: 'Roof pitch (rise per 12")', type: 'number', step: '0.25', help: 'e.g. 6 = 6/12. Gambrel: the UPPER section. Saltbox: the long slope.' },
  { key: 'roof_pitch_lower', label: 'Gambrel lower pitch (rise per 12")', type: 'number', step: '0.25', ph: '18', help: 'Gambrel (barn) only — the steep lower section.' },
  { key: 'gambrel_lower_len', label: 'Gambrel hip (lower section) length (ft)', type: 'number', step: '0.0625', ph: '3.25', help: 'Along the slope, from the wall to the break. Can be set per size in the size table below.' },
  { key: 'gambrel_upper_len', label: 'Gambrel upper section length (ft) — optional', type: 'number', step: '0.0625', ph: 'auto', help: 'Along the slope, break to ridge. Blank = the upper pitch above decides it. If set, the upper pitch is worked out from this length. Can be set per size too.' },
  { key: 'gambrel_break', label: 'Or: gambrel break (%)', type: 'number', step: '1', ph: '42', help: 'Only used if the length above is blank: break position as % of half the span.' },
  { key: 'roof_pitch_back', label: 'Saltbox short-slope pitch (rise per 12")', type: 'number', step: '0.25', help: 'Saltbox only — the short, steeper slope. The ridge sits where the two slopes meet.' },
  { type: 'html', html: '<div class="full roofinfo" id="roofInfo"></div>' },
  { type: 'section', label: 'Overhangs & siding' },
  { key: 'siding_type', label: 'Siding', type: 'select', options: [['lp_smartside', 'LP SmartSide panel – 8" o.c. grooves'], ['lap', 'Lap siding'], ['board_batten', 'Board & batten'], ['t111', 'T1-11 panel (smooth)'], ['metal', 'Metal']] },
  { key: 'trim_type', label: 'Wood trim', type: 'select', options: [['lp', 'LP SmartSide trim (cedar texture)'], ['smooth', 'Smooth trim']], help: 'Corner boards, fascia, door & window trim. Metal trim is always smooth.' },
  { key: 'overhang', label: 'Eave overhang (ft)', type: 'number', step: '0.05', help: 'Along the low sides of the roof (where water runs off).' },
  { key: 'gable_overhang', label: 'Gable overhang (ft)', type: 'number', step: '0.05', help: 'At the gable/rake ends. Blank = same as eave.' },
  { type: 'section', label: 'Trim sizes (inches)' },
  { key: 'fascia_size', label: 'Fascia height (in)', type: 'number', step: '0.25', ph: '5.5', help: 'Board along the eaves. Trim color.' },
  { type: 'section', label: 'Roof edges (rake & drip edge)' },
  { key: 'roof_edge', label: 'Roof edge style', type: 'select', full: true, options: [['metal_rake', 'Wide metal rake trim (roof color) + fascia'], ['board_drip', 'Rake board + fascia (trim color) with thin metal rake edge & drip edge']] },
  { key: 'rake_size', label: 'Rake board height (in)', type: 'number', step: '0.25', ph: '5.5', help: 'Trim color. Used on shingle roofs and with the rake board + drip edge style.' },
  { key: 'metal_rake_size', label: 'Wide metal rake trim height (in)', type: 'number', step: '0.25', ph: '5.5', help: 'Wide metal rake style on metal roofs. Roof color.' },
  { key: 'rake_cap_size', label: 'Metal rake edge height (in)', type: 'number', step: '0.25', ph: '1.5', help: 'Rake board + drip edge style: the thin metal edge over the rake board.' },
  { key: 'drip_edge_size', label: 'Drip edge height (in)', type: 'number', step: '0.25', ph: '1.5', help: 'Rake board + drip edge style: the metal edge along the top of the fascia.' },
  { key: 'metal_rake_leg', label: 'Metal rake leg (in)', type: 'number', step: '0.25', ph: '2 – 3.5', help: 'How far the metal rake laps onto the roofing.' },
  { key: 'drip_edge_color', label: 'Metal edge color', type: 'select', options: [['roof', 'Match the roof'], ['trim', 'Match the trim']] },
  { key: 'rake_tail', label: 'Fly rafter (rake) tail cut', type: 'select', full: true, options: [['', 'Default — flat on barns, plumb on other roofs'], ['level', 'Flat cut — level with the bottom of the fascia'], ['plumb', 'Plumb cut — vertical, in line with the fascia face']] },
  { type: 'section', label: 'Other trim (trim color)' },
  { key: 'corner_trim', label: 'Corner board width (in)', type: 'number', step: '0.25', ph: '5' },
  { key: 'casing_trim', label: 'Door & window trim width (in)', type: 'number', step: '0.25', ph: '4' },
  { type: 'section', label: 'Roofing' },
  { key: 'roof_material', label: 'Standard roofing (included in price)', type: 'select', options: roofing().map(r => [r.key, r.name]) },
  { key: 'roof_choices', label: 'Roofing customers can choose', type: 'multi', options: roofing().map(r => [r.key, r.name]), help: 'Other choices are charged the difference from the standard roofing.' },
  { key: 'image_url', label: 'Card image (optional — otherwise an icon is shown)', type: 'upload', accept: 'image/*' },
  { key: 'active', label: 'Visible to customers', type: 'checkbox', default: 1 },
];
async function styles() {
  await loadCatalog();
  $('#main').innerHTML = head('Styles & sizes', 'Each style has its own roof, siding, sizes, prices and standard (included) options.', `<button class="btn primary" id="addStyle">+ New style</button>`) + `
    <div class="scards">${catalog.styles.map(s => `<div class="card scard"><div class="pv" data-pv="${s.id}">${s.image_url ? `<img src="${esc(s.image_url)}">` : ''}</div>
      <div class="body"><b>${esc(s.name)}</b> ${s.active ? '' : '<span class="pill off">Hidden</span>'}<div class="muted">${s.sizes.length} sizes · ${s.sizes.length ? fmt(Math.min(...s.sizes.map(z => z.price))) + ' – ' + fmt(Math.max(...s.sizes.map(z => z.price))) : 'no sizes'}</div>
      <div class="muted" style="font-size:12.5px;margin-top:4px">${esc(s.roof_type.replace('_', '-'))} roof · ${esc(s.siding_type.replace('_', ' & '))} · ${s.wall_height}' walls</div></div>
      <div class="foot"><button class="btn ghost sm" data-edit="${s.id}">${PENCIL} Edit</button><div class="row"><button class="icon-btn" title="Duplicate" data-dup="${s.id}">${COPY}</button><button class="icon-btn" title="Delete" data-del="${s.id}">${TRASH}</button></div></div></div>`).join('')}</div>`;
  $('#addStyle').onclick = () => styleEditor(null);
  $('#main').onclick = guard(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edit) styleEditor(catalog.styles.find(s => s.id === Number(b.dataset.edit)));
    if (b.dataset.dup) { await api('POST', `/api/admin/duplicate/styles/${b.dataset.dup}`); toast('Duplicated'); styles(); }
    if (b.dataset.del && confirmBox('Delete this style and all its sizes?')) { await api('DELETE', `/api/v1/styles/${b.dataset.del}`); toast('Deleted'); styles(); }
  });
  // static thumbnails rendered with the real 3D engine
  renderThumbs();
}
async function renderThumbs() {
  const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:-2000px;top:0;width:540px;height:340px';
  document.body.appendChild(holder);
  const sc = new ShedScene(holder);
  for (const s of catalog.styles) {
    const el = $(`[data-pv="${s.id}"]`); if (!el || s.image_url || !s.sizes.length) continue;
    const cfg = defaultConfig(catalog, s.id, s.sizes[Math.floor(s.sizes.length / 2)].id);
    sc.build(catalog, cfg); sc.frame('front34', false);
    await new Promise(r => setTimeout(r, 60));
    el.innerHTML = `<img src="${sc.snapshot()}" alt="">`;
  }
  sc.dispose(); holder.remove();
}

function styleEditor(style) {
  const isNew = !style;
  const s = style || { name: '', roof_type: 'gable', ridge_axis: 'depth', wall_height: 7, roof_pitch: 6, overhang: 0.75, gable_overhang: 0.5, siding_type: 'lp_smartside', trim_type: 'lp', roof_material: 'shingle', active: 1, sort: catalog.styles.length, sizes: [], standard_options: [], default_colors: {} };
  let sizes = (s.sizes || []).map(z => ({ ...z }));
  if (!sizes.length) sizes = [{ width: 8, depth: 10, price: 3500, active: 1 }, { width: 10, depth: 12, price: 5200, active: 1 }];
  // drop standard options whose option has since been deleted
  let stds = (s.standard_options || []).filter(x => catalog.options.some(o => o.id === Number(x.option_id))).map(x => ({ ...x }));
  let previewIdx = Math.min(sizes.length - 1, 1);
  let avail = Array.isArray(s.available_options) ? s.available_options.map(Number) : null; // null = all options
  const availHTML = () => {
    const stdIds = new Set(stds.map(x => Number(x.option_id)));
    const cats = CATEGORIES.filter(([k]) => catalog.options.some(o => o.category === k));
    const off = avail ? catalog.options.filter(o => !stdIds.has(o.id) && !avail.includes(o.id)).length : 0;
    return `<div class="row" style="gap:14px;margin-bottom:8px"><span class="muted" style="font-size:13px">${off ? `<b>${off}</b> option${off > 1 ? 's' : ''} hidden on this style` : 'Every option is offered on this style'}</span>
        <button type="button" class="btn link sm" id="avAll">Tick all</button><button type="button" class="btn link sm" id="avNone">Untick all</button></div>
      <div class="avgrid">${cats.map(([k, l]) => `<div><b>${esc(l)}</b>${catalog.options.filter(o => o.category === k).map(o => {
        const std = stdIds.has(o.id), on = !avail || std || avail.includes(o.id);
        return `<label class="chk"><input type="checkbox" data-av="${o.id}" ${on ? 'checked' : ''} ${std ? 'disabled title="Standard on this style — always offered"' : ''}>${esc(o.name)}${std ? ' <span class="muted">(standard)</span>' : ''}${o.active ? '' : ' <span class="muted">(hidden everywhere)</span>'}</label>`;
      }).join('')}</div>`).join('')}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">Untick anything this style shouldn't offer — customers won't see it on this style. Standard options are always offered. While everything is ticked, options you add later are offered here automatically; once something is unticked, tick new options here to offer them.</div>`;
  };

  const optSel = (v, i) => `<select data-std="${i}" data-k="option_id">${catalog.options.filter(o => o.placement !== 'none' || (Array.isArray(o.package_items) && o.package_items.length)).map(o => `<option value="${o.id}" ${o.id === v ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`;
  const colorSel = cat => `<label class="fld"><span>Default ${cat} color</span><select name="dc_${cat}"><option value="">First in list</option>${catalog.colors.filter(c => c.category === cat).map(c => `<option value="${c.id}" ${c.id === s.default_colors?.[cat] ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`;
  const isBarn = () => (document.querySelector('#sf [name=roof_type]')?.value || s.roof_type) === 'barn';
  const styleVal = k => document.querySelector(`#sf [name=${k}]`)?.value || s[k] || '';
  const sizesHTML = () => `<table class="mini"><tr><th>Width (ft)</th><th>Depth (ft)</th><th>Base price</th>${isBarn() ? '<th title="Gambrel hip (lower section) length for this size">Hip len (ft)</th><th title="Gambrel upper section length for this size">Upper len (ft)</th>' : ''}<th>Active</th><th></th><th></th></tr>
    ${sizes.map((z, i) => `<tr><td><input type="number" step="0.5" data-sz="${i}" data-k="width" value="${z.width}"></td><td><input type="number" step="0.5" data-sz="${i}" data-k="depth" value="${z.depth}"></td>
    <td><input type="number" step="1" data-sz="${i}" data-k="price" value="${z.price}"></td>
    ${isBarn() ? `<td><input type="number" step="0.0625" data-sz="${i}" data-k="hip_len" value="${z.hip_len ?? ''}" placeholder="${esc(styleVal('gambrel_lower_len') || 'style')}"></td><td><input type="number" step="0.0625" data-sz="${i}" data-k="upper_len" value="${z.upper_len ?? ''}" placeholder="${esc(styleVal('gambrel_upper_len') || 'auto')}"></td>` : ''}<td><input type="checkbox" data-sz="${i}" data-k="active" ${z.active !== 0 ? 'checked' : ''}></td>
    <td><button type="button" class="icon-btn" data-pvsize="${i}" title="Preview this size" style="${i === previewIdx ? 'border-color:var(--brand);color:var(--brand)' : ''}">👁</button></td><td><button type="button" class="icon-btn" data-rmsize="${i}">${TRASH}</button></td></tr>`).join('')}</table>
    ${isBarn() ? '<div class="muted" style="font-size:12px;margin-top:6px">Hip / upper lengths: leave blank to use the style\'s values. Measured along the slope without overhang. Click 👁 to preview a size — the roof readout above shows each section\'s pitch and length.</div>' : ''}
    <div class="row" style="margin-top:8px"><button type="button" class="btn ghost sm" id="addSize">+ Add size</button>
    <span class="muted" style="margin-left:auto">Fill prices:</span><input class="in" id="ppsf" type="number" placeholder="$/sq ft" style="width:90px"><input class="in" id="pbase" type="number" placeholder="+ base $" style="width:90px"><button type="button" class="btn ghost sm" id="fillP">Apply</button></div>`;
  const optOf = id => catalog.options.find(o => o.id === Number(id)) || {};
  const gm = id => optOf(id).gable_mode || '';
  const stdHTML = () => `<table class="mini"><tr><th>Option</th><th>Wall</th><th>Offset (ft)</th><th>Width (ft)</th><th>Height (ft)</th><th title="Windows set up to go in the gable">In gable</th><th></th></tr>
    ${stds.map((x, i) => `<tr><td>${optSel(x.option_id, i)}</td><td><select data-std="${i}" data-k="wall">${WALLS.map(w => `<option ${w === x.wall ? 'selected' : ''}>${w}</option>`).join('')}</select></td>
    <td><input type="number" step="0.25" data-std="${i}" data-k="offset" value="${x.offset || 0}"></td>
    <td><input type="number" step="0.05" data-std="${i}" data-k="w" value="${x.w ?? ''}" placeholder="${optOf(x.option_id).width ?? ''}"></td>
    <td><input type="number" step="0.05" data-std="${i}" data-k="h" value="${x.h ?? ''}" placeholder="${optOf(x.option_id).height ?? ''}"></td>
    <td style="text-align:center">${gm(x.option_id) === 'allow' ? `<input type="checkbox" data-std="${i}" data-k="gable" ${x.gable ? 'checked' : ''}>` : gm(x.option_id) === 'only' ? '<span class="muted">always</span>' : '<span class="muted">—</span>'}</td>
    <td><button type="button" class="icon-btn" data-rmstd="${i}">${TRASH}</button></td></tr>`).join('')}</table>
    <button type="button" class="btn ghost sm" id="addStd" style="margin-top:8px">+ Add standard option</button>
    <div class="muted" style="font-size:12px;margin-top:6px">Items can't overlap — their trim included. If one doesn't fit where you put it, the builder slides it to the nearest free spot. Offset is measured from the centre of the wall, looking at it from outside (+ = right). Width/height let you size a door or window just for this style (leave blank to use the option's own size — e.g. make the 36" door 6'-8" tall here, 7'-0" on the garage). Standard options are included in the base price; customers pay only the difference to upgrade.</div>`;

  openModal({
    title: isNew ? 'New style' : `Edit ${s.name}`,
    body: `<div class="split"><div><form class="form" id="sf">${STYLE_FIELDS().map(f => field(f, s[f.key])).join('')}
      <div class="section-t">Sizes &amp; prices</div><div class="full" id="sizesBox">${sizesHTML()}</div>
      <div class="section-t">Standard options (already on the shed)</div><div class="full" id="stdBox">${stdHTML()}</div>
      <div class="section-t">Options offered on this style</div><div class="full" id="availBox">${availHTML()}</div>
      <div class="section-t">Default colors</div>${['siding', 'trim', 'roof', 'door', 'window'].map(colorSel).join('')}
      </form></div><div><div class="preview3d" id="pv"><div class="pv-note">Live preview</div></div></div></div>`,
    foot: `<span></span><div class="row"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="saveStyle">Save style</button></div>`,
    onMount: root => {
      modalScene = new ShedScene($('#pv', root));
      const collect = () => {
        const d = readFields($('#sf', root), STYLE_FIELDS());
        d.standard_options = stds.map(x => ({ option_id: Number(x.option_id), wall: x.wall, offset: Number(x.offset) || 0,
          ...(Number(x.w) > 0 ? { w: Number(x.w) } : {}), ...(Number(x.h) > 0 ? { h: Number(x.h) } : {}),
          ...(x.gable && gm(x.option_id) === 'allow' ? { gable: true } : {}) }));
        d.available_options = avail ? [...new Set(avail)] : null;
        d.default_colors = {}; for (const c of ['siding', 'trim', 'roof', 'door', 'window']) { const v = $(`[name=dc_${c}]`, root).value; if (v) d.default_colors[c] = Number(v); }
        return d;
      };
      const preview = () => {
        try {
          const d = collect();
          const sz = sizes[previewIdx] || sizes[0]; if (!sz || !sz.width || !sz.depth) return;
          const st = { ...d, id: -1, sizes: [{ ...sz, id: -1, width: Number(sz.width), depth: Number(sz.depth), price: Number(sz.price) || 0, hip_len: Number(sz.hip_len) || null, upper_len: Number(sz.upper_len) || null }] };
          const cat = { ...catalog, settings: { ...catalog.settings, roofing: roofing() }, styles: [st] };
          const cfg = defaultConfig(cat, -1, -1); cfg.roof_material = d.roof_material;
          modalScene.build(cat, cfg);
          // live readout of each roof section at the previewed size
          const secs = roofSections(shedGeometry(st, st.sizes[0]));
          const ftin = v => { const t = Math.round(v * 12 * 4) / 4, f = Math.floor(t / 12), i = t - f * 12; return `${f}' ${i}"`; };
          const names = secs.length === 4 ? ['Hip (lower)', 'Upper', 'Upper', 'Hip (lower)'] : secs.length === 2 ? (d.roof_type === 'saltbox' ? ['Long slope', 'Short slope'] : ['Each side', 'Each side']) : ['Roof'];
          const seen = new Set();
          $('#roofInfo', root).innerHTML = `<b>Roof sections at ${sz.width}' × ${sz.depth}'</b> (along the slope, without overhang): ` +
            secs.map((x, i) => ({ x, n: names[i] })).filter(r => !seen.has(r.n) && seen.add(r.n))
              .map(r => `<span>${r.n}: <b>${Math.round(r.x.pitch * 4) / 4}/12</b>, ${ftin(r.x.length)} long</span>`).join(' · ');
        } catch (e) { console.warn(e); }
      };
      let t; const later = () => { clearTimeout(t); t = setTimeout(preview, 200); };
      wireInputs(root, later);
      const redrawSizes = () => { $('#sizesBox', root).innerHTML = sizesHTML(); later(); };
      $('[name=roof_type]', root).addEventListener('change', () => redrawSizes());
      const redrawAvail = () => { $('#availBox', root).innerHTML = availHTML(); };
      const redrawStd = () => { $('#stdBox', root).innerHTML = stdHTML(); redrawAvail(); later(); };
      root.addEventListener('input', e => {
        const d = e.target.dataset;
        if (d.sz !== undefined) { sizes[d.sz][d.k] = d.k === 'active' ? (e.target.checked ? 1 : 0) : e.target.value; later(); }
        if (d.std !== undefined) { stds[d.std][d.k] = d.k === 'gable' ? e.target.checked : e.target.value; later(); }
        if (d.av !== undefined) {
          const ticked = $$('[data-av]', root).filter(x => x.checked && !x.disabled).map(x => Number(x.dataset.av));
          const free = catalog.options.filter(o => !stds.some(x => Number(x.option_id) === o.id)).map(o => o.id);
          avail = free.every(id => ticked.includes(id)) ? null : ticked;
          redrawAvail();
        }
      });
      root.addEventListener('change', e => { const d = e.target.dataset; if (d.std !== undefined) { stds[d.std][d.k] = d.k === 'gable' ? e.target.checked : e.target.value; if (d.k === 'option_id') redrawStd(); else later(); } if (d.sz !== undefined && d.k === 'active') sizes[d.sz].active = e.target.checked ? 1 : 0; });
      root.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.id === 'addSize') { const l = sizes.at(-1) || { width: 8, depth: 8, price: 0 }; sizes.push({ width: l.width, depth: Number(l.depth) + 2, price: l.price, active: 1 }); redrawSizes(); }
        if (b.dataset.rmsize !== undefined) { sizes.splice(Number(b.dataset.rmsize), 1); previewIdx = Math.min(previewIdx, sizes.length - 1); redrawSizes(); }
        if (b.dataset.pvsize !== undefined) { previewIdx = Number(b.dataset.pvsize); redrawSizes(); }
        if (b.id === 'fillP') { const p = Number($('#ppsf', root).value), base = Number($('#pbase', root).value) || 0; if (!p) return toast('Enter a $/sq ft'); sizes.forEach(z => (z.price = Math.round((z.width * z.depth * p + base) / 5) * 5)); redrawSizes(); }
        if (b.id === 'addStd') { stds.push({ option_id: catalog.options.find(o => o.placement === 'opening')?.id, wall: 'front', offset: 0 }); redrawStd(); }
        if (b.dataset.rmstd !== undefined) { stds.splice(Number(b.dataset.rmstd), 1); redrawStd(); }
        if (b.id === 'avAll') { avail = null; redrawAvail(); }
        if (b.id === 'avNone') { avail = []; redrawAvail(); }
        if (b.dataset.cancel !== undefined) closeModal();
      });
      $('#saveStyle', root).onclick = guard(async () => {
        const d = collect();
        if (!d.name) throw new Error('Name is required');
        const saved = isNew ? await api('POST', '/api/v1/styles', d) : await api('PATCH', `/api/v1/styles/${s.id}`, d);
        await api('PUT', `/api/admin/styles/${saved.id}/sizes`, sizes.map(z => ({ ...z, width: Number(z.width), depth: Number(z.depth), price: Number(z.price), hip_len: Number(z.hip_len) || null, upper_len: Number(z.upper_len) || null })));
        closeModal(); toast('Style saved'); styles();
      });
      preview();
    },
  });
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------
const COLOR_FIELDS = [
  { key: 'name', label: 'Color name', required: true },
  { key: 'category', label: 'Used for', type: 'select', options: [['siding', 'Siding'], ['trim', 'Trim'], ['roof', 'Roof'], ['door', 'Doors'], ['window', 'Windows']] },
  { key: 'hex', label: 'Color', type: 'color' },
  { key: 'material', label: 'Roof colors: offered for', type: 'select', options: () => [['', 'All roofing types'], ...roofing().map(r => [r.key, r.name + ' only'])], help: 'Only used for roof colors.' },
  { key: 'price', label: 'Upcharge ($)', type: 'number', step: '1', help: '0 = no extra charge' },
  { key: 'sort', label: 'Sort order', type: 'number' },
  { key: 'active', label: 'Available to customers', type: 'checkbox', default: 1 },
];
async function colors() {
  await loadCatalog();
  const groups = [['siding', 'Siding'], ['trim', 'Trim'], ['roof', 'Roof'], ['door', 'Doors'], ['window', 'Windows']];
  settings = await api('GET', '/api/admin/settings');
  const cg = settings.color_groups || {};
  const R = roofing();
  const unitTxt = { per_roof_sqft: '/ sq ft of roof', per_sqft: '/ sq ft of floor', each: 'flat' };
  $('#main').innerHTML = head('Roofing & colors', 'Tip: name a door or window color “Match Trim” and it automatically follows the trim color. Window colors set the window frame and grids; the trim around windows always matches the trim color. Untick “Customers can choose” to hide a color group from customers.', `<button class="btn primary" id="addColor">+ New color</button>`) + `
    <div class="card" style="margin-bottom:16px"><div class="card-pad" style="padding-bottom:4px"><h2>Roofing materials</h2><p class="muted" style="margin:0">Customers pick these on the “Roof &amp; Colors” step. Each style's <b>standard roofing</b> is included; others charge the difference. Which ones each style offers is set in Styles &amp; sizes.</p></div>
    <table class="tbl"><tr><th>Key</th><th>Name shown to customers</th><th>Description</th><th class="num">Price</th><th>Priced</th><th>Active</th></tr>
    ${R.map((r, i) => `<tr><td class="mono">${esc(r.key)}</td><td><input class="in" data-rf="${i}" data-k="name" value="${esc(r.name)}"></td><td><input class="in" data-rf="${i}" data-k="description" value="${esc(r.description || '')}"></td>
      <td class="num"><input class="in" type="number" step="0.01" data-rf="${i}" data-k="price" value="${r.price}" style="width:90px"></td>
      <td><select class="in" data-rf="${i}" data-k="price_unit">${Object.entries(unitTxt).map(([k, l]) => `<option value="${k}" ${k === r.price_unit ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-rf="${i}" data-k="active" ${r.active !== false && r.active !== 0 ? 'checked' : ''}></td></tr>`).join('')}</table>
    <div class="card-pad" style="padding-top:10px"><button class="btn primary sm" id="saveRoofing">Save roofing</button></div></div>` +
    groups.map(([k, l]) => `<div class="card" style="margin-bottom:16px"><div class="card-pad row" style="padding-bottom:4px;justify-content:space-between"><h2>${l}</h2>
      <label class="chk" title="When off, customers can't change this color and the style's default is used${k === 'door' || k === 'window' ? ' (Match Trim follows the trim color)' : ''}"><input type="checkbox" data-cg="${k}" ${cg[k] !== false ? 'checked' : ''}>Customers can choose</label></div><table class="tbl"><tr><th style="width:50px"></th><th>Name</th><th>Hex</th>${k === 'roof' ? '<th>Roofing</th>' : ''}<th class="num">Upcharge</th><th>Status</th><th></th></tr>
      ${catalog.colors.filter(c => c.category === k).map(c => `<tr><td><span class="sw" style="background:${esc(c.hex)}"></span></td><td><b>${esc(c.name)}</b></td>${k === 'roof' ? `<td>${esc(R.find(r => r.key === c.material)?.name || 'All')}</td>` : ''}<td class="mono">${esc(c.hex)}</td><td class="num">${c.price ? fmt(c.price) : '—'}</td><td><span class="pill ${c.active ? 'on' : 'off'}">${c.active ? 'Active' : 'Hidden'}</span></td>
      <td class="num"><button class="icon-btn" data-edit="${c.id}">${PENCIL}</button> <button class="icon-btn" data-del="${c.id}">${TRASH}</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">None yet</td></tr>'}</table></div>`).join('');
  $$('[data-cg]').forEach(el => el.onchange = guard(async () => {
    const next = { ...(settings.color_groups || {}), [el.dataset.cg]: el.checked };
    await api('PUT', '/api/admin/settings', { color_groups: next }); settings.color_groups = next;
    toast(`${groups.find(g => g[0] === el.dataset.cg)[1]} color choice turned ${el.checked ? 'on' : 'off'}`);
  }));
  $('#saveRoofing').onclick = guard(async () => {
    const out = R.map(r => ({ ...r }));
    $$('[data-rf]').forEach(el => { const r = out[el.dataset.rf]; const k = el.dataset.k; r[k] = el.type === 'checkbox' ? el.checked : (k === 'price' ? Number(el.value) || 0 : el.value); });
    await api('PUT', '/api/admin/settings', { roofing: out }); toast('Roofing saved'); colors();
  });
  $('#addColor').onclick = () => simpleEditor('Color', '/api/v1/colors', COLOR_FIELDS, null, colors, { hex: '#888888', category: 'siding', price: 0, active: 1 });
  $('#main').onclick = guard(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edit) simpleEditor('Color', '/api/v1/colors', COLOR_FIELDS, catalog.colors.find(c => c.id === Number(b.dataset.edit)), colors);
    if (b.dataset.del && confirmBox('Delete this color?')) { await api('DELETE', `/api/v1/colors/${b.dataset.del}`); colors(); }
  });
}
function simpleEditor(noun, base, fields, row, done, defaults = {}) {
  openModal({
    title: row ? `Edit ${noun.toLowerCase()}` : `New ${noun.toLowerCase()}`, narrow: true,
    body: `<form class="form" id="ef">${fields.map(f => field(f, row ? row[f.key] : defaults[f.key])).join('')}</form>`,
    foot: `<span></span><div class="row"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="esave">Save</button></div>`,
    onMount: root => {
      wireInputs(root);
      $('[data-cancel]', root).onclick = closeModal;
      $('#esave', root).onclick = guard(async () => {
        const d = readFields($('#ef', root), fields);
        row ? await api('PATCH', `${base}/${row.id}`, d) : await api('POST', base, d);
        closeModal(); toast(`${noun} saved`); done();
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
const OPTION_FIELDS = () => [
  { key: 'name', label: 'Option name', required: true, full: true },
  { key: 'description', label: 'Description (shown to customers)', type: 'textarea', full: true },
  { key: 'category', label: 'Category', type: 'select', options: CATEGORIES },
  { key: 'swap_group', label: 'Swap group', list: 'swapGroups', help: 'Options in the same group can be swapped for each other on the model (e.g. "door").' },
  { key: 'placement', label: 'Where it goes', type: 'select', options: PLACEMENTS, full: true },
  { type: 'section', label: '3D model' },
  { type: 'html', html: `<div class="full modelbox" id="modelBox"></div>` },
  { key: 'model_url', label: 'Your 3D model file (.glb)', type: 'upload', accept: '.glb,.gltf', full: true, help: 'Upload a .glb to replace the built-in model (drag a file onto this box or click Upload). Upload a new file any time to update it. It is stretched to the width × height × depth below.' },
  { key: 'kind', label: 'Built-in model (used when no file is uploaded)', type: 'select', options: Object.entries(BUILTIN_KINDS), full: true },
  { type: 'section', label: 'Size & position' },
  { key: 'width', label: 'Width (ft)', type: 'number', step: '0.05' },
  { key: 'height', label: 'Height (ft)', type: 'number', step: '0.05' },
  { key: 'depth', label: 'Depth (ft)', type: 'number', step: '0.05' },
  { key: 'elevation', label: 'Standard height — bottom above floor (ft)', type: 'number', step: '0.0208', help: 'Where it sits by default. Doors = 0. Windows: bottom of the window (top shown below). Use -1 to auto-place high in the gable (vents).' },
  { type: 'html', html: '<div class="full roofinfo" id="elevInfo"></div>' },
  { key: 'gable_mode', label: 'Can it go up in the gable?', type: 'select', full: true, options: [['', 'No — walls only'], ['allow', 'Yes — customer can put it on the wall or up in the gable'], ['only', 'Gable only (e.g. a gable/attic window)']], help: 'Windows & vents. In the gable it is centred between the top of the wall and the roof line, if it fits.' },
  { key: 'price', label: 'Price ($)', type: 'number', step: '0.01' },
  { key: 'price_unit', label: 'Priced', type: 'select', options: PRICE_UNITS },
  { key: 'max_qty', label: 'Max per shed', type: 'number' },
  { key: 'package_only', label: 'Only sold as part of a package (not listed on its own)', type: 'checkbox', full: true },
  { key: 'sort', label: 'Sort order', type: 'number' },
  { key: 'image_url', label: 'Thumbnail image (optional)', type: 'upload', accept: 'image/*' },
  { key: 'plan_label', label: 'Floor plan label (optional)' },
  { key: 'active', label: 'Available to customers', type: 'checkbox', default: 1 },
];
async function options() {
  await loadCatalog();
  const cat = new URLSearchParams(location.hash.split('?')[1] || '').get('cat') || '';
  const list = catalog.options.filter(o => !cat || o.category === cat);
  const unit = o => ({ per_sqft: '/sq ft', per_ft_wall: '/ft', per_ft_width: '/ft', per_ft_depth: '/ft', per_ft_perimeter: '/ft' }[o.price_unit] || '');
  $('#main').innerHTML = head('Options & 3D models', 'Doors, windows, shelves, wiring and upgrades. Each can use a built-in 3D model or your own .glb.', `<button class="btn primary" id="addOpt">+ New option</button>`) + `
    <div class="tabs">${[['', 'All'], ...CATEGORIES].map(([k, l]) => `<button data-cat="${k}" class="${k === cat ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="card tbl-wrap"><table class="tbl"><tr><th>Option</th><th>Category</th><th>Placement</th><th>3D model</th><th>Size (ft)</th><th class="num">Price</th><th>Status</th><th></th></tr>
    ${list.map(o => `<tr><td><b>${esc(o.name)}</b>${Array.isArray(o.package_items) && o.package_items.length ? ` <span class="pill on">Package · ${o.package_items.reduce((n, x) => n + (Number(x.qty) || 1), 0)} items</span>` : ''}${o.package_only ? ' <span class="pill off">package only</span>' : ''}${o.swap_group ? `<div class="muted" style="font-size:12px">swap group: ${esc(o.swap_group)}</div>` : ''}</td><td>${esc(o.category)}</td><td class="muted">${esc(o.placement)}</td>
      <td style="white-space:nowrap">${o.model_url ? `<span class="pill on" title="${esc(o.model_url.split('/').pop())}">Your file</span>` : `<span class="muted">Built-in: ${esc(BUILTIN_KINDS[o.kind] || o.kind)}</span>`}
        ${o.placement !== 'none' ? `<div class="row" style="gap:4px;margin-top:4px"><label class="btn ghost sm" title="Upload a .glb file for this option">${o.model_url ? 'Replace' : 'Upload'} .glb<input type="file" accept=".glb,.gltf" data-glb="${o.id}" hidden></label>
        <button class="btn link sm" data-dlmodel="${o.id}" title="Download the current model to edit">Download</button></div>` : ''}</td>
      <td class="muted">${o.placement === 'none' ? '—' : `${o.width ?? ''} × ${o.height ?? ''}`}</td><td class="num">${fmt(o.price)}${unit(o)}</td>
      <td><span class="pill ${o.active ? 'on' : 'off'}">${o.active ? 'Active' : 'Hidden'}</span></td>
      <td class="num" style="white-space:nowrap"><button class="icon-btn" data-edit="${o.id}">${PENCIL}</button> <button class="icon-btn" data-dup="${o.id}" title="Duplicate">${COPY}</button> <button class="icon-btn" data-del="${o.id}">${TRASH}</button></td></tr>`).join('')}</table></div>`;
  const wins = catalog.options.filter(o => o.placement === 'opening' && (o.category === 'windows' || String(o.kind || '').startsWith('window')));
  if ((!cat || cat === 'windows') && wins.length) {
    const inch = v => +(Number(v || 0) * 12).toFixed(2);
    $('#main').insertAdjacentHTML('beforeend', `<div class="card" style="margin-top:16px"><div class="card-pad" style="padding-bottom:4px"><h2>Standard window heights</h2>
      <p class="muted" style="margin:0">Set where each window type sits by default, in inches above the floor — enter the bottom or the top, the other follows. Customers can still move windows sideways; the height stays at this standard.</p></div>
      <table class="tbl" id="winH"><tr><th>Window</th><th>Size</th><th>Bottom (in)</th><th>Top (in)</th><th>In the gable</th></tr>
      ${wins.map(o => `<tr data-wid="${o.id}" data-h="${o.height}"><td><b>${esc(o.name)}</b></td><td class="muted">${ftIn(o.width)} × ${ftIn(o.height)}</td>
        ${o.gable_mode === 'only' ? `<td colspan="2" class="muted">Auto — centred in the gable<input type="hidden" data-wb value="${inch(o.elevation)}"></td>` : `<td><input class="in" type="number" step="0.25" data-wb value="${inch(o.elevation)}" style="width:90px"></td>
        <td><input class="in" type="number" step="0.25" data-wt value="${inch(Number(o.elevation) + Number(o.height))}" style="width:90px"></td>`}
        <td><select class="in" data-wg>${[['', 'No'], ['allow', 'Customer can choose'], ['only', 'Gable only']].map(([k, l]) => `<option value="${k}" ${(o.gable_mode || '') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>`).join('')}</table>
      <div class="card-pad" style="padding-top:10px"><button class="btn primary sm" id="saveWinH">Save window heights</button></div></div>`);
    $('#winH').addEventListener('input', e => {
      const tr = e.target.closest('tr'); const h = Number(tr.dataset.h) * 12;
      if (e.target.matches('[data-wb]') && $('[data-wt]', tr)) $('[data-wt]', tr).value = +(Number(e.target.value) + h).toFixed(2);
      if (e.target.matches('[data-wt]')) $('[data-wb]', tr).value = +(Number(e.target.value) - h).toFixed(2);
    });
    $('#saveWinH').onclick = guard(async () => {
      for (const tr of $$('#winH tr[data-wid]')) {
        const o = catalog.options.find(x => x.id === Number(tr.dataset.wid));
        const elevation = +(Number($('[data-wb]', tr).value) / 12).toFixed(4), gable_mode = $('[data-wg]', tr).value;
        if (Math.abs(elevation - Number(o.elevation)) > 1e-4 || gable_mode !== (o.gable_mode || '')) await api('PATCH', `/api/v1/options/${o.id}`, { elevation, gable_mode });
      }
      toast('Window heights saved'); options();
    });
  }
  $('#main').addEventListener('change', guard(async e => {
    const id = e.target.dataset.glb; if (!id || !e.target.files[0]) return;
    const fd = new FormData(); fd.append('file', e.target.files[0]);
    toast('Uploading ' + e.target.files[0].name + '…');
    const r = await api('POST', '/api/admin/upload', fd);
    await api('PATCH', `/api/v1/options/${id}`, { model_url: r.url });
    toast('3D model updated — customers see it right away'); options();
  }));
  $('#addOpt').onclick = () => optionEditor(null);
  $('#main').onclick = guard(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.cat !== undefined) { location.hash = '#/options' + (b.dataset.cat ? '?cat=' + b.dataset.cat : ''); return; }
    if (b.dataset.edit) optionEditor(catalog.options.find(o => o.id === Number(b.dataset.edit)));
    if (b.dataset.dlmodel) await downloadModel(catalog.options.find(o => o.id === Number(b.dataset.dlmodel)));
    if (b.dataset.dup) { await api('POST', `/api/admin/duplicate/options/${b.dataset.dup}`); toast('Duplicated'); options(); }
    if (b.dataset.del && confirmBox('Delete this option? It will also disappear from styles that include it as standard.')) { await api('DELETE', `/api/v1/options/${b.dataset.del}`); options(); }
  });
}
async function downloadModel(o) {
  const base = (o.name || 'option').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  if (o.model_url) { const r = await fetch(o.model_url); if (!r.ok) throw new Error('Could not load the model file'); return saveFile(await r.blob(), `${base}.glb`); }
  const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:-3000px;width:10px;height:10px';
  document.body.appendChild(holder); const sc = new ShedScene(holder);
  try { saveFile(await sc.exportOptionGLB(o), `${base}-builtin.glb`); toast('Downloaded — edit it, then upload it back'); }
  finally { sc.dispose(); holder.remove(); }
}
function optionEditor(row) {
  const fields = OPTION_FIELDS();
  const o = row || { category: 'doors', placement: 'opening', kind: 'door_single', width: 3, height: 6.67, depth: 0.3, elevation: 0, price: 0, price_unit: 'each', max_qty: 10, active: 1, swap_group: 'door' };
  const groups = [...new Set(catalog.options.map(x => x.swap_group).filter(Boolean))];
  openModal({
    title: row ? `Edit ${o.name}` : 'New option',
    body: `<datalist id="swapGroups">${groups.map(g => `<option value="${esc(g)}">`).join('')}</datalist>
      <div class="split"><form class="form" id="of">${fields.map(f => field(f, o[f.key])).join('')}
        <div class="section-t">Offered on these styles</div>
        <div class="full row" style="gap:6px 16px" id="optStyles">${catalog.styles.map(st => {
          const std = row && (st.standard_options || []).some(x => Number(x.option_id) === row.id);
          const on = !row ? !Array.isArray(st.available_options) : (std || !Array.isArray(st.available_options) || st.available_options.map(Number).includes(row.id));
          return `<label class="chk"><input type="checkbox" data-ost="${st.id}" ${on ? 'checked' : ''} ${std ? 'disabled title="Standard on this style"' : ''}>${esc(st.name)}${std ? ' <span class="muted">(standard)</span>' : ''}</label>`;
        }).join('')}</div>
        <div class="full muted" style="font-size:12px">Untick a style to hide this option there. Same setting as “Options offered on this style” in the style editor.</div>
        <div class="section-t">What's in this package <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">(optional — e.g. an electrical package)</span></div>
        <div class="full" id="pkgBox"></div></form>
      <div><div class="preview3d" id="pv"><div class="pv-note">3D preview</div></div>
      <div class="callout" style="margin-top:12px">Tip: For your own models, export a <b>.glb</b> with the front facing <b>+Z</b> and Y up. It will be stretched to the width × height × depth you enter, so match those to the real product.</div></div></div>`,
    foot: `<span></span><div class="row"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="osave">Save option</button></div>`,
    onMount: root => {
      modalScene = new ShedScene($('#pv', root));
      // ---- package contents
      let pk = (Array.isArray(o.package_items) ? o.package_items : []).map(x => ({ ...x }));
      const partOpts = () => catalog.options.filter(x => x.id !== (row?.id) && !(Array.isArray(x.package_items) && x.package_items.length) && x.placement !== 'none');
      const WALL_CH = [['auto', 'Auto'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['ceiling', 'Ceiling']];
      const pkgHTML = () => !pk.length ? `<p class="muted" style="margin:0 0 8px">Not a package. Add items to make this option a package — when a customer adds it, every item below is placed on their shed automatically and included in this option's price.</p><button type="button" class="btn ghost sm" id="pkAdd">+ Add item to package</button>` :
        `<div style="overflow-x:auto"><table class="mini"><tr><th>Item</th><th>Qty</th><th>Goes on</th><th title="Feet from the centre of the wall, as seen from outside (+ = right). Blank = we pick a free spot.">Position (ft)</th><th title="Height off the floor in feet. Blank = the item's standard height.">Height (ft)</th><th></th></tr>
        ${pk.map((x, i) => { const io = catalog.options.find(q => q.id === Number(x.option_id)) || {};
          return `<tr><td><select data-pk="${i}" data-k="option_id" style="min-width:150px;max-width:210px">${partOpts().map(q => `<option value="${q.id}" ${q.id === Number(x.option_id) ? 'selected' : ''}>${esc(q.name)}${q.package_only ? ' (package only)' : ''}</option>`).join('')}</select></td>
          <td><input type="number" min="1" max="20" step="1" data-pk="${i}" data-k="qty" value="${x.qty ?? 1}" style="width:64px"></td>
          <td><select data-pk="${i}" data-k="wall" style="min-width:96px">${WALL_CH.filter(([k]) => io.placement === 'ceiling' ? ['ceiling'].includes(k) : k !== 'ceiling').map(([k, l]) => `<option value="${k}" ${(x.wall || 'auto') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td><input type="number" step="0.25" data-pk="${i}" data-k="offset" value="${x.offset ?? ''}" placeholder="auto" style="width:80px"></td>
          <td>${io.placement === 'ceiling' ? '<span class="muted">ceiling</span>' : `<input type="number" step="0.25" data-pk="${i}" data-k="elev" value="${x.elev ?? ''}" placeholder="${io.elevation ?? ''}" style="width:80px">`}</td>
          <td><button type="button" class="icon-btn" data-pkrm="${i}">${TRASH}</button></td></tr>`; }).join('')}</table></div>
        <div class="row" style="margin-top:8px;gap:10px;flex-wrap:wrap"><button type="button" class="btn ghost sm" id="pkAdd">+ Add item</button>
        <span class="muted" style="font-size:12px">Position = feet from the centre of the wall seen from outside (+ = right). If a spot is taken or the shed is too small, the item goes to the nearest free spot. Customers can move package items but can't remove them on their own.</span></div>`;
      const redrawPk = () => { $('#pkgBox', root).innerHTML = pkgHTML(); };
      redrawPk();
      root.addEventListener('input', e => { const dd = e.target.dataset; if (dd.pk !== undefined) pk[dd.pk][dd.k] = e.target.value; });
      root.addEventListener('change', e => { const dd = e.target.dataset; if (dd.pk !== undefined) { pk[dd.pk][dd.k] = e.target.value; if (dd.k === 'option_id') { const io = catalog.options.find(q => q.id === Number(e.target.value)); pk[dd.pk].wall = io?.placement === 'ceiling' ? 'ceiling' : 'auto'; redrawPk(); } } });
      root.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.id === 'pkAdd') { const first = partOpts().find(q => q.category === (readFields($('#of', root), fields).category)) || partOpts()[0]; if (first) pk.push({ option_id: first.id, qty: 1, wall: first.placement === 'ceiling' ? 'ceiling' : 'auto', offset: '', elev: '' }); redrawPk(); }
        if (b.dataset.pkrm !== undefined) { pk.splice(Number(b.dataset.pkrm), 1); redrawPk(); }
      });
      const pkOut = () => pk.filter(x => Number(x.option_id)).map(x => ({ option_id: Number(x.option_id), qty: Math.max(1, Math.min(20, Number(x.qty) || 1)), wall: x.wall || 'auto',
        offset: x.offset === '' || x.offset == null ? null : Number(x.offset), ...(x.elev === '' || x.elev == null ? {} : { elev: Number(x.elev) }) }));
      const modelBox = () => {
        const d = readFields($('#of', root), fields);
        $('#modelBox', root).innerHTML = d.placement === 'none' ? '<span class="muted">No 3D model — this option is a line item only.</span>' :
          `<div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap"><div><b>${d.model_url ? 'Using your file' : 'Using the built-in model'}</b>
            <div class="muted" style="font-size:12.5px">${d.model_url ? esc(d.model_url.split('/').pop()) : esc(BUILTIN_KINDS[d.kind] || d.kind || '')}</div></div>
            <div class="row" style="gap:6px"><button type="button" class="btn ghost sm" id="dlModel">Download current model</button>${d.model_url ? '<button type="button" class="btn link sm" id="useBuiltin">Use built-in instead</button>' : ''}</div></div>
          <ol class="muted steps-ol"><li>Download the current model (or start from your own).</li><li>Edit it in Blender, SketchUp, etc. Front facing <b>+Z</b>, <b>Y</b> up, sitting on the ground.</li><li>Export as <b>.glb</b> and upload it below. It replaces the model everywhere right away.</li></ol>`;
        $('#dlModel', root) && ($('#dlModel', root).onclick = guard(async () => downloadModel({ ...(row || {}), ...readFields($('#of', root), fields) })));
        $('#useBuiltin', root) && ($('#useBuiltin', root).onclick = () => { $('[name=model_url]', root).value = ''; $('[data-fn=model_url]', root).textContent = 'None'; preview(); });
      };
      const preview = () => {
        try {
          modelBox();
          const d = readFields($('#of', root), fields); modalScene.previewOption(d);
          const el = $('#elevInfo', root);
          if (el) el.innerHTML = d.placement === 'opening' && Number(d.elevation) >= 0
            ? `Bottom <b>${ftIn(d.elevation)}</b> above the floor · top <b>${ftIn(Number(d.elevation) + Number(d.height || 0))}</b>${String(d.kind || '').startsWith('door') ? '' : ` · head trim top <b>${ftIn(Number(d.elevation) + Number(d.height || 0) + 4 / 12)}</b> (4" trim)`}` : '';
        } catch (e) { console.warn(e); }
      };
      let t; wireInputs(root, () => { clearTimeout(t); t = setTimeout(preview, 200); });
      $('[data-cancel]', root).onclick = closeModal;
      $('#osave', root).onclick = guard(async () => {
        const d = readFields($('#of', root), fields);
        if (!d.name) throw new Error('Name is required');
        d.package_items = pkOut();
        const saved = row ? await api('PATCH', `/api/v1/options/${row.id}`, d) : await api('POST', '/api/v1/options', d);
        const id = Number(saved?.id ?? row?.id);
        // per-style availability
        for (const el of $$('[data-ost]', root)) {
          if (el.disabled) continue;
          const st = catalog.styles.find(x => x.id === Number(el.dataset.ost)); if (!st) continue;
          const list = Array.isArray(st.available_options) ? st.available_options.map(Number) : null;
          const has = !list || list.includes(id);
          if (el.checked === has) continue;
          let next;
          if (el.checked) next = [...list, id];
          else next = (list || catalog.options.map(o => o.id).concat(row ? [] : [id])).filter(x => x !== id);
          const allIds = catalog.options.map(o => o.id).concat(row ? [] : [id]);
          if (allIds.every(x => next.includes(x))) next = null; // everything offered again
          await api('PATCH', `/api/v1/styles/${st.id}`, { available_options: next });
        }
        closeModal(); toast('Option saved'); options();
      });
      preview();
    },
  });
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
const GHL_FIELDS = [
  { type: 'section', label: 'Option A — Native API (creates contact, opportunity and note)' },
  { key: 'ghl_enabled', label: 'Send every new quote to GoHighLevel', type: 'checkbox', full: true },
  { key: 'ghl_token', label: 'Private Integration token', full: true, help: 'GHL → Settings → Private Integrations → Create. Scopes: contacts.write, opportunities.write.' },
  { key: 'ghl_location_id', label: 'Location (sub-account) ID', help: 'GHL → Settings → Business Profile.' },
  { key: 'ghl_tags', label: 'Tags', help: 'Comma separated.' },
  { key: 'ghl_pipeline_id', label: 'Pipeline ID (optional)', help: 'Leave blank to skip creating an opportunity.' },
  { key: 'ghl_stage_id', label: 'Pipeline stage ID (optional)' },
  { key: 'ghl_source', label: 'Contact source' },
  { key: 'ghl_add_note', label: 'Add the full quote as a contact note', type: 'checkbox' },
  { key: 'ghl_custom_fields', label: 'Custom field mapping (optional)', type: 'json', full: true, empty: {},
    help: 'Map GHL custom field keys to quote values, e.g. <code>{"shed_style": "shed.style", "shed_size": "shed.size", "quote_total": "pricing.total", "shed_3d_link": "links.view_3d"}</code>' },
  { type: 'section', label: 'Option B — Workflow “Inbound Webhook” trigger (no token needed)' },
  { key: 'ghl_inbound_webhook_url', label: 'Inbound webhook URL', full: true, ph: 'https://services.leadconnectorhq.com/hooks/…', help: 'In GHL: Automation → Workflows → Add trigger “Inbound Webhook” → copy the URL here. Flat fields like first_name, email, phone, shed_style, quote_total, shed_3d_link are included for easy mapping.' },
  { key: 'ghl_send_updates', label: 'Also send status changes to the inbound webhook', type: 'checkbox', full: true },
];
async function integrations(tab = 'ghl') {
  const tabs = [['ghl', 'GoHighLevel'], ['webhooks', 'Webhooks'], ['api', 'API keys'], ['embed', 'Embed / links'], ['log', 'Delivery log']];
  $('#main').innerHTML = head('Integrations & API', 'Send quotes to GoHighLevel, Zapier, Make, n8n or any software with webhooks and a REST API.', `<a class="btn ghost" href="/docs" target="_blank">API docs ↗</a>`) +
    `<div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="tabBody"></div>`;
  $('.tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) location.hash = '#/integrations/' + b.dataset.tab; };
  const body = $('#tabBody');
  const origin = settings.public_url || location.origin;

  if (tab === 'ghl') {
    settings = await api('GET', '/api/admin/settings');
    body.innerHTML = `<div class="card card-pad"><div class="callout" style="margin-bottom:16px">Use <b>either</b> option (or both). Option A pushes contacts &amp; opportunities directly. Option B triggers a GHL workflow where you can map fields, send texts/emails, assign users, etc.</div>
      <form class="form" id="gf">${GHL_FIELDS.map(f => field(f, settings[f.key])).join('')}</form>
      <div class="row" style="margin-top:18px"><button class="btn primary" id="gsave">Save</button><button class="btn ghost" id="gtest">Send latest quote to GHL now</button></div></div>`;
    wireInputs(body);
    $('#gsave').onclick = guard(async () => { await api('PUT', '/api/admin/settings', readFields($('#gf'), GHL_FIELDS)); toast('GoHighLevel settings saved'); settings = await api('GET', '/api/admin/settings'); });
    $('#gtest').onclick = guard(async () => { await api('PUT', '/api/admin/settings', readFields($('#gf'), GHL_FIELDS)); const r = await api('POST', '/api/admin/ghl/test'); toast('Sent! Contact ' + r.contactId); });
  }

  if (tab === 'webhooks') {
    const hooks = await api('GET', '/api/v1/webhooks');
    body.innerHTML = `<div class="row" style="margin-bottom:12px"><button class="btn primary" id="addHook">+ Add webhook</button><span class="muted">Works with Zapier “Catch Hook”, Make “Custom webhook”, n8n, or your own server.</span></div>
      <div class="card tbl-wrap">${hooks.length ? `<table class="tbl"><tr><th>Name</th><th>URL</th><th>Events</th><th>Signed</th><th>Status</th><th></th></tr>${hooks.map(h => `<tr><td><b>${esc(h.name || 'Webhook')}</b></td><td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis">${esc(h.url)}</td><td>${(h.events || []).map(e => `<span class="pill">${esc(e)}</span>`).join(' ')}</td><td>${h.secret ? 'Yes' : 'No'}</td><td><span class="pill ${h.active ? 'on' : 'off'}">${h.active ? 'Active' : 'Paused'}</span></td>
        <td class="num" style="white-space:nowrap"><button class="btn ghost sm" data-test="${h.id}">Send test</button> <button class="icon-btn" data-edit="${h.id}">${PENCIL}</button> <button class="icon-btn" data-del="${h.id}">${TRASH}</button></td></tr>`).join('')}</table>` : '<div class="empty">No webhooks yet.</div>'}</div>
      <div class="card card-pad" style="margin-top:16px"><h2>Payload</h2><p class="muted">Each delivery is a JSON POST. Verify the signature with HMAC-SHA256 of the raw body using your secret.</p>
      <pre class="snip">POST {your url}
X-ShedBuilder-Event: quote.created
X-ShedBuilder-Signature: sha256=…

{ "event": "quote.created", "delivery_id": "…", "sent_at": "…",
  "data": { "id": 12, "number": "Q-10012", "status": "new",
    "customer": { "first_name", "last_name", "full_name", "email", "phone", "address", "city", "state", "zip", "notes", "sms_consent" },
    "shed": { "style", "size", "width_ft", "depth_ft", "sq_ft", "colors": { "siding", "trim", "roof", "door" } },
    "options": [ { "name", "category", "wall", "price" } ],
    "pricing": { "subtotal", "delivery", "tax", "total" },
    "summary": "Lofted Barn 12' x 16' | … | Total: $9,450.00",
    "links": { "view_3d", "download_3d_model", "floor_plan_svg", "admin" },
    "config": { …exact configuration… } } }</pre></div>`;
    const events = await api('GET', '/api/admin/events');
    const hookEditor = h => {
      const evs = new Set(h?.events || ['quote.created']);
      openModal({
        title: h ? 'Edit webhook' : 'New webhook', narrow: true,
        body: `<form class="form" id="hf">
          <label class="fld full"><span>Name</span><input name="name" value="${esc(h?.name || '')}" placeholder="e.g. Zapier → Google Sheets"></label>
          <label class="fld full"><span>URL</span><input name="url" value="${esc(h?.url || '')}" placeholder="https://hooks.zapier.com/…" required></label>
          <div class="fld full"><span>Events</span><div class="row">${[...events, '*'].map(e => `<label class="chk"><input type="checkbox" value="${e}" data-ev ${evs.has(e) ? 'checked' : ''}>${e === '*' ? 'All events' : e}</label>`).join('')}</div></div>
          <label class="fld full"><span>Signing secret (optional)</span><div class="row"><input name="secret" class="in" value="${esc(h?.secret || '')}" style="flex:1"><button type="button" class="btn ghost sm" id="gen">Generate</button></div></label>
          <label class="fld full"><span>Extra headers (JSON, optional)</span><textarea class="code" name="headers">${esc(JSON.stringify(h?.headers || {}, null, 2))}</textarea><small>e.g. <code>{"Authorization": "Bearer abc"}</code></small></label>
          <label class="chk full"><input type="checkbox" name="active" ${!h || h.active ? 'checked' : ''}>Active</label></form>`,
        foot: `<span></span><div class="row"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="hsave">Save</button></div>`,
        onMount: root => {
          $('[data-cancel]', root).onclick = closeModal;
          $('#gen', root).onclick = () => { $('[name=secret]', root).value = 'whsec_' + crypto.getRandomValues(new Uint8Array(18)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''); };
          $('#hsave', root).onclick = guard(async () => {
            let headers; try { headers = JSON.parse($('[name=headers]', root).value || '{}'); } catch { throw new Error('Headers must be valid JSON'); }
            const d = { name: $('[name=name]', root).value, url: $('[name=url]', root).value.trim(), secret: $('[name=secret]', root).value, headers, active: $('[name=active]', root).checked ? 1 : 0, events: $$('[data-ev]:checked', root).map(x => x.value) };
            h ? await api('PATCH', `/api/v1/webhooks/${h.id}`, d) : await api('POST', '/api/v1/webhooks', d);
            closeModal(); toast('Webhook saved'); integrations('webhooks');
          });
        },
      });
    };
    $('#addHook').onclick = () => hookEditor(null);
    body.onclick = guard(async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.edit) hookEditor(hooks.find(h => h.id === Number(b.dataset.edit)));
      if (b.dataset.del && confirmBox('Delete this webhook?')) { await api('DELETE', `/api/v1/webhooks/${b.dataset.del}`); integrations('webhooks'); }
      if (b.dataset.test) { b.disabled = true; const r = await api('POST', `/api/v1/webhooks/${b.dataset.test}/test`); b.disabled = false; toast(r.ok ? `Delivered (HTTP ${r.status})` : `Failed: HTTP ${r.status} ${r.response || ''}`, !r.ok); }
    });
  }

  if (tab === 'api') {
    const keys = await api('GET', '/api/admin/api-keys');
    body.innerHTML = `<div class="row" style="margin-bottom:12px"><input class="in" id="kname" placeholder="Key name, e.g. Zapier" style="max-width:260px"><button class="btn primary" id="newKey">Create API key</button></div>
      <div id="newKeyBox"></div>
      <div class="card tbl-wrap">${keys.length ? `<table class="tbl"><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr>${keys.map(k => `<tr><td><b>${esc(k.name)}</b></td><td class="mono">${esc(k.prefix)}…</td><td class="muted">${fmtDate(k.created_at)}</td><td class="muted">${k.last_used ? fmtDate(k.last_used) : 'Never'}</td><td class="num"><button class="icon-btn" data-del="${k.id}">${TRASH}</button></td></tr>`).join('')}</table>` : '<div class="empty">No API keys yet.</div>'}</div>
      <div class="card card-pad" style="margin-top:16px"><h2>Quick start</h2><p class="muted">Full reference with “Try it” buttons: <a href="/docs" target="_blank">${esc(origin)}/docs</a> · OpenAPI spec: <a href="/api/openapi.json" target="_blank">/api/openapi.json</a></p>
<pre class="snip"># List recent quotes
curl ${esc(origin)}/api/v1/quotes?since=2026-01-01 -H "X-API-Key: sb_live_…"

# Mark a quote as won
curl -X PATCH ${esc(origin)}/api/v1/quotes/12 -H "X-API-Key: sb_live_…" -H "Content-Type: application/json" -d '{"status":"won"}'

# Subscribe a webhook (REST hooks — Zapier/Make/n8n)
curl -X POST ${esc(origin)}/api/v1/webhooks -H "X-API-Key: sb_live_…" -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/hook","events":["quote.created"]}'

# Public (no key): catalog, live pricing and quote submission for custom front-ends
curl ${esc(origin)}/api/v1/catalog</pre></div>`;
    $('#newKey').onclick = guard(async () => {
      const r = await api('POST', '/api/admin/api-keys', { name: $('#kname').value || 'API key' });
      $('#newKeyBox').innerHTML = `<div class="callout warn" style="margin-bottom:14px"><b>Copy this key now — it won't be shown again.</b><pre class="snip" id="kval">${esc(r.key)}</pre><button class="btn ghost sm" id="kcopy" style="margin-top:8px">Copy</button> <button class="btn ghost sm" onclick="location.reload()">Done</button></div>`;
      $('#kcopy').onclick = () => { navigator.clipboard.writeText(r.key); toast('Copied'); };
    });
    body.onclick = guard(async e => { const b = e.target.closest('[data-del]'); if (b && confirmBox('Revoke this key? Anything using it will stop working.')) { await api('DELETE', `/api/admin/api-keys/${b.dataset.del}`); integrations('api'); } });
  }

  if (tab === 'embed') {
    await loadCatalog();
    const iframe = `<iframe src="${origin}/?embed=1" style="width:100%;height:860px;border:0;border-radius:12px" allow="fullscreen" title="3D Shed Builder"></iframe>`;
    const listener = `<script>
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'shedbuilder:quote') {
    // e.data.quote has number, customer, pricing, links …
    // e.g. fire a pixel, then send them to your thank-you page:
    // window.location.href = '/thank-you?quote=' + e.data.quote.number;
  }
});
<\/script>`;
    body.innerHTML = `<div class="grid g2"><div class="card card-pad"><h2>Embed in a GHL funnel or any website</h2><p class="muted">In GHL: Sites → Funnels/Websites → add a <b>Custom JS/HTML</b> element and paste:</p><pre class="snip">${esc(iframe)}</pre><button class="btn ghost sm" data-copy="${esc(iframe)}">Copy</button>
      <p class="muted" style="margin-top:16px">UTM parameters on the parent page aren't visible inside the iframe — add them to the src (e.g. <code>?embed=1&amp;utm_source=facebook</code>) and they're saved with the quote.</p>
      <p class="muted">Optional: react to submissions on the parent page:</p><pre class="snip">${esc(listener)}</pre></div>
      <div class="card card-pad"><h2>Direct links</h2><p class="muted">Link straight to a style (skips step 1) — great for ads and buttons.</p>
      <table class="tbl"><tr><th>Style</th><th>Link</th></tr><tr><td>Start page</td><td class="mono">${esc(origin)}/</td></tr>${catalog.styles.map(s => `<tr><td>${esc(s.name)}</td><td class="mono">${esc(origin)}/?style=${s.id}</td></tr>`).join('')}</table>
      <p class="muted" style="margin-top:14px">Set a <b>Thank-you page URL</b> in Settings to redirect after a quote is submitted.</p></div></div>`;
    body.onclick = e => { const b = e.target.closest('[data-copy]'); if (b) { navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } };
  }

  if (tab === 'log') {
    const log = await api('GET', '/api/admin/webhook-log');
    body.innerHTML = `<div class="card tbl-wrap">${log.length ? `<table class="tbl"><tr><th>Time</th><th>Target</th><th>Event</th><th>Result</th><th>Response</th></tr>${log.map(l => `<tr><td class="muted" style="white-space:nowrap">${fmtDate(l.created_at)}</td><td class="mono" style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${esc(l.target)}</td><td>${esc(l.event)}</td><td><span class="pill ${l.ok ? 'won' : 'lost'}">${l.status || 'ERR'}${l.attempt > 1 ? ' · try ' + l.attempt : ''}</span></td><td class="mono muted" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.response)}">${esc(l.response)}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing sent yet.</div>'}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const SETTINGS_FIELDS = [
  { type: 'section', label: 'Branding' },
  { key: 'company_name', label: 'Company name' }, { key: 'headline', label: 'Configurator headline' },
  { key: 'logo_url', label: 'Logo', type: 'upload', accept: 'image/*' }, { key: 'brand_color', label: 'Brand color', type: 'color' },
  { key: 'phone', label: 'Phone (shown in header)' }, { key: 'website', label: 'Website' },
  { type: 'section', label: 'Pricing' },
  { key: 'show_prices', label: 'Show prices to customers (customer-facing configurator)', type: 'checkbox', full: true, help: 'Off = customers see no prices anywhere: no totals, no option prices, and their PDF has no prices. Prices are not sent to their browser at all. The dealer-facing configurator, opened while signed in here (Open configurator), always shows prices.' }, { key: 'currency_symbol', label: 'Currency symbol' },
  { key: 'delivery_fee', label: 'Delivery fee ($)', type: 'number', step: '0.01' }, { key: 'tax_rate', label: 'Sales tax (%)', type: 'number', step: '0.001' },
  { key: 'tax_delivery', label: 'Charge tax on delivery', type: 'checkbox' },
  { key: 'downgrade_credit', label: 'Lower the price when a customer swaps a standard item (door, window, roofing) for a cheaper one', type: 'checkbox', full: true },
  { key: 'remove_credit', label: 'Credit the price of a standard item when the customer removes it', type: 'checkbox', full: true },
  { type: 'section', label: 'Quote form' },
  { key: 'require_phone', label: 'Phone number is required', type: 'checkbox' },
  { key: 'consent_text', label: 'SMS / call consent text (A2P)', type: 'textarea', full: true, help: 'Leave blank to hide the checkbox.' },
  { key: 'privacy_url', label: 'Privacy policy URL' }, { key: 'thank_you_url', label: 'Thank-you page URL (optional redirect)' },
  { key: 'success_message', label: 'Success message', type: 'textarea', full: true },
  { key: 'customer_pdf', label: 'Let customers download their quote PDF (prices + drawings) after submitting', type: 'checkbox', full: true },
  { key: 'quote_terms', label: 'Terms printed on the quote PDF', type: 'textarea', full: true, ph: 'e.g. Prices valid for 30 days. Delivery subject to site access. A 10% deposit is required to order.' },
  { type: 'section', label: 'Advanced' },
  { key: 'public_url', label: 'Public URL of this app', full: true, ph: 'https://builder.yourdomain.com', help: 'Used for links in webhooks/GHL. Leave blank to auto-detect.' },
];
async function settingsPage() {
  settings = await api('GET', '/api/admin/settings');
  $('#main').innerHTML = head('Settings', 'Branding, pricing rules and the quote form.') + `<div class="card card-pad"><form class="form" id="setf">${SETTINGS_FIELDS.map(f => field(f, settings[f.key])).join('')}</form>
    <div class="row" style="margin-top:18px"><button class="btn primary" id="ssave">Save settings</button></div></div>`;
  wireInputs($('#main'));
  $('#ssave').onclick = guard(async () => {
    await api('PUT', '/api/admin/settings', readFields($('#setf'), SETTINGS_FIELDS));
    settings = await api('GET', '/api/admin/settings');
    $('#sideName').textContent = settings.company_name || 'Shed Builder';
    if (settings.brand_color) document.documentElement.style.setProperty('--brand', settings.brand_color);
    toast('Settings saved');
  });
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
async function account() {
  const yours = `<div class="card card-pad"><h2>Your login</h2><p class="muted" style="margin:2px 0 0">Role: <b>${ROLE_LABEL[me.role || 'admin']}</b>${me.dealer_id ? ` · ${esc((settings.dealers || []).find(d => String(d.id) === String(me.dealer_id))?.name || me.dealer_id)}` : ''}</p><form class="form" id="af" style="margin-top:12px">
      <label class="fld"><span>Name</span><input name="name" value="${esc(me.name || '')}"></label>
      <label class="fld"><span>Email</span><input name="email" type="email" value="${esc(me.email)}"></label>
      <label class="fld"><span>Current password *</span><input name="current_password" type="password" autocomplete="current-password"></label>
      <label class="fld"><span>New password</span><input name="new_password" type="password" autocomplete="new-password" placeholder="8+ characters"></label></form>
      <button class="btn primary" id="asave" style="margin-top:14px">Update</button>
      <div class="section-t" style="margin:22px 0 10px">My alerts</div>
      <p class="muted" style="margin:0 0 10px">Get a text and/or email when a contract is signed, a new lead comes in or a customer replies (whichever your admin has switched on in Messaging &amp; alerts).</p>
      <form class="form" id="nf"><label class="fld"><span>My mobile number</span><input name="phone" type="tel" value="${esc(me.phone || '')}" placeholder="(555) 555-5555"></label><div></div>
        <label class="chk"><input type="checkbox" name="notify_sms" ${me.notify_sms ? 'checked' : ''}>Text me</label><label class="chk"><input type="checkbox" name="notify_email" ${me.notify_email ? 'checked' : ''}>Email me</label></form>
      <button class="btn ghost" id="nsave" style="margin-top:12px">Save alerts</button></div>`;
  const saveAlerts = guard(async () => { const f = $('#nf'); await api('POST', '/api/admin/account', { phone: f.phone.value, notify_sms: f.notify_sms.checked, notify_email: f.notify_email.checked }); me = await api('GET', '/api/auth/me'); toast('Alerts saved'); });
  if (!isAdmin()) {
    $('#main').innerHTML = head('Your account') + `<div class="grid g2">${yours}</div>`;
    $('#asave').onclick = guard(async () => { const d = Object.fromEntries(new FormData($('#af'))); await api('POST', '/api/admin/account', d); me = await api('GET', '/api/auth/me'); toast('Account updated'); account(); });
    $('#nsave').onclick = saveAlerts;
    return;
  }
  const users = await api('GET', '/api/admin/users');
  const dealers = settings.dealers || [];
  const roleSel = (v, attrs) => `<select class="in" ${attrs}>${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const lotSel = (v, attrs) => `<select class="in" ${attrs}><option value="">All dealer lots</option>${dealers.map(d => `<option value="${esc(d.id)}" ${String(d.id) === String(v) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`;
  $('#main').innerHTML = head('Account & users') + `<div class="grid g2">${yours}
    <div class="card card-pad"><h2>Team members</h2>
      <p class="muted" style="margin:2px 0 8px"><b>Admin</b>: everything. <b>Sales</b>: CRM, texting &amp; email, quotes and contracts (point of sale). <b>Production</b>: the build board and drawings. <b>Delivery</b>: the delivery schedule, customer address &amp; phone, and drawings. Everyone can be signed in at the same time. Non-admins can be limited to one dealer lot.</p>
      <div class="tbl-wrap"><table class="tbl" style="margin:6px 0 14px"><tr><th>Name</th><th>Role</th><th>Dealer lot</th><th>Login</th><th></th></tr>${users.map(u => `<tr><td><b>${esc(u.name || '')}</b><div class="muted" style="font-size:12.5px">${esc(u.email)}${u.phone ? ' · ' + esc(u.phone) : ''}</div></td>
        <td>${u.id === me.id ? `<span class="pill">${ROLE_LABEL[u.role]} (you)</span>` : roleSel(u.role, `data-ur="${u.id}"`)}</td>
        <td>${u.role === 'admin' ? '<span class="muted">—</span>' : lotSel(u.dealer_id, `data-ul="${u.id}"`)}</td>
        <td>${u.id === me.id ? '<span class="pill on">On</span>' : `<label class="chk" title="Turn a login off without deleting it"><input type="checkbox" data-ua="${u.id}" ${u.active ? 'checked' : ''}>${u.active ? 'On' : 'Off'}</label>`}</td>
        <td class="num">${u.id === me.id ? '' : `<button class="icon-btn" data-del="${u.id}">${TRASH}</button>`}</td></tr>`).join('')}</table></div>
      <form class="form" id="uf"><label class="fld"><span>Name</span><input name="name"></label><label class="fld"><span>Email</span><input name="email" type="email"></label>
      <label class="fld"><span>Role</span>${roleSel('sales', 'name="role"')}</label><label class="fld"><span>Dealer lot</span>${lotSel('', 'name="dealer_id"')}</label>
      <label class="fld"><span>Mobile (optional)</span><input name="phone" type="tel"></label>
      <label class="fld"><span>Temporary password</span><input name="password" type="text" placeholder="8+ characters"></label></form>
      <button class="btn ghost" id="uadd" style="margin-top:12px">+ Add team member</button></div></div>`;
  $('#asave').onclick = guard(async () => { const d = Object.fromEntries(new FormData($('#af'))); await api('POST', '/api/admin/account', d); me = await api('GET', '/api/auth/me'); toast('Account updated'); account(); });
  $('#nsave').onclick = saveAlerts;
  $('#uadd').onclick = guard(async () => { await api('POST', '/api/admin/users', Object.fromEntries(new FormData($('#uf')))); toast('User added'); account(); });
  $('#main').onchange = guard(async e => {
    const t = e.target;
    if (t.dataset.ur) { await api('PATCH', `/api/admin/users/${t.dataset.ur}`, { role: t.value }); toast('Role updated'); account(); }
    if (t.dataset.ul) { await api('PATCH', `/api/admin/users/${t.dataset.ul}`, { dealer_id: t.value }); toast('Dealer lot updated'); }
    if (t.dataset.ua) { await api('PATCH', `/api/admin/users/${t.dataset.ua}`, { active: t.checked }); toast(t.checked ? 'Login turned on' : 'Login turned off'); account(); }
  });
  $('#main').onclick = guard(async e => { const b = e.target.closest('[data-del]'); if (b && confirmBox('Remove this user?')) { await api('DELETE', `/api/admin/users/${b.dataset.del}`); account(); } });
}

// ---------------------------------------------------------------------------
// Price tiers, dealer lots and ZIP codes
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}
const toCSV = rows => rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
const pickFile = accept => new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files[0]); i.click(); });
const readText = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(f); });
const newId = () => 'lot' + Math.random().toString(36).slice(2, 8);

/** Every priced item, for price sheets. */
function priceRows() {
  const rows = [];
  for (const s of catalog.styles) for (const z of s.sizes) rows.push({ key: 'size:' + z.id, type: 'Size', name: `${s.name} ${z.width}' x ${z.depth}'`, unit: 'each', base: z.price });
  for (const o of catalog.options) rows.push({ key: 'option:' + o.id, type: 'Option', name: o.name, unit: o.price_unit || 'each', base: o.price });
  for (const c of catalog.colors) if (Number(c.price)) rows.push({ key: 'color:' + c.id, type: 'Color', name: `${c.category}: ${c.name}`, unit: 'each', base: c.price });
  for (const r of roofingList({ settings })) rows.push({ key: 'roofing:' + r.key, type: 'Roofing', name: r.name, unit: r.price_unit, base: r.price });
  return rows;
}

async function pricingPage() {
  await loadCatalog();
  settings = await api('GET', '/api/admin/settings');
  let tiers = (settings.price_tiers || []).map(t => ({ ...t, overrides: { ...(t.overrides || {}) } }));
  while (tiers.length < MAX_TIERS) tiers.push({ id: tiers.length + 1, name: `Tier ${tiers.length + 1}`, adjust_pct: 0, overrides: {} });
  let dealers = (settings.dealers || []).map(d => ({ ...d }));
  let zips = (settings.zip_tiers || []).map(z => ({ ...z }));
  let mode = settings.pricing_mode || 'none', defTier = settings.default_tier || 1;
  const origin = settings.public_url || location.origin.replace(/\/admin.*$/, '');
  const tierOpts = sel => tiers.map(t => `<option value="${t.id}" ${String(t.id) === String(sel) ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const save = async (msg = 'Saved') => {
    await api('PUT', '/api/admin/settings', { pricing_mode: mode, default_tier: Number(defTier), price_tiers: tiers, dealers, zip_tiers: zips });
    settings = await api('GET', '/api/admin/settings'); toast(msg);
  };

  const render = () => {
    const ovCount = t => Object.keys(t.overrides || {}).length;
    $('#main').innerHTML = head('Price tiers & dealers', 'Set up to four price lists, then choose which one each dealer lot or ZIP code gets.', `<button class="btn primary" id="pSave">Save changes</button>`) + `
    <div class="card card-pad" style="margin-bottom:16px"><h2>How customers are priced</h2>
      <div class="row" style="gap:18px;margin:12px 0 6px">
        ${[['none', 'Same price everywhere'], ['dealer', 'By dealer lot'], ['zip', 'By ZIP code']].map(([k, l]) => `<label class="chk"><input type="radio" name="pmode" value="${k}" ${mode === k ? 'checked' : ''}>${l}</label>`).join('')}
      </div>
      <p class="muted" style="margin:6px 0 12px">${mode === 'dealer' ? 'Customers pick their dealer lot in the builder (or you send them a lot-specific link below). Each lot uses its tier.' : mode === 'zip' ? 'Customers enter their delivery ZIP. The tier comes from the ZIP list below; unlisted ZIPs use the default tier.' : 'Everyone sees the default tier.'}</p>
      <label class="fld" style="max-width:320px"><span>Default tier</span><select id="defTier">${tierOpts(defTier)}</select><small>Used before a customer picks a lot/ZIP, and for ZIPs not on your list.</small></label>
    </div>

    <div class="grid g4" style="margin-bottom:16px">${tiers.map((t, i) => `<div class="card card-pad tier">
      <label class="fld"><span>Tier ${t.id} name</span><input data-t="${i}" data-k="name" value="${esc(t.name)}"></label>
      <label class="fld"><span>Adjust all prices (%)</span><input type="number" step="0.5" data-t="${i}" data-k="adjust_pct" value="${t.adjust_pct ?? 0}"><small>e.g. 8 = 8% over standard. Uploaded prices override this.</small></label>
      <label class="fld"><span>Delivery fee ($)</span><input type="number" step="1" data-t="${i}" data-k="delivery_fee" value="${t.delivery_fee ?? ''}" placeholder="Default ${settings.delivery_fee ?? 0}"></label>
      <div class="muted" style="font-size:12.5px;margin:6px 0">${ovCount(t) ? `<b style="color:var(--ok)">${ovCount(t)} uploaded prices</b>` : 'No price sheet uploaded'}</div>
      <div class="stack-sm"><button class="btn ghost sm block" data-dl="${i}">Download price sheet</button>
      <button class="btn ghost sm block" data-ul="${i}">Upload price sheet</button>
      ${ovCount(t) ? `<button class="btn link sm block" data-clr="${i}">Clear uploaded prices</button>` : ''}</div>
    </div>`).join('')}</div>

    <div class="card" style="margin-bottom:16px"><div class="card-pad row" style="justify-content:space-between;padding-bottom:6px"><div><h2>Dealer lots</h2><p class="muted" style="margin:0">Used when pricing is by dealer lot. Each lot also gets its own builder link that locks in its pricing.</p></div><button class="btn ghost sm" id="addDealer">+ Add dealer lot</button></div>
      <div class="tbl-wrap"><table class="tbl"><tr><th>Lot name</th><th>Address</th><th>City</th><th>State</th><th>ZIP</th><th>Phone</th><th>Email</th><th>Tier</th><th></th></tr>
      ${dealers.map((d, i) => `<tr>${['name', 'address', 'city', 'state', 'zip', 'phone', 'email'].map(k => `<td><input class="in" data-d="${i}" data-k="${k}" value="${esc(d[k] || '')}" style="min-width:${k === 'name' ? 190 : k === 'state' ? 54 : k === 'zip' ? 72 : 110}px"></td>`).join('')}
        <td><select class="in" data-d="${i}" data-k="tier" style="min-width:130px">${tierOpts(d.tier)}</select></td>
        <td style="white-space:nowrap"><button class="icon-btn" title="Copy this lot's builder link" data-link="${i}">${COPY}</button> <button class="icon-btn" data-deld="${i}">${TRASH}</button></td></tr>`).join('') || '<tr><td colspan="9" class="muted">No dealer lots yet.</td></tr>'}</table></div></div>

    <div class="card"><div class="card-pad row" style="justify-content:space-between;padding-bottom:6px"><div><h2>ZIP codes</h2><p class="muted" style="margin:0">Used when pricing is by ZIP. Enter an exact ZIP (38301), a range (38300-38399) or a prefix (383). Exact beats range, range beats prefix.</p></div>
      <div class="row"><button class="btn ghost sm" id="addZip">+ Add</button><button class="btn ghost sm" id="ulZip">Upload ZIP list</button><button class="btn ghost sm" id="dlZip">Download ZIP list</button></div></div>
      <div class="card-pad" style="padding-top:6px"><div class="zipgrid">${zips.map((z, i) => `<div class="ziprow"><input class="in" data-z="${i}" data-k="match" value="${esc(z.match)}" placeholder="ZIP, range or prefix"><select class="in" data-z="${i}" data-k="tier">${tierOpts(z.tier)}</select><button class="icon-btn" data-delz="${i}">${TRASH}</button></div>`).join('') || '<p class="muted">No ZIP codes yet.</p>'}</div>
      <label class="fld" style="margin-top:12px"><span>Paste ZIPs (one per line: <code>ZIP,tier number</code>)</span><textarea id="zipPaste" placeholder="38301,1&#10;38300-38399,2&#10;372,3"></textarea></label>
      <button class="btn ghost sm" id="zipAddPaste" style="margin-top:8px">Add pasted ZIPs</button></div></div>`;
  };
  render();

  const main = $('#main');
  main.addEventListener('change', e => {
    const t = e.target, d = t.dataset;
    if (t.name === 'pmode') { mode = t.value; render(); }
    else if (t.id === 'defTier') defTier = t.value;
    else if (d.t !== undefined) { const v = t.value; tiers[d.t][d.k] = d.k === 'name' ? v : (v === '' ? (d.k === 'delivery_fee' ? null : 0) : Number(v)); }
    else if (d.d !== undefined) dealers[d.d][d.k] = d.k === 'tier' ? Number(t.value) : t.value;
    else if (d.z !== undefined) zips[d.z][d.k] = d.k === 'tier' ? Number(t.value) : t.value.trim();
  });
  main.addEventListener('click', guard(async e => {
    const b = e.target.closest('button'); if (!b) return; const d = b.dataset;
    if (b.id === 'pSave') return save('Pricing saved');
    if (b.id === 'addDealer') { dealers.push({ id: newId(), name: 'New dealer lot', tier: Number(defTier) }); render(); }
    if (d.deld !== undefined && confirmBox('Remove this dealer lot?')) { dealers.splice(+d.deld, 1); render(); }
    if (d.link !== undefined) {
      const dl = dealers[+d.link]; const url = `${(window.__configuratorUrl ? new URL(window.__configuratorUrl, location.href).href.split('#')[0] : origin + '/')}#dealer-${dl.id}`;
      try { await navigator.clipboard.writeText(url); toast('Link copied: ' + url); } catch { prompt('Copy this link', url); }
    }
    if (b.id === 'addZip') { zips.push({ match: '', tier: Number(defTier) }); render(); }
    if (d.delz !== undefined) { zips.splice(+d.delz, 1); render(); }
    if (b.id === 'zipAddPaste') {
      const lines = $('#zipPaste').value.split(/\n+/).map(l => l.split(/[,\t;]/).map(x => x.trim())).filter(r => r[0]);
      for (const [m, t] of lines) zips.push({ match: m, tier: Number(t) || Number(defTier) });
      toast(`Added ${lines.length} ZIP entr${lines.length === 1 ? 'y' : 'ies'}`); render();
    }
    if (b.id === 'dlZip') saveFile(new Blob([toCSV([['ZIP (exact, range or prefix)', 'Tier number'], ...zips.map(z => [z.match, z.tier])])], { type: 'text/csv' }), 'zip-price-tiers.csv');
    if (b.id === 'ulZip') {
      const f = await pickFile('.csv,text/csv,text/plain'); if (!f) return;
      const rows = parseCSV(await readText(f)).filter(r => /\d/.test(r[0] || ''));
      const add = rows.map(r => ({ match: String(r[0]).trim(), tier: Number(r[1]) || Number(defTier) }));
      zips = zips.concat(add); toast(`Added ${add.length} ZIP entries — click Save changes`); render();
    }
    if (d.dl !== undefined) {
      const t = tiers[+d.dl], rows = priceRows();
      const csv = toCSV([['ID (do not change)', 'Type', 'Item', 'Price unit', 'Standard price', `${t.name} price`],
        ...rows.map(r => [r.key, r.type, r.name, r.unit, r.base, t.overrides[r.key] ?? ''])]);
      saveFile(new Blob([csv], { type: 'text/csv' }), `price-sheet-${t.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`);
      toast('Fill in the last column (blank = use the % adjustment), then upload it.');
    }
    if (d.ul !== undefined) {
      const f = await pickFile('.csv,text/csv'); if (!f) return;
      const rows = parseCSV(await readText(f)); const known = new Set(priceRows().map(r => r.key));
      const ov = {}; let n = 0, bad = 0;
      for (const r of rows.slice(1)) {
        const key = String(r[0] || '').trim(), v = String(r[5] ?? '').replace(/[$,\s]/g, '');
        if (!known.has(key)) { if (key) bad++; continue; }
        if (v !== '' && !isNaN(Number(v))) { ov[key] = Number(v); n++; }
      }
      tiers[+d.ul].overrides = ov; render();
      toast(`${n} prices loaded for ${tiers[+d.ul].name}${bad ? ` (${bad} rows skipped — unknown ID)` : ''}. Click Save changes.`, !!bad && !n);
    }
    if (d.clr !== undefined && confirmBox('Clear the uploaded prices for this tier?')) { tiers[+d.clr].overrides = {}; render(); }
  }));
}
