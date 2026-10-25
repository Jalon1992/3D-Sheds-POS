// Demo backend: replaces the server API with an in-browser version so the admin AND the 3D builder
// can run as static pages. Data is kept in this browser's localStorage (shared by both demo pages).
// Nothing is sent anywhere: webhooks, GoHighLevel and emails only work on the deployed app.
import seed from './seed-admin.json';
import { priceConfig, sanitizeConfig, defaultConfig, stripPrices, hideQuotePrices } from '../public/js/shared/pricing.js';
import { floorPlanSVG } from '../public/js/shared/floorplan.js';
import { formatQuote } from '../public/js/shared/quote-format.js';
import { permissionsFor } from '../src/permissions.js';

const KEY = 'shedbuilder-demo-v2';
const PUBLIC = ['company_name', 'logo_url', 'brand_color', 'currency_symbol', 'tax_rate', 'tax_delivery', 'delivery_fee', 'show_prices',
  'success_message', 'consent_text', 'phone', 'website', 'privacy_url', 'require_phone', 'headline', 'thank_you_url', 'roofing',
  'downgrade_credit', 'remove_credit', 'color_groups', 'pricing_mode', 'price_tiers', 'default_tier', 'dealers', 'zip_tiers', 'customer_pdf', 'quote_terms'];
const JSONISH = { styles: ['standard_options', 'default_colors', 'roof_choices', 'available_options'], webhooks: ['events', 'headers'] };

// ---- storage -----------------------------------------------------------------
let db = null;
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch { /* storage unavailable */ }
  return fresh();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* full or blocked: keep in memory */ } }
function fresh() {
  const c = structuredClone(seed.catalog);
  const sizes = []; for (const s of c.styles) { for (const z of s.sizes) sizes.push(z); delete s.sizes; }
  const d = {
    styles: c.styles, sizes, colors: c.colors, options: c.options, settings: structuredClone(seed.settings),
    quotes: [], webhooks: [], api_keys: [], log: [],
    users: [
      { id: 1, email: 'demo@example.com', name: 'Demo Admin', role: 'admin', created_at: now() },
      { id: 2, email: 'shop@example.com', name: 'Sample Production Crew', role: 'production', created_at: now() },
      { id: 3, email: 'sales@example.com', name: 'Sam Sales', role: 'sales', created_at: now() },
      { id: 4, email: 'driver@example.com', name: 'Dee Delivery', role: 'delivery', created_at: now() },
    ],
    seq: 1000,
  };
  db = d; for (const fn of hooks.fresh) fn(d); sampleQuotes(); return d;
}
const now = (o = 0) => new Date(Date.now() - o).toISOString().replace('T', ' ').slice(0, 19);
const nextId = () => ++db.seq;
const tok = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

function catalog(includeInactive) {
  const act = r => includeInactive || r.active !== 0;
  const sort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id;
  const styles = db.styles.filter(act).sort(sort).map(s => ({ ...s, sizes: db.sizes.filter(z => z.style_id === s.id && act(z)).sort(sort) }));
  const settings = Object.fromEntries(PUBLIC.map(k => [k, db.settings[k]]));
  return { styles: styles.filter(s => includeInactive || s.sizes.length), colors: db.colors.filter(act), options: db.options.filter(act), settings };
}

// ---- quotes ------------------------------------------------------------------
const links = {
  view3d: q => `index.html#q-${q.token}`,
  glb: q => `index.html#q-${q.token}.glb`,
  plan: q => `index.html#q-${q.token}.plan`,
  admin: q => `admin.html#/quotes/${q.id}`,
};
const fmt = q => formatQuote(q, '', links);
function createQuote(config, customer, source, opts = {}) {
  const cat = catalog(false);
  const cfg = sanitizeConfig(cat, config);
  const pricing = priceConfig(cat, cfg);
  const { style, size } = pricing; delete pricing.style; pricing.size = { width: size.width, depth: size.depth };
  const id = nextId();
  const q = {
    id, number: 'Q-' + (10000 + id - 1000), token: tok(), status: 'new', ...customer, sms_consent: customer.sms_consent ? 1 : 0,
    source: source || 'configurator', utm: {}, config: cfg, pricing, total: pricing.total, style_name: style.name,
    size_label: `${size.width}' x ${size.depth}'`, created_at: now(), updated_at: now(), internal_notes: '',
    dealer_id: pricing.dealer ? String(pricing.dealer.id) : null, dealer_name: pricing.dealer?.name || null, price_tier: pricing.tier_name || null, pricing_zip: pricing.zip || null,
  };
  db.quotes.unshift(q); save();
  for (const fn of hooks.quoteCreated) fn(q, opts);
  return q;
}
export const hooks = { quoteCreated: [], fresh: [] };
function sampleQuotes() {
  const cat = catalog(false);
  const people = [['Sample', 'Customer A', 'Lofted Barn', 'won'], ['Sample', 'Customer B', 'Classic Gable', 'contacted'], ['Sample', 'Customer C', 'Garage', 'new']];
  people.forEach(([f, l, styleName, status], i) => {
    const st = cat.styles.find(s => s.name === styleName) || cat.styles[0];
    const cfg = defaultConfig(cat, st.id, st.sizes[Math.min(2, st.sizes.length - 1)].id);
    const q = createQuote(cfg, { first_name: f, last_name: l, email: `sample${i + 1}@example.com`, phone: `(615) 555-01${10 + i}`, city: 'Example City', notes: 'Sample quote for the demo' }, 'sample');
    q.status = status; q.created_at = now((i + 1) * 864e5 * 3);
  });
  save();
}

// ---- tiny router ---------------------------------------------------------------
const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const err = (msg, status = 400) => json({ error: msg }, status);
const routes = [];
const on = (method, re, fn) => routes.push([method, re, fn]);
const TABLES = ['styles', 'sizes', 'colors', 'options', 'webhooks'];
const loggedOut = () => { try { return sessionStorage.getItem(KEY + '-out') === '1'; } catch { return false; } };

const viewAs = () => { try { return Number(sessionStorage.getItem(KEY + '-as')) || 1; } catch { return 1; } };
const currentUser = () => db.users.find(u => u.id === viewAs()) || db.users[0];
on('GET', /^\/api\/auth\/me$/, () => (loggedOut() ? err('Not logged in', 401) : json({ ...currentUser(), permissions: permissionsFor(currentUser()) })));
on('POST', /^\/api\/auth\/login$/, () => { try { sessionStorage.removeItem(KEY + '-out'); } catch { /* */ } return json({ ...currentUser(), permissions: permissionsFor(currentUser()) }); });
on('POST', /^\/api\/auth\/logout$/, () => { try { sessionStorage.setItem(KEY + '-out', '1'); } catch { /* */ } return json({ ok: true }); });

// Dealer-facing configurator in the demo: the admin's "Open configurator" link adds #staff, which signs
// this tab in as the admin "View as" user. A plain link to the builder is the customer configurator.
try { if (location.hash === '#staff') { sessionStorage.setItem(KEY + '-dealer', '1'); history.replaceState(null, '', location.pathname + location.search); } } catch { /* */ }
const dealerViewer = () => { try { if (sessionStorage.getItem(KEY + '-dealer') !== '1' || loggedOut()) return null; } catch { return null; } const u = currentUser(); return { dealer_mode: true, name: u.name || u.email, role: u.role, dealer_id: u.dealer_id || null }; };
const pricesPublic = () => db.settings.show_prices !== false;
on('GET', /^\/api\/v1\/catalog$/, () => { const v = dealerViewer(); if (v) return json({ ...catalog(false), viewer: v }); return json(pricesPublic() ? catalog(false) : stripPrices(catalog(false))); });
on('GET', /^\/api\/admin\/catalog$/, () => json(catalog(true)));
on('GET', /^\/api\/admin\/settings$/, () => json({ ...db.settings, ghl_token: db.settings.ghl_token ? '••••••••' + String(db.settings.ghl_token).slice(-4) : '' }));
on('PUT', /^\/api\/admin\/settings$/, (m, b) => { if (typeof b.ghl_token === 'string' && b.ghl_token.startsWith('••••')) delete b.ghl_token; Object.assign(db.settings, b); save(); return json({ ok: true }); });

on('POST', /^\/api\/v1\/price$/, (m, b) => { if (!pricesPublic() && !dealerViewer()) return err('Prices are not shown publicly.', 403); try { const cat = catalog(false); const p = priceConfig(cat, sanitizeConfig(cat, b)); delete p.style; return json(p); } catch (e) { return err(e.message); } });
on('GET', /^\/api\/v1\/shared\/([a-f0-9]+)$/, m => { const q = db.quotes.find(x => x.token === m[1]); return q ? json({ number: q.number, config: q.config, ...(pricesPublic() || dealerViewer() ? { total: q.total } : {}) }) : err('Not found', 404); });
on('POST', /^\/api\/v1\/quotes$/, (m, b) => {
  const v = dealerViewer();
  const cfg = v?.dealer_id && b.config ? { ...b.config, dealer_id: v.dealer_id } : b.config;
  const pos = v && ['admin', 'sales'].includes(v.role) && b.pos ? { contact_id: Number(b.contact_id) || null, pos: true } : {};
  const cu = b.customer || {};
  if (pos.pos) { if (!pos.contact_id && !cu.first_name) return err('first_name is required'); if (!pos.contact_id && !cu.email && !cu.phone) return err("Enter the customer's email or mobile"); }
  else if (!cu.first_name || !cu.email) return err('first_name and email are required');
  else if (!v && db.settings.require_phone && !String(cu.phone || '').trim()) return err('phone is required');
  try { const q = createQuote(cfg, cu, v ? `Dealer configurator — ${v.name}` : b.source, pos); logEvent('quote.created', q); return json(v || pricesPublic() ? fmt(q) : hideQuotePrices(fmt(q)), 201); }
  catch (e) { return err(e.message); }
});
on('GET', /^\/api\/v1\/quotes$/, (m, b, url) => {
  const qs = url.searchParams, s = (qs.get('q') || '').toLowerCase(), st = qs.get('status'), dl = qs.get('dealer');
  const lim = currentUser().dealer_id;
  const rows = db.quotes.filter(q => (!st || q.status === st) && (!dl || q.dealer_id === dl) && (!lim || q.dealer_id === lim) && (!s || [q.first_name, q.last_name, q.email, q.phone, q.number].join(' ').toLowerCase().includes(s)));
  return json({ total: rows.length, data: rows.map(fmt) });
});
on('GET', /^\/api\/v1\/quotes\/(\d+)$/, m => { const q = db.quotes.find(x => x.id === +m[1]); return q ? json({ ...fmt(q), internal_notes: q.internal_notes, pricing_lines: q.pricing.lines, contact_id: q.contact_id || null }) : err('Not found', 404); });
on('PATCH', /^\/api\/v1\/quotes\/(\d+)$/, (m, b) => {
  const q = db.quotes.find(x => x.id === +m[1]); if (!q) return err('Not found', 404);
  const changed = b.status && b.status !== q.status;
  if (b.status) q.status = b.status; if (b.internal_notes !== undefined) q.internal_notes = b.internal_notes; q.updated_at = now(); save();
  logEvent(changed ? 'quote.status_changed' : 'quote.updated', q); return json(fmt(q));
});
on('DELETE', /^\/api\/v1\/quotes\/(\d+)$/, m => { db.quotes = db.quotes.filter(x => x.id !== +m[1]); save(); return json(null, 204); });
on('GET', /^\/api\/v1\/quotes\/(\d+)\/floorplan\.svg$/, m => {
  const q = db.quotes.find(x => x.id === +m[1]); if (!q) return err('Not found', 404);
  return new Response(floorPlanSVG(catalog(true), q.config, { customer: q, quote_number: q.number }), { headers: { 'Content-Type': 'image/svg+xml' } });
});
on('POST', /^\/api\/v1\/quotes\/(\d+)\/resend$/, m => { const q = db.quotes.find(x => x.id === +m[1]); if (q) logEvent('quote.created', q); return json({ queued: true }, 202); });

on('GET', /^\/api\/admin\/stats$/, () => {
  const since = Date.now() - 30 * 864e5, recent = db.quotes.filter(q => Date.parse(q.created_at.replace(' ', 'T') + 'Z') >= since);
  const by = (arr, k) => Object.values(arr.reduce((a, q) => { (a[q[k]] ||= { [k]: q[k], n: 0, sum: 0 }); a[q[k]].n++; a[q[k]].sum += q.total; return a; }, {}));
  const daily = Object.values(recent.reduce((a, q) => { const d = q.created_at.slice(0, 10); (a[d] ||= { d, n: 0 }).n++; return a; }, {}));
  return json({ total: db.quotes.length, last30: recent.length, value30: recent.reduce((s, q) => s + q.total, 0),
    byStatus: by(db.quotes, 'status').map(r => ({ status: r.status, n: r.n })),
    byStyle: by(db.quotes, 'style_name').map(r => ({ style_name: r.style_name, n: r.n, avg: Math.round(r.sum / r.n) })), daily });
});

for (const t of TABLES) {
  const rx = new RegExp(`^/api/v1/${t}$`), rxId = new RegExp(`^/api/v1/${t}/(\\d+)$`);
  on('GET', rx, () => json(db[t]));
  on('GET', rxId, m => { const r = db[t].find(x => x.id === +m[1]); return r ? json(r) : err('Not found', 404); });
  on('POST', rx, (m, b) => { const r = { ...b, id: nextId() }; if (t === 'webhooks') { r.active ??= 1; r.created_at = now(); } r.active ??= 1; db[t].push(r); save(); return json(r, 201); });
  const upd = (m, b) => { const r = db[t].find(x => x.id === +m[1]); if (!r) return err('Not found', 404); Object.assign(r, b); save(); return json(r); };
  on('PATCH', rxId, upd); on('PUT', rxId, upd);
  on('DELETE', rxId, m => { db[t] = db[t].filter(x => x.id !== +m[1]); if (t === 'styles') db.sizes = db.sizes.filter(z => z.style_id !== +m[1]); save(); return json(null, 204); });
}
on('PUT', /^\/api\/admin\/styles\/(\d+)\/sizes$/, (m, b) => {
  const sid = +m[1];
  const len = v => (+v > 0 ? +v : null);
  const next = (b || []).filter(z => +z.width && +z.depth).map((z, i) => ({ id: z.id || nextId(), style_id: sid, width: +z.width, depth: +z.depth, price: +z.price || 0, active: z.active === false || z.active === 0 || z.active === '0' ? 0 : 1, sort: i, hip_len: len(z.hip_len), upper_len: len(z.upper_len) }));
  db.sizes = db.sizes.filter(z => z.style_id !== sid).concat(next); save(); return json(next);
});
on('POST', /^\/api\/admin\/duplicate\/(styles|options|colors)\/(\d+)$/, m => {
  const src = db[m[1]].find(x => x.id === +m[2]); if (!src) return err('Not found', 404);
  const copy = { ...structuredClone(src), id: nextId(), name: src.name + ' (copy)' }; db[m[1]].push(copy);
  if (m[1] === 'styles') db.sizes.filter(z => z.style_id === src.id).forEach(z => db.sizes.push({ ...z, id: nextId(), style_id: copy.id }));
  save(); return json({ id: copy.id });
});
on('POST', /^\/api\/v1\/webhooks\/(\d+)\/test$/, () => json({ ok: false, status: 0, response: 'Demo mode: webhooks are not sent. They work on your deployed app.' }));
on('GET', /^\/api\/admin\/webhook-log$/, () => json(db.log));
on('GET', /^\/api\/admin\/events$/, () => json(['quote.created', 'quote.updated', 'quote.status_changed', 'test']));
on('GET', /^\/api\/admin\/api-keys$/, () => json(db.api_keys));
on('POST', /^\/api\/admin\/api-keys$/, (m, b) => { const key = 'sb_demo_' + tok().slice(0, 24); const r = { id: nextId(), name: b.name || 'API key', prefix: key.slice(0, 12), created_at: now(), last_used: null }; db.api_keys.unshift(r); save(); return json({ ...r, key }); });
on('DELETE', /^\/api\/admin\/api-keys\/(\d+)$/, m => { db.api_keys = db.api_keys.filter(k => k.id !== +m[1]); save(); return json(null, 204); });
on('POST', /^\/api\/admin\/ghl\/test$/, () => err('Demo mode: GoHighLevel is not contacted from the demo. This button works on your deployed app.'));
on('GET', /^\/api\/admin\/users$/, () => json(db.users));
on('POST', /^\/api\/admin\/users$/, (m, b) => { if (!b.email || !b.password || b.password.length < 8) return err('Email and an 8+ character password are required'); db.users.push({ id: nextId(), email: b.email, name: b.name || '', phone: b.phone || '', role: b.role || 'admin', dealer_id: b.role === 'admin' ? null : (b.dealer_id || null), active: 1, created_at: now() }); save(); return json({ ok: true }); });
on('PATCH', /^\/api\/admin\/users\/(\d+)$/, (m, b) => { const u = db.users.find(x => x.id === +m[1]); if (!u) return err('Not found', 404); if (b.role) u.role = b.role; if ('dealer_id' in b) u.dealer_id = b.dealer_id || null; if ('active' in b) u.active = b.active ? 1 : 0; if (u.role === 'admin') u.dealer_id = null; save(); return json({ ok: true }); });
on('DELETE', /^\/api\/admin\/users\/(\d+)$/, m => { if (+m[1] === 1) return err("You can't delete yourself"); db.users = db.users.filter(u => u.id !== +m[1]); save(); return json(null, 204); });
on('POST', /^\/api\/admin\/account$/, (m, b) => { Object.assign(db.users[0], { email: b.email || db.users[0].email, name: b.name || db.users[0].name }); save(); return json({ ok: true }); });
on('POST', /^\/api\/admin\/upload$/, async (m, b) => {
  const f = b instanceof FormData ? b.get('file') : null; if (!f) return err('Choose a file to upload');
  if (f.size > 3e6) return err('The demo keeps uploads in your browser, so files must be under 3 MB. The deployed app accepts up to 40 MB.');
  const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
  return json({ url, name: f.name, size: f.size });
});
on('DELETE', /^\/api\/admin\/upload$/, () => json(null, 204));

function logEvent(event, q) {
  const hooks = db.webhooks.filter(h => h.active);
  const targets = [...hooks.map(h => h.url), ...(db.settings.ghl_inbound_webhook_url ? [db.settings.ghl_inbound_webhook_url] : []), ...(db.settings.ghl_enabled ? ['GHL API'] : [])];
  for (const t of targets) db.log.unshift({ id: nextId(), target: t, event, status: 0, ok: 0, attempt: 1, response: `Demo mode: not sent (${q.number})`, created_at: now() });
  db.log = db.log.slice(0, 100); save();
}

// ---- install -------------------------------------------------------------------
let ready = Promise.resolve();
export const setReady = p => { ready = p; };
export const api = { on, json, err, save, nextId, now, tok, catalog, fmt, currentUser, get db() { return db; }, KEY };
db = load();
const realFetch = window.fetch.bind(window);
window.fetch = async (input, opts = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/') && !url.pathname.includes('/api/')) return realFetch(input, opts);
  const path = url.pathname.slice(url.pathname.indexOf('/api/'));
  const method = (opts.method || 'GET').toUpperCase();
  let body = opts.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep */ } }
  await ready;
  for (const [m, re, fn] of routes) {
    const hit = m === method && path.match(re);
    if (hit) { await new Promise(r => setTimeout(r, 40)); try { return await fn(hit, body || {}, url); } catch (e) { console.error(e); return err(e.message || 'Something went wrong', 500); } }
  }
  return err('Not available in the demo', 404);
};
// Floor plan images in the admin are <img> tags, so serve them as blob URLs
window.__planUrl = id => {
  const q = db.quotes.find(x => x.id === +id); if (!q) return '';
  const svg = floorPlanSVG(catalog(true), q.config, { customer: q, quote_number: q.number });
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
};
window.__shedDemoUsers = () => db.users;
window.__shedDemoViewAs = id => { try { sessionStorage.setItem(KEY + '-as', String(id)); } catch { /* */ } location.hash = ''; location.reload(); };
window.__shedDemoReset = async () => { try { localStorage.removeItem(KEY); } catch { /* */ } try { await window.__shedDemoClearFiles?.(); } catch { /* */ } location.reload(); };
