// 3D Shed Builder — server entry point.
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { mkdirSync, unlinkSync, openSync, readSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, all, get, run, getSettings, setSettings, getCatalog, JSON_COLS, SCHEMA_VERSION, DB_SCHEMA, BACKUP_DIR, PRE_UPDATE, RESTORED } from './src/db.js';
import { stageRestore, cancelRestore } from './src/restore.js';
import { APP_VERSION } from './src/version.js';
import { backupNow, listBackups, startBackups, offsiteOn, offsite, NAME_RE } from './src/backup.js';
import { seed } from './src/seed.js';
import { requireAuth, requireSession, issueSession, clearSession, verifyPassword, hashPassword, createApiKey, readSession, readApiKey, ROLES, endSessions, sessionKeyReady } from './src/auth.js';
import { emit, deliver, formatQuote, recentLog, pushToGHL, EVENTS, blockedTarget, checkOutboundUrl, expectQuotePdf, waitingForDrawings, drawingsArrived, quotePdfBytes, storedQuotePdf, resendQuotePdf, ghlLookup, GHL_VALUES } from './src/integrations.js';
import { checkDrawings } from './src/quote-pdf.js';
import { openapi } from './src/openapi.js';
import { priceConfig, sanitizeConfig, stripPrices, hideQuotePrices } from './public/js/shared/pricing.js';
import { floorPlanSVG } from './public/js/shared/floorplan.js';
import { crmRouter, hooksRouter, seedCRM, backfillQuotes, onQuoteCreated } from './src/crm.js';
import { posRouter, signRouter, seedContracts } from './src/contracts.js';
import { permissionsFor, setModuleSource } from './src/permissions.js';
import { MODULES, normalizeModules, roleUsable } from './public/js/shared/modules.js';
import { broadcast } from './src/realtime.js';
import { dailyReport, localDay } from './public/js/shared/reports.js';
import { toE164, sendEmail, sendSMS, messagingStatus, fromAddress, verifyMessaging, connectTwilioReplies } from './src/messaging.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

seed();
seedCRM();
backfillQuotes();
await seedContracts();

// ---- Add-on modules (CRM, Point of sale, Production & delivery). The first run takes MODULES from the
// environment (e.g. MODULES=crm,pos or MODULES=none; default: all on); after that the developer login
// switches them on the Modules page. Cached here because every permission check reads it.
if (getSettings().modules === undefined) setSettings({ modules: normalizeModules(process.env.MODULES || 'all') });
let MODS = normalizeModules(getSettings().modules);
setModuleSource(() => MODS);
// Just restored a backup: everyone signs in again (the backup's own sign-in key is replaced, so logins made on the
// install the backup came from don't work here), and the System page says what was restored.
if (RESTORED) { run("DELETE FROM settings WHERE key = '_session_secret'"); setSettings({ _restored: RESTORED }); }
// The developer login (DEVOPS_EMAIL + DEVOPS_PASSWORD) is the only one that can switch modules once it exists.
// Re-applied on every start, so the password in the hosting settings always works (also a lock-out fix).
(function ensureDevops() {
  const email = String(process.env.DEVOPS_EMAIL || '').toLowerCase().trim(), pw = String(process.env.DEVOPS_PASSWORD || '');
  if (!email && !pw) return;
  if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 10) { console.warn('  ⚠  Developer login not set up: DEVOPS_EMAIL must be an email and DEVOPS_PASSWORD at least 10 characters.'); return; }
  const u = get('SELECT * FROM users WHERE email = ?', email);
  if (u) {
    const changed = !verifyPassword(pw, u.password_hash);
    run("UPDATE users SET is_devops = 1, role = 'admin', dealer_id = NULL, active = 1, password_hash = ? WHERE id = ?", changed ? hashPassword(pw) : u.password_hash, u.id);
    if (changed || !u.is_devops) endSessions(u.id); // a new developer password signs out the old one everywhere
  }
  else run("INSERT INTO users (email, name, password_hash, role, is_devops) VALUES (?, 'Developer', ?, 'admin', 1)", email, hashPassword(pw));
})();
const hasDevops = () => !!get('SELECT id FROM users WHERE COALESCE(is_devops, 0) = 1 AND COALESCE(active, 1) = 1 LIMIT 1');
const canManageModules = u => !!u && u.role === 'admin' && (u.devops || !hasDevops());
const meInfo = u => ({ ...u, permissions: permissionsFor(u), modules: MODS, can_manage_modules: canManageModules(u), version: APP_VERSION.id });

const app = express();
app.disable('x-powered-by');
// Only trust the hosting platform's own proxy hop (Railway/Render/Fly) for the client IP + https detection.
// 'true' would let anyone spoof X-Forwarded-For and dodge the rate limits.
const TRUST = process.env.TRUST_PROXY || '1';
app.set('trust proxy', /^\d+$/.test(TRUST) ? Number(TRUST) : TRUST === 'true' ? true : TRUST === 'false' ? false : TRUST);

// ---- Security headers. The 3D configurator stays embeddable (website / GHL funnels); the admin, the signing
// page and the API can't be framed by other sites (clickjacking), and nothing is content-sniffed.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (/^\/(admin|sign|api|docs)(\/|$)/.test(req.path)) { res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "frame-ancestors 'none'"); }
  if (req.path.startsWith('/sign/')) res.setHeader('Referrer-Policy', 'no-referrer'); // the signing token is in the address
  next();
});
// ---- Cross-site request check (defence in depth on top of SameSite cookies): a signed-in browser request that
// changes something must come from this site.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !/(^|;\s*)sb_session=/.test(req.headers.cookie || '')) return next();
  const origin = req.get('origin'); if (!origin) return next(); // same-site navigations and non-browser clients send none
  let host; try { host = new URL(origin).host; } catch { return res.status(403).json({ error: 'Request blocked: unknown origin.' }); }
  const pub = (() => { try { return new URL(getSettings().public_url).host; } catch { return null; } })();
  if (host === req.get('host') || host === pub) return next();
  res.status(403).json({ error: 'Request blocked: it came from another website.' });
});
app.use(express.json({ limit: '2mb' }));

// (security headers are set once, near the top)

// ---- CORS for the API (lets you embed the configurator or call the API from any site / CRM)
app.use('/api/v1', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Links sent in webhooks/GHL/emails. Never built from an unchecked Host header (an attacker could otherwise
// make customer links point at their own site).
const baseUrl = req => {
  const fixed = getSettings().public_url || process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
  if (fixed) return String(fixed).replace(/\/$/, '');
  const host = String(req.get('host') || '');
  return `${req.protocol}://${/^[a-z0-9.-]+(:\d+)?$/i.test(host) ? host : 'localhost:' + PORT}`;
};
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---- Simple in-memory rate limit for public quote submissions
const hits = new Map();
const MAX_KEYS = 50000; // a flood of made-up addresses can't grow this without limit
setInterval(() => { const now = Date.now(); for (const [k, arr] of hits) if (!arr.some(t => now - t < 600000)) hits.delete(k); }, 300000).unref();
function rateLimit(max, windowMs, keyFn = req => req.ip + req.path) {
  return (req, res, next) => {
    const k = keyFn(req), now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return bad(res, 'Too many requests, please try again in a minute.', 429);
    arr.push(now); if (!hits.has(k) && hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value); hits.set(k, arr); next();
  };
}

// =============================================================================
//  PUBLIC API
// =============================================================================
// Price visibility: customers see prices only when "Show prices to customers" is on.
// Signed-in staff (admin / sales / production) get the dealer-facing configurator, which always shows prices.
const pricesPublic = () => getSettings().show_prices !== false;
function dealerViewer(req) {
  const u = readSession(req);
  return u ? { dealer_mode: true, name: u.name || u.email, role: u.role, dealer_id: u.dealer_id || null } : null;
}
const canSeePrices = req => pricesPublic() || !!readSession(req) || !!readApiKey(req);
app.get('/api/v1/catalog', (req, res) => {
  const viewer = dealerViewer(req);
  res.set('Cache-Control', 'private, no-store');
  if (viewer) return res.json({ ...getCatalog(), viewer: { ...viewer, modules: MODS } });
  res.json(pricesPublic() ? getCatalog() : stripPrices(getCatalog()));
});

// Health check for Railway/Render/Docker: answers once the database is reachable
// Health check (Railway uses it to decide a new deploy is good): the database answers and can be written to,
// logins can work (an active admin + the session key exist), and which version/commit this install runs.
app.get('/healthz', (req, res) => {
  const checks = {};
  try { get('SELECT 1 AS ok'); run("INSERT INTO settings (key, value) VALUES ('_health', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(Date.now())); checks.database = true; } catch { checks.database = false; }
  try { checks.login = !!get("SELECT id FROM users WHERE COALESCE(role, 'admin') = 'admin' AND COALESCE(active, 1) = 1 LIMIT 1") && sessionKeyReady(); } catch { checks.login = false; }
  const ok = checks.database && checks.login;
  const last = (() => { try { return getSettings()._backup_last || null; } catch { return null; } })();
  res.status(ok ? 200 : 503).json({ ok, version: APP_VERSION.version, commit: APP_VERSION.commit, schema: DB_SCHEMA, checks, uptime_s: Math.round(process.uptime()), last_backup: last ? { at: last.at, ok: !last.error } : null });
});
app.post('/api/v1/price', rateLimit(240, 60000), (req, res) => {
  if (!canSeePrices(req)) return bad(res, 'Prices are not shown publicly. Send an API key to price a configuration.', 403);
  try {
    const cat = getCatalog();
    const v = dealerViewer(req); // lot staff always price for their own lot, same as their quotes
    const cfg = sanitizeConfig(cat, v?.dealer_id && req.body && typeof req.body === 'object' ? { ...req.body, dealer_id: v.dealer_id } : req.body);
    const p = priceConfig(cat, cfg);
    delete p.style; res.json({ ...p, size: { width: p.size?.width, depth: p.size?.depth } });
  } catch (e) { bad(res, e.message); }
});

// staff on a lot share one internet connection, so signed-in users aren't throttled
const quoteLimit = rateLimit(8, 60000);
app.post('/api/v1/quotes', (req, res, next) => (readSession(req) ? next() : quoteLimit(req, res, next)), wrap(async (req, res) => {
  const { config: rawConfig, customer: rawCustomer = {}, source: rawSource, utm } = req.body || {};
  const viewer = dealerViewer(req);
  let customer = rawCustomer && typeof rawCustomer === 'object' ? { ...rawCustomer } : {};
  // Point of sale: a sales rep redesigning a building for a customer they are writing a contract for.
  // The quote goes on that contact (no new lead, no auto-replies); blanks are filled from the contact.
  let posContact = null;
  const staffUser = viewer && ['admin', 'sales'].includes(viewer.role) && MODS.pos ? readSession(req) : null; // POS design saves need Point of sale
  if (staffUser && req.body?.contact_id) {
    posContact = get('SELECT * FROM contacts WHERE id = ?', Number(req.body.contact_id));
    if (!posContact || (staffUser.dealer_id && posContact.dealer_id && String(posContact.dealer_id) !== String(staffUser.dealer_id))) return bad(res, 'Contact not found', 404);
    for (const k of ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'zip']) if (!String(customer[k] || '').trim() && posContact[k]) customer[k] = posContact[k];
    if (!customer.first_name) customer.first_name = posContact.company || 'Customer';
  }
  // dealer-facing configurator: lot staff always quote for their own lot
  const config = viewer?.dealer_id && rawConfig && typeof rawConfig === 'object' ? { ...rawConfig, dealer_id: viewer.dealer_id } : rawConfig;
  const source = viewer ? `Dealer configurator — ${viewer.name}` : rawSource;
  if (staffUser && req.body?.pos) { // staff writing up a sale: a name plus email or mobile is enough
    if (!customer.first_name) return bad(res, 'first_name is required');
    if (!posContact && !customer.email && !customer.phone) return bad(res, 'Enter the customer\'s email or mobile');
  } else if (!customer.first_name || !customer.email) return bad(res, 'first_name and email are required');
  else if (!viewer && getSettings().require_phone && !String(customer.phone || '').trim() && !readApiKey(req)) return bad(res, 'phone is required');
  if (customer.email && !/^\S+@\S+\.\S+$/.test(customer.email)) return bad(res, 'email looks invalid');
  const cat = getCatalog();
  let cfg, pricing;
  try { cfg = sanitizeConfig(cat, config); pricing = priceConfig(cat, cfg); } catch (e) { return bad(res, e.message); }
  const { style, size } = pricing; delete pricing.style;
  pricing.size = { width: size.width, depth: size.depth };
  const s = (v, n = 500) => (v == null || typeof v === 'object' ? null : String(v).slice(0, n));
  const token = crypto.randomBytes(16).toString('hex');
  // a lot-restricted staff login always files the quote under its own lot (so it shows in their quote list),
  // even when pricing isn't per-dealer
  const lotId = viewer?.dealer_id ? String(viewer.dealer_id) : pricing.dealer ? String(pricing.dealer.id) : null;
  const lotName = pricing.dealer?.name || (lotId ? (getSettings().dealers || []).find(d => String(d.id) === lotId)?.name || null : null);
  const r = run(`INSERT INTO quotes (token, first_name, last_name, email, phone, address, city, state, zip, notes, sms_consent, source, utm, config, pricing, total, style_name, size_label, dealer_id, dealer_name, price_tier, pricing_zip)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    token, s(customer.first_name), s(customer.last_name), s(customer.email)?.toLowerCase() ?? null, s(customer.phone), s(customer.address), s(customer.city),
    s(customer.state), s(customer.zip), s(customer.notes, 4000), customer.sms_consent ? 1 : 0, s(source || req.get('referer') || 'configurator'),
    JSON.stringify(cleanUtm(utm)), JSON.stringify(cfg), JSON.stringify(pricing), pricing.total, style.name, `${size.width}' x ${size.depth}'`,
    lotId, lotName, pricing.tier_name || null, pricing.zip || null);
  const id = Number(r.lastInsertRowid);
  run('UPDATE quotes SET number = ? WHERE id = ?', 'Q-' + (10000 + id), id);
  const q = get('SELECT * FROM quotes WHERE id = ?', id);
  emit('quote.created', q, baseUrl(req));
  // GoHighLevel gets the quote PDF: the configurator sends its drawing set (3D view, elevations, floor plan) next
  const wantDrawings = expectQuotePdf(q, baseUrl(req), req.body?.with_drawings === true && !req.body?.pos);
  const out = formatQuote(q, baseUrl(req));
  if (wantDrawings) out.drawings_upload = `/api/v1/quote-drawings/${token}`;
  onQuoteCreated(q, baseUrl(req), out, { contact_id: posContact?.id || null, pos: !!(staffUser && req.body?.pos), user: staffUser }).catch(e => console.error('CRM:', e)); // contact + deal are created synchronously; auto-replies finish in the background
  delete out.links.admin; delete out.integrations;
  res.status(201).json(viewer || pricesPublic() ? out : hideQuotePrices(out));
}));

// The customer's browser sends the drawing set for the company's quote PDF. Only for a quote that is
// waiting for it (a couple of minutes after it was sent), once, and it must be a real PDF.
const drawingsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 0 } });
app.post('/api/v1/quote-drawings/:token', rateLimit(10, 60000), drawingsUpload.single('drawings'), wrap(async (req, res) => {
  const q = /^[a-f0-9]{32}$/.test(req.params.token) ? get('SELECT id FROM quotes WHERE token = ?', req.params.token) : null;
  if (!q || !waitingForDrawings(q.id)) return bad(res, 'Not expecting drawings for this quote', 404);
  try { await checkDrawings(req.file?.buffer); } catch { return bad(res, 'Drawings must be a PDF', 400); }
  drawingsArrived(q.id, req.file.buffer);
  res.status(202).json({ ok: true });
}));
// Private link to the company's quote PDF (used in GoHighLevel when the PDF can't be stored there)
app.get('/q/pdf/:pdfToken', (req, res) => {
  const q = /^[a-f0-9]{32}$/.test(req.params.pdfToken) ? get('SELECT * FROM quotes WHERE pdf_token = ?', req.params.pdfToken) : null;
  const bytes = q && storedQuotePdf(q);
  if (!bytes) return res.status(404).send('Not found');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${q.number}-quote.pdf"`, 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' }).send(bytes);
});

const COLOR_CATS = ['siding', 'trim', 'door', 'window', 'roof'];
function cleanUtm(u) {
  const out = {};
  if (u && typeof u === 'object' && !Array.isArray(u))
    for (const [k, v] of Object.entries(u).slice(0, 20)) if (/^[\w.-]{1,40}$/.test(k) && v != null && typeof v !== 'object') out[k] = String(v).slice(0, 300);
  return out;
}

// Customer-facing quote by secret token (reload in configurator / floor plan link in emails)
app.get('/api/v1/shared/:token', (req, res) => {
  const q = get('SELECT * FROM quotes WHERE token = ?', req.params.token);
  if (!q) return bad(res, 'Not found', 404);
  res.json({ number: q.number, first_name: q.first_name, last_name: q.last_name, config: q.config, ...(canSeePrices(req) ? { total: q.total } : {}), created_at: q.created_at });
});
app.get('/q/:token/floorplan.svg', (req, res) => {
  const q = get('SELECT * FROM quotes WHERE token = ?', req.params.token);
  if (!q) return res.status(404).send('Not found');
  sendPlan(res, q);
});
function sendPlan(res, q) {
  try {
    const cat = getCatalog({ includeInactive: true });
    res.type('image/svg+xml').setHeader('Content-Disposition', `inline; filename="${q.number}-floor-plan.svg"`);
    res.send(floorPlanSVG(cat, q.config, { customer: q, quote_number: q.number, date: new Date(q.created_at + 'Z').toLocaleDateString('en-US') }));
  } catch (e) { console.error(e); res.status(500).send('Could not render floor plan'); }
}

app.get('/api/openapi.json', (req, res) => res.json(openapi(baseUrl(req))));

// =============================================================================
//  AUTHENTICATED API (admin session OR API key)
// =============================================================================
const v1 = express.Router();
v1.use(requireAuth);

// ---- Quotes
v1.get('/quotes', (req, res) => {
  const where = [], p = [];
  if (req.query.status) { where.push('status = ?'); p.push(req.query.status); }
  if (req.query.dealer) { where.push('dealer_id = ?'); p.push(String(req.query.dealer)); }
  if (req.user?.dealer_id) { where.push('dealer_id = ?'); p.push(String(req.user.dealer_id)); }
  if (req.query.since) { where.push('created_at >= ?'); p.push(String(req.query.since).replace('T', ' ').replace('Z', '')); }
  if (req.query.q) { where.push("(first_name || ' ' || last_name LIKE ? OR email LIKE ? OR phone LIKE ? OR number LIKE ?)"); const l = `%${req.query.q}%`; p.push(l, l, l, l); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(500, Number(req.query.limit) || 50), offset = Number(req.query.offset) || 0;
  const total = get(`SELECT COUNT(*) n FROM quotes ${w}`, ...p).n;
  const rows = all(`SELECT * FROM quotes ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
  res.json({ total, data: rows.map(q => ({ ...formatQuote(q, baseUrl(req)), internal_notes: q.internal_notes, ghl_status: q.ghl_status })) });
});
const ownQuote = (req, q) => !req.user?.dealer_id || String(q.dealer_id) === String(req.user.dealer_id);
v1.get('/quotes/:id', (req, res) => {
  const q = get('SELECT * FROM quotes WHERE id = ?', Number(req.params.id));
  if (!q || !ownQuote(req, q)) return bad(res, 'Not found', 404);
  const out = { ...formatQuote(q, baseUrl(req)), internal_notes: q.internal_notes, ghl_status: q.ghl_status, pricing_lines: q.pricing.lines, contact_id: q.contact_id || null, ghl_pdf_url: q.ghl_pdf_url || null };
  // production / delivery open a quote only to print its drawings: no prices
  if (req.user && !['admin', 'sales'].includes(req.user.role)) {
    out.pricing = null; out.pricing_lines = []; out.options = out.options.map(({ price, ...o }) => o); out.summary = out.summary.replace(/\s*\|\s*Total: \$[\d,.]+$/, '');
    delete out.integrations; delete out.ghl_status; delete out.ghl_pdf_url;
  }
  res.json(out);
});
v1.patch('/quotes/:id', (req, res) => {
  const q = get('SELECT * FROM quotes WHERE id = ?', Number(req.params.id));
  if (!q || !ownQuote(req, q)) return bad(res, 'Not found', 404);
  const { status, internal_notes } = req.body || {};
  if (status != null && !/^[a-z0-9 _-]{1,40}$/i.test(String(status))) return bad(res, 'status must be a short word like new, contacted, quoted, won or lost');
  if (internal_notes != null && String(internal_notes).length > 20000) return bad(res, 'internal_notes is too long');
  run("UPDATE quotes SET status = COALESCE(?, status), internal_notes = COALESCE(?, internal_notes), updated_at = datetime('now') WHERE id = ?",
    status == null ? null : String(status).toLowerCase(), internal_notes == null ? null : String(internal_notes), q.id);
  const nq = get('SELECT * FROM quotes WHERE id = ?', q.id);
  emit(status && status !== q.status ? 'quote.status_changed' : 'quote.updated', nq, baseUrl(req));
  res.json(formatQuote(nq, baseUrl(req)));
});
v1.delete('/quotes/:id', (req, res) => {
  const q = get('SELECT id, dealer_id FROM quotes WHERE id = ?', Number(req.params.id));
  if (!q || !ownQuote(req, q)) return bad(res, 'Not found', 404);   // a dealer's login can't delete another dealer's quote
  run('DELETE FROM quotes WHERE id = ?', q.id); res.sendStatus(204);
});
v1.get('/quotes/:id/quote.pdf', wrap(async (req, res) => {
  const q = get('SELECT * FROM quotes WHERE id = ?', Number(req.params.id));
  if (!q || !ownQuote(req, q)) return bad(res, 'Not found', 404);
  const bytes = storedQuotePdf(q) || Buffer.from(await quotePdfBytes(q, baseUrl(req)));
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${q.number}-quote.pdf"`, 'Cache-Control': 'private, no-store' }).send(bytes);
}));
v1.get('/quotes/:id/floorplan.svg', (req, res) => {
  const q = get('SELECT * FROM quotes WHERE id = ?', Number(req.params.id));
  if (!q || !ownQuote(req, q)) return res.status(404).send('Not found');
  sendPlan(res, q);
});
v1.post('/quotes/:id/resend', (req, res) => {
  const q = get('SELECT * FROM quotes WHERE id = ?', Number(req.params.id));
  if (!q || !ownQuote(req, q)) return bad(res, 'Not found', 404);
  emit('quote.created', q, baseUrl(req));
  resendQuotePdf(q.id, baseUrl(req));
  res.status(202).json({ queued: true });
});

// ---- Generic CRUD for catalog + webhooks
const TABLES = {
  styles: ['skid_size', 'skid_count', 'skid_spacing', 'name', 'description', 'image_url', 'roof_type', 'ridge_axis', 'wall_height', 'roof_pitch', 'roof_pitch_lower', 'roof_pitch_back', 'gambrel_break', 'gambrel_lower_len', 'gambrel_upper_len', 'rake_tail', 'overhang', 'gable_overhang', 'overhang_right', 'fascia_size', 'rake_size', 'metal_rake_size', 'metal_rake_leg', 'roof_edge', 'rake_cap_size', 'drip_edge_size', 'drip_edge_color', 'corner_trim', 'casing_trim', 'siding_type', 'trim_type', 'roof_material', 'roof_choices', 'available_options', 'standard_options', 'default_colors', 'active', 'sort'],
  sizes: ['style_id', 'width', 'depth', 'price', 'hip_len', 'upper_len', 'skid_size', 'skid_count', 'skid_spacing', 'active', 'sort'],
  colors: ['name', 'hex', 'category', 'uses', 'material', 'price', 'active', 'sort'],
  options: ['name', 'description', 'category', 'kind', 'placement', 'swap_group', 'width', 'height', 'depth', 'elevation', 'gable_mode', 'package_items', 'package_only', 'grid_top', 'grid_bottom', 'length_choices', 'only_styles', 'garage_panel', 'garage_windows', 'insulated', 'slanted_corners', 'no_corner_trim', 'trim_frame', 'price', 'price_unit', 'model_url', 'image_url', 'plan_label', 'max_qty', 'active', 'sort'],
  webhooks: ['name', 'url', 'events', 'secret', 'headers', 'active'],
};
function clean(table, body) {
  const out = {};
  for (const k of TABLES[table]) if (body && k in body) {
    let v = body[k];
    if (k === 'uses') {   // paint "Used for": known places only; the first one is also kept as the color's category
      const u = Array.isArray(v) ? [...new Set(v.filter(x => COLOR_CATS.includes(x)))] : [];
      v = u.length ? JSON.stringify(u) : null;
      if (u.length && table === 'colors' && !u.includes(body.category)) out.category = u[0];
      out[k] = v; continue;
    }
    if (k === 'category' && table === 'colors' && !COLOR_CATS.includes(v)) v = Array.isArray(body.uses) && COLOR_CATS.includes(body.uses[0]) ? body.uses[0] : 'siding';
    if ((k === 'available_options' || k === 'only_styles') && !Array.isArray(v)) v = null;
    else if (k === 'only_styles') v = v.length ? JSON.stringify([...new Set(v.map(Number).filter(n => n > 0))]) : null;
    else if (JSON_COLS.has(k) && typeof v !== 'string') v = JSON.stringify(v ?? (k === 'headers' || k === 'default_colors' ? {} : []));
    if ((k === 'skid_size') && !['4x4', '4x6', '6x6'].includes(v)) v = null;
    if (k === 'garage_panel' && !['standard', 'carriage'].includes(v)) v = null;
    if (['garage_windows', 'insulated', 'slanted_corners', 'no_corner_trim', 'trim_frame'].includes(k)) v = v === true || v === 1 || v === '1' || v === 'on' || v === 'true' ? 1 : 0;   // on/off flags: only ever 0 or 1
    if (['skid_count', 'skid_spacing', 'overhang_right', 'gable_overhang', 'roof_pitch_lower', 'roof_pitch_back', 'gambrel_break', 'gambrel_lower_len', 'gambrel_upper_len', 'hip_len', 'upper_len', 'fascia_size', 'rake_size', 'metal_rake_size', 'metal_rake_leg', 'rake_cap_size', 'drip_edge_size', 'corner_trim', 'casing_trim'].includes(k) && (v === '' || v === undefined)) v = null;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (v === '') v = null;
    out[k] = v;
  }
  return out;
}
for (const table of Object.keys(TABLES)) {
  v1.get(`/${table}`, (req, res) => {
    const filt = table === 'sizes' && req.query.style_id ? ' WHERE style_id = ?' : '';
    const order = table === 'webhooks' ? 'id' : (table === 'sizes' ? 'style_id, sort, width, depth' : 'sort, id');
    res.json(all(`SELECT * FROM ${table}${filt} ORDER BY ${order}`, ...(filt ? [Number(req.query.style_id) || 0] : [])));
  });
  v1.get(`/${table}/:id`, (req, res) => {
    const r = get(`SELECT * FROM ${table} WHERE id = ?`, Number(req.params.id));
    r ? res.json(r) : bad(res, 'Not found', 404);
  });
  v1.post(`/${table}`, wrap(async (req, res) => {
    const d = clean(table, req.body);
    if (table === 'webhooks' && !/^https?:\/\//.test(d.url || '')) return bad(res, 'url must start with http(s)://');
    if (table === 'webhooks') { const why = await blockedTarget(d.url); if (why) return bad(res, `That webhook address ${why}.`); }
    const keys = Object.keys(d);
    if (!keys.length) return bad(res, 'No valid fields');
    try {
      const r = run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => d[k]));
      res.status(201).json(get(`SELECT * FROM ${table} WHERE id = ?`, Number(r.lastInsertRowid)));
    } catch (e) { bad(res, e.message); }
  }));
  const upd = wrap(async (req, res) => {
    const d = clean(table, req.body), keys = Object.keys(d);
    if (!keys.length) return bad(res, 'No valid fields');
    if (table === 'webhooks' && 'url' in d) { const why = await blockedTarget(String(d.url || '')); if (why) return bad(res, `That webhook address ${why}.`); }
    try {
      run(`UPDATE ${table} SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...keys.map(k => d[k]), Number(req.params.id));
      res.json(get(`SELECT * FROM ${table} WHERE id = ?`, Number(req.params.id)));
    } catch (e) { bad(res, e.message); }
  });
  v1.patch(`/${table}/:id`, upd);
  v1.put(`/${table}/:id`, upd);
  v1.delete(`/${table}/:id`, (req, res) => { run(`DELETE FROM ${table} WHERE id = ?`, Number(req.params.id)); res.sendStatus(204); });
}
v1.post('/webhooks/:id/test', wrap(async (req, res) => {
  const h = get('SELECT * FROM webhooks WHERE id = ?', Number(req.params.id));
  if (!h) return bad(res, 'Not found', 404);
  const q = get('SELECT * FROM quotes ORDER BY id DESC LIMIT 1');
  const data = q ? formatQuote(q, baseUrl(req)) : { note: 'No quotes yet — this is a test delivery.' };
  const r = await deliver({ ...h, url: h.url }, 'test', data);
  res.json({ status: r.status, ok: r.ok, response: (r.text || '').slice(0, 500) });
}));
app.use('/api/v1', v1);

// =============================================================================
//  ADMIN-ONLY (session)
// =============================================================================
// login attempts are limited per email (stops password guessing) and loosely per IP (a whole lot shares one IP);
// 20 failed tries in 15 minutes locks that account for a while, whatever IP they come from
const loginPerEmail = rateLimit(10, 60000, req => 'login:' + String(req.body?.email || '').toLowerCase().trim());
const loginPerIp = rateLimit(60, 60000, req => 'loginip:' + req.ip);
const failedLogins = new Map();
app.post('/api/auth/login', loginPerIp, loginPerEmail, (req, res) => {
  const { email, password } = req.body || {};
  const em = String(email || '').toLowerCase().trim().slice(0, 200), now = Date.now();
  const fails = (failedLogins.get(em) || []).filter(t => now - t < 15 * 60000);
  if (fails.length >= 20) return bad(res, 'Too many failed logins for this account. Try again in 15 minutes.', 429);
  const u = get('SELECT * FROM users WHERE email = ?', em);
  const ok = verifyPassword(String(password || '').slice(0, 1000), u?.password_hash) && !!u; // hashed even for unknown emails (same timing)
  if (!ok) { fails.push(now); failedLogins.set(em, fails); if (failedLogins.size > 5000) failedLogins.clear(); return bad(res, 'Wrong email or password', 401); }
  failedLogins.delete(em);
  if (u.active === 0) return bad(res, 'This login has been turned off. Ask your admin.', 403);
  issueSession(res, u.id, req);
  res.json({ ...meInfo({ id: u.id, email: u.email, name: u.name, role: u.role || 'admin', dealer_id: u.dealer_id || null, devops: !!u.is_devops }), default_password: String(password) === 'changeme123' });
});
app.post('/api/auth/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => {
  const u = readSession(req); if (!u) return bad(res, 'Not logged in', 401);
  const row = get('SELECT password_hash FROM users WHERE id = ?', u.id);
  res.json({ ...meInfo(u), default_password: verifyPassword('changeme123', row?.password_hash) }); // dashboard warning
});

const admin = express.Router();
admin.use(requireSession);
// Non-admin roles may only read the catalog/settings (to draw sheds) and manage their own login
admin.use((req, res, next) => {
  if (req.user.role === 'admin') return next();
  const open = (req.method === 'GET' && ['/catalog', '/settings', '/modules'].includes(req.path)) || (req.method === 'POST' && ['/account', '/account/sign-out-others'].includes(req.path));
  return open ? next() : res.status(403).json({ error: 'Your account does not have access to this.' });
});
admin.post('/account', (req, res) => {
  const { email, name, current_password, new_password, phone, notify_sms, notify_email } = req.body || {};
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  // alert preferences + phone can be changed without re-entering the password
  if (phone !== undefined || notify_sms !== undefined || notify_email !== undefined) {
    if (phone && !toE164(phone)) return bad(res, 'Mobile number looks invalid');
    run('UPDATE users SET phone = ?, notify_sms = ?, notify_email = ? WHERE id = ?', phone === undefined ? u.phone : (phone || null),
      notify_sms === undefined ? u.notify_sms : (notify_sms ? 1 : 0), notify_email === undefined ? u.notify_email : (notify_email ? 1 : 0), u.id);
    if (!current_password && !new_password && !email && !name) return res.json({ ok: true });
  }
  if (!verifyPassword(String(current_password || ''), u.password_hash)) return bad(res, 'Current password is wrong');
  if (new_password && String(new_password).length < 8) return bad(res, 'New password must be at least 8 characters');
  const newEmail = email ? String(email).toLowerCase().trim() : null;
  if (newEmail && !/^\S+@\S+\.\S+$/.test(newEmail)) return bad(res, 'Email looks invalid');
  if (newEmail && get('SELECT id FROM users WHERE email = ? AND id != ?', newEmail, u.id)) return bad(res, 'That email is already used by another login');
  run('UPDATE users SET email = COALESCE(?, email), name = COALESCE(?, name), password_hash = ? WHERE id = ?',
    newEmail, name ? String(name).slice(0, 120) : null, new_password ? hashPassword(String(new_password)) : u.password_hash, u.id);
  // a new password signs this login out on every other device; this one gets a fresh cookie
  if (new_password) { endSessions(u.id); issueSession(res, u.id); }
  res.json({ ok: true });
});
// "Sign out everywhere else" (lost phone, shared tablet)
admin.post('/account/sign-out-others', (req, res) => { endSessions(req.user.id); issueSession(res, req.user.id); res.json({ ok: true });
});
// the developer login is invisible to (and can't be changed by) the customer's own admins
const devopsRow = id => get('SELECT id FROM users WHERE id = ? AND COALESCE(is_devops, 0) = 1', Number(id));
admin.get('/users', (req, res) => res.json(all(`SELECT id, email, name, phone, COALESCE(role, 'admin') AS role, dealer_id, COALESCE(active, 1) AS active, COALESCE(is_devops, 0) AS devops, created_at FROM users ${req.user.devops ? '' : 'WHERE COALESCE(is_devops, 0) = 0'}`)));
// ---- System & backups (same people who can switch modules)
// Combine duplicate paints: colors with the same name and hex code (e.g. "Arctic White" entered once for siding and
// again for trim) become one paint used in all those places. Quotes and style defaults that pointed at a duplicate
// are repointed to the kept one. Roof colors are left alone (they're roofing, not paint).
function combineDuplicateColors() {
  const cats = ['siding', 'trim', 'door', 'window'];
  const rows = all('SELECT * FROM colors ORDER BY id');
  const js = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };   // all() already parses JSON columns
  const uses = r => { const u = js(r.uses); return Array.isArray(u) && u.length ? u : [r.category]; };
  const groups = new Map();
  for (const r of rows) {
    const u = uses(r); if (u.includes('roof') || !u.every(x => cats.includes(x))) continue;
    const key = String(r.name).trim().toLowerCase() + '|' + String(r.hex).trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r);
  }
  const remap = new Map(); let combined = 0;
  db.exec('BEGIN');
  try {
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const keep = g[0], all_ = [...new Set(g.flatMap(uses))].sort((a, b) => cats.indexOf(a) - cats.indexOf(b));
      // keep the first one's price/sort; available if any of them was
      run('UPDATE colors SET uses = ?, active = ? WHERE id = ?', JSON.stringify(all_), g.some(r => r.active !== 0) ? 1 : 0, keep.id);
      for (const r of g.slice(1)) { remap.set(r.id, keep.id); run('DELETE FROM colors WHERE id = ?', r.id); combined++; }
    }
    if (remap.size) {
      const fix = obj => { let ch = false; for (const k of Object.keys(obj || {})) { const n = remap.get(Number(obj[k])); if (n) { obj[k] = n; ch = true; } } return ch; };
      for (const st of all('SELECT id, default_colors FROM styles')) {
        const d = js(st.default_colors); if (!d || typeof d !== 'object') continue;
        if (fix(d)) run('UPDATE styles SET default_colors = ? WHERE id = ?', JSON.stringify(d), st.id);
      }
      for (const q of all('SELECT id, config FROM quotes')) {
        const c = js(q.config); if (!c || typeof c !== 'object') continue;
        if (fix(c.colors)) run('UPDATE quotes SET config = ? WHERE id = ?', JSON.stringify(c), q.id);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { combined, paints: [...groups.values()].filter(g => g.length > 1).length };
}
admin.post('/colors/combine', (req, res) => res.json(combineDuplicateColors()));
admin.get('/system', (req, res) => {
  if (!canManageModules(req.user)) return bad(res, 'Only the developer login can see this.', 403);
  const o = offsite();
  res.json({ version: APP_VERSION, schema: DB_SCHEMA, schema_code: SCHEMA_VERSION, node: process.version, uptime_s: Math.round(process.uptime()),
    backups: listBackups(), last: getSettings()._backup_last || null, restored: getSettings()._restored || null, pre_update: PRE_UPDATE.file ? { name: PRE_UPDATE.file.split(/[\\/]/).pop(), from: PRE_UPDATE.from } : null,
    offsite: offsiteOn() ? { on: true, endpoint: o.endpoint.replace(/^https?:\/\//, ''), bucket: o.bucket, prefix: o.prefix || null } : { on: false },
    schedule: process.env.BACKUP_DISABLED === '1' ? 'off' : `daily at ${process.env.BACKUP_HOUR || 3}:00 (${getSettings().timezone || 'America/Chicago'}) and before every update`, dir: BACKUP_DIR });
});
admin.post('/system/backup', wrap(async (req, res) => {
  if (!canManageModules(req.user)) return bad(res, 'Only the developer login can do this.', 403);
  const r = await backupNow('manual');
  r.error && !r.size ? bad(res, 'Backup failed: ' + r.error, 500) : res.json(r);
}));
// Restore: upload a backup (full .tar.gz or database .db), it's checked, a safety backup of what's here now is made,
// then the app restarts and swaps the backup in before the database opens. Moves a company to a new install.
const restoreUpload = multer({ storage: multer.diskStorage({ destination: (req, f, cb) => { try { mkdirSync(BACKUP_DIR, { recursive: true }); cb(null, BACKUP_DIR); } catch (e) { cb(e); } }, filename: (req, f, cb) => cb(null, `.incoming-${crypto.randomBytes(8).toString('hex')}`) }),
  limits: { fileSize: (Number(process.env.RESTORE_MAX_MB) || 2048) * 1024 * 1024, files: 1, fields: 2 } });
admin.post('/system/restore', (req, res, next) => (canManageModules(req.user) ? next() : bad(res, 'Only the developer login can restore backups.', 403)), restoreUpload.single('backup'), wrap(async (req, res) => {
  const tmp = req.file?.path;
  try {
    if (!tmp) return bad(res, 'Choose a backup file.');
    if (String(req.body?.confirm || '').trim().toUpperCase() !== 'RESTORE') return bad(res, 'Type RESTORE to confirm.');
    let info;
    try { info = await stageRestore(tmp, req.file.originalname, req.user.email); } catch (e) { return bad(res, e.message); }
    const safety = await backupNow('before restore');
    if (safety.error && !safety.size) { cancelRestore(); return bad(res, 'Could not back up this install first, so nothing was restored: ' + safety.error, 500); }
    res.json({ ok: true, restarting: true, restored: info, safety_backup: safety.name });
    console.log(`  Restoring ${req.file.originalname} (from ${info.company || 'unknown company'}): restarting to swap it in.`);
    // restart: the hosting platform starts the app again (Railway's restart policy restarts on a non-zero exit)
    setTimeout(() => {
      const stop = () => { try { db.close(); } catch { /* */ } process.exit(3); };
      server.close(stop); setTimeout(stop, 3000); // open live-update streams never close on their own
    }, 300);
  } finally { if (tmp) rmSync(tmp, { force: true }); }
}));
admin.get('/system/backups/:name', (req, res) => {
  if (!canManageModules(req.user)) return bad(res, 'Only the developer login can download backups.', 403);
  const name = String(req.params.name); if (!NAME_RE.test(name) || name.includes('..')) return bad(res, 'Not found', 404);
  res.download(join(BACKUP_DIR, name), name, err => { if (err && !res.headersSent) bad(res, 'Not found', 404); });
});
admin.get('/modules', (req, res) => res.json({ modules: MODS, list: MODULES, can_manage: canManageModules(req.user), developer_login: hasDevops() }));
admin.put('/modules', (req, res) => {
  if (!canManageModules(req.user)) return bad(res, 'Only the developer login can change modules.', 403);
  const next = normalizeModules(req.body || {}, MODS);
  setSettings({ modules: next }); MODS = next;
  broadcast('modules', { modules: MODS }); // open admin pages reload with the new menus
  res.json({ modules: MODS });
});
admin.post('/users', (req, res) => {
  const { email, name, password, role = 'admin', dealer_id = null, phone = null } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return bad(res, 'A valid email and an 8+ character password are required');
  if (!ROLES.includes(role)) return bad(res, 'Unknown role');
  if (!roleUsable(role, MODS)) return bad(res, `${role[0].toUpperCase() + role.slice(1)} logins need the Production & delivery module.`);
  if (phone && !toE164(phone)) return bad(res, 'Mobile number looks invalid');
  try { run('INSERT INTO users (email, name, password_hash, role, dealer_id, phone) VALUES (?,?,?,?,?,?)', email.toLowerCase().trim(), String(name || '').slice(0, 120), hashPassword(password), role, role === 'admin' ? null : (dealer_id == null || dealer_id === '' ? null : String(dealer_id)), phone || null); res.json({ ok: true }); }
  catch { bad(res, 'That email already exists'); }
});
admin.patch('/users/:id', (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id)); if (!u || (u.is_devops && !req.user.devops)) return bad(res, 'Not found', 404);
  const { role, dealer_id, name, password, phone, active } = req.body || {};
  if (role && !ROLES.includes(role)) return bad(res, 'Unknown role');
  if (role && role !== u.role && !roleUsable(role, MODS)) return bad(res, `${role[0].toUpperCase() + role.slice(1)} logins need the Production & delivery module.`);
  if (u.is_devops && role && role !== 'admin') return bad(res, 'The developer login is always an admin.');
  if (u.id === req.user.id && role && role !== 'admin') return bad(res, "You can't remove your own admin access");
  if (u.id === req.user.id && active === false) return bad(res, "You can't turn off your own login");
  if (password && String(password).length < 8) return bad(res, 'Password must be at least 8 characters');
  if (phone && !toE164(phone)) return bad(res, 'Mobile number looks invalid');
  const r = role || u.role || 'admin';
  const wasActive = u.active ?? 1;
  const signOut = !!password || (role && role !== (u.role || 'admin')) || (active === false && wasActive) || (dealer_id !== undefined && (dealer_id || null) !== (u.dealer_id || null));
  run('UPDATE users SET role = ?, dealer_id = ?, name = COALESCE(?, name), password_hash = ?, phone = ?, active = ? WHERE id = ?',
    r, r === 'admin' ? null : (dealer_id === undefined ? u.dealer_id : (dealer_id || null)), name == null ? null : String(name).slice(0, 120), password ? hashPassword(String(password)) : u.password_hash,
    phone === undefined ? u.phone : (phone || null), active === undefined ? (u.active ?? 1) : (active ? 1 : 0), u.id);
  if (signOut) { endSessions(u.id); if (u.id === req.user.id) issueSession(res, u.id); } // their open sessions end now (yours gets a fresh cookie)
  res.json({ ok: true });
});
admin.delete('/users/:id', (req, res) => {
  if (Number(req.params.id) === req.user.id) return bad(res, "You can't delete yourself");
  if (devopsRow(req.params.id) && !req.user.devops) return bad(res, 'Not found', 404);
  run('DELETE FROM users WHERE id = ?', Number(req.params.id)); res.sendStatus(204);
});
const SECRET_SETTINGS = ['ghl_token', 'twilio_token', 'smtp_pass', 'email_api_key'];
admin.get('/settings', (req, res) => {
  const s = getSettings(); delete s._session_secret;
  for (const k of SECRET_SETTINGS) { if (s[k]) s[k + '_set'] = true; s[k] = s[k] ? '••••••••' + String(s[k]).slice(-4) : ''; }
  // other roles read settings only to draw and price sheds: no integration setup (GHL, email, texts, webhooks, backups)
  if (req.user.role !== 'admin') { for (const k of Object.keys(s)) if (SECRET_SETTINGS.includes(k) || /^(ghl_|smtp_|twilio_|email_api|webhook|inbound|backup|zapier|api_)/.test(k)) delete s[k]; }
  res.json(s);
});
admin.put('/settings', wrap(async (req, res) => {
  const b = { ...(req.body || {}) };
  for (const k of Object.keys(b)) if (/^(__proto__|constructor|prototype)$/.test(k) || k.startsWith('_')) delete b[k];
  delete b._session_secret; delete b.inbound_key; delete b.crm_backfilled; delete b.sample_templates_seeded; delete b.modules; // modules: developer login only
  for (const k of SECRET_SETTINGS) { delete b[k + '_set']; if (typeof b[k] === 'string' && b[k].startsWith('••••')) delete b[k]; } // unchanged
  for (const k of ['tax_rate', 'delivery_fee']) if (k in b) b[k] = Number(b[k]) || 0;
  for (const k of Object.keys(b)) if (k.startsWith('migr_')) delete b[k]; // one-time upgrade markers
  // pasted credentials often carry spaces; phone numbers get stored as +1XXXXXXXXXX
  for (const k of ['twilio_sid', 'twilio_token', 'twilio_messaging_service_sid', 'smtp_host', 'smtp_user', 'email_api_key', 'email_from', 'email_reply_to', 'public_url']) if (typeof b[k] === 'string') b[k] = b[k].trim();
  if (typeof b.smtp_pass === 'string' && !/\S\s\S/.test(b.smtp_pass.trim())) b.smtp_pass = b.smtp_pass.trim();
  if (typeof b.smtp_pass === 'string' && /^([a-z]{4} ){3}[a-z]{4}$/.test(b.smtp_pass.trim())) b.smtp_pass = b.smtp_pass.replace(/ /g, ''); // Google app passwords are shown with spaces
  if (b.twilio_from) { const e = toE164(b.twilio_from); if (!e) return bad(res, 'The Twilio phone number looks wrong. Enter it like (615) 555-0123 or +16155550123.'); b.twilio_from = e; }
  if (b.notify_phones) { const bad1 = String(b.notify_phones).split(/[,;]+/).map(x => x.trim()).filter(x => x && !toE164(x)); if (bad1.length) return bad(res, `These alert numbers look wrong: ${bad1.join(', ')}`); }
  if (b.email_from && !/@/.test(b.email_from)) return bad(res, 'The From address needs an email, like sales@yourcompany.com or "Trimline Barns" <sales@yourcompany.com>.');
  if ('smtp_port' in b) b.smtp_port = Number(b.smtp_port) || '';
  if (b.ghl_inbound_webhook_url) { const why = await blockedTarget(String(b.ghl_inbound_webhook_url)); if (why) return bad(res, `The GoHighLevel inbound webhook URL ${why}.`); }
  if (b.public_url) { b.public_url = String(b.public_url).replace(/\/+$/, ''); if (!/^https?:\/\/[^/\s]+$/.test(b.public_url)) return bad(res, 'Public URL should look like https://builder.yourcompany.com (no page path at the end).'); }
  setSettings(b); res.json({ ok: true });
}));
admin.get('/ghl/lookup', wrap(async (req, res) => res.json({ ...(await ghlLookup()), values: GHL_VALUES })));
admin.post('/ghl/test', wrap(async (req, res) => {
  const q = get('SELECT * FROM quotes ORDER BY id DESC LIMIT 1');
  if (!q) return bad(res, 'Submit at least one quote first (use the configurator), then test.');
  try { const r = await pushToGHL(q, formatQuote(q, baseUrl(req))); res.json({ ok: true, ...r }); }
  catch (e) { bad(res, e.message); }
}));
admin.get('/catalog', (req, res) => res.json(getCatalog({ includeInactive: true })));
// Messaging setup helpers: status overview, "Check connection" (no message sent), connect Twilio replies automatically
const hookUrls = req => { const b = baseUrl(req), k = getSettings().inbound_key || ''; return { twilio: b + '/api/hooks/twilio/sms', email: `${b}/api/hooks/email/${k}`, ghl: `${b}/api/hooks/ghl/${k}`, https: /^https:\/\//.test(b), public_url_set: !!getSettings().public_url }; };
admin.get('/messaging/status', (req, res) => {
  const s = getSettings();
  const last = (channel, dir) => get(`SELECT id, to_addr, from_addr, status, error, created_at FROM messages WHERE channel = ? AND direction = ? ORDER BY id DESC LIMIT 1`, channel, dir) || null;
  res.json({
    ...messagingStatus(), from: fromAddress(s), hooks: hookUrls(req),
    last_sms: last('sms', 'out'), last_email: last('email', 'out'), last_sms_in: last('sms', 'in'), last_email_in: last('email', 'in'),
    inbound_last_ok: s.inbound_last_ok || null, inbound_last_error: s.inbound_last_error || null,
    recent: all(`SELECT m.id, m.channel, m.direction, m.to_addr, m.from_addr, m.subject, substr(m.body, 1, 140) body, m.status, m.error, m.created_at, c.first_name, c.last_name
      FROM messages m LEFT JOIN contacts c ON c.id = m.contact_id ORDER BY m.id DESC LIMIT 25`),
  });
});
admin.post('/messaging/verify', wrap(async (req, res) => {
  const channel = req.body?.channel === 'email' ? 'email' : 'sms';
  res.json(await verifyMessaging(channel, { webhookUrl: hookUrls(req).twilio }));
}));
admin.post('/messaging/twilio-connect', wrap(async (req, res) => {
  try { res.json(await connectTwilioReplies(hookUrls(req).twilio)); } catch (e) { bad(res, e.message); }
}));
admin.post('/messaging/clear-inbound-error', (req, res) => { setSettings({ inbound_last_error: null }); res.json({ ok: true }); });
admin.post('/messaging/test', wrap(async (req, res) => {
  const { channel, to } = req.body || {};
  const company = getSettings().company_name || '3D Shed Builder';
  const r = channel === 'email'
    ? await sendEmail({ to, subject: `Test email from ${company}`, text: `This is a test email from your shed builder.\n\nIf you got this, email is set up correctly.` })
    : await sendSMS({ to, body: `Test text from ${company}: texting is set up correctly.`, baseUrl: baseUrl(req) });
  r.ok ? res.json(r) : bad(res, r.error || 'Not sent', 502);
}));
admin.get('/api-keys', (req, res) => res.json(all('SELECT id, name, prefix, last_used, created_at FROM api_keys ORDER BY id DESC')));
admin.post('/api-keys', (req, res) => res.json(createApiKey(req.body?.name)));
admin.delete('/api-keys/:id', (req, res) => { run('DELETE FROM api_keys WHERE id = ?', Number(req.params.id)); res.sendStatus(204); });
admin.get('/webhook-log', (req, res) => res.json(recentLog(150)));
admin.get('/events', (req, res) => res.json(EVENTS));
admin.get('/stats', (req, res) => {
  res.json({
    total: get('SELECT COUNT(*) n FROM quotes').n,
    last30: get("SELECT COUNT(*) n FROM quotes WHERE created_at >= datetime('now','-30 days')").n,
    value30: get("SELECT COALESCE(SUM(total),0) v FROM quotes WHERE created_at >= datetime('now','-30 days')").v,
    byStatus: all('SELECT status, COUNT(*) n FROM quotes GROUP BY status'),
    byStyle: all('SELECT style_name, COUNT(*) n, ROUND(AVG(total)) avg FROM quotes GROUP BY style_name ORDER BY n DESC'),
    daily: all("SELECT date(created_at) d, COUNT(*) n FROM quotes WHERE created_at >= datetime('now','-30 days') GROUP BY d ORDER BY d"),
  });
});
// Dashboard reports: one row per local day with leads, quotes and signed sales (client groups by month/year, MTD/YTD, YoY)
admin.get('/reports', (req, res) => {
  const tz = getSettings().timezone || 'America/Chicago';
  const days = dailyReport({
    contacts: all('SELECT created_at, source, dealer_id FROM contacts'),
    quotes: all('SELECT created_at, total, dealer_id FROM quotes'),
    contracts: all('SELECT id, group_id, revision, status, sale_type, total, completed_at, dealer_id FROM contracts'),
    tz, dealer: String(req.query.dealer || ''),
  });
  res.json({ tz, today: localDay(new Date().toISOString(), tz), days, dealers: (getSettings().dealers || []).map(d => ({ id: d.id, name: d.name })) });
});
admin.post('/duplicate/:table/:id', (req, res) => {
  const t = req.params.table;
  if (!['styles', 'options', 'colors'].includes(t)) return bad(res, 'Cannot duplicate that');
  const row = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(Number(req.params.id));
  if (!row) return bad(res, 'Not found', 404);
  delete row.id; row.name = row.name + ' (copy)';
  const keys = Object.keys(row);
  const id = Number(run(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => row[k])).lastInsertRowid);
  if (t === 'styles') for (const z of db.prepare('SELECT * FROM sizes WHERE style_id = ?').all(Number(req.params.id)))
    run('INSERT INTO sizes (style_id, width, depth, price, active, sort, hip_len, upper_len, skid_count, skid_spacing, skid_size) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, z.width, z.depth, z.price, z.active, z.sort, z.hip_len ?? null, z.upper_len ?? null, z.skid_count ?? null, z.skid_spacing ?? null, z.skid_size ?? null);
  // options limited to the original style (e.g. coop parts) are offered on the copy too
  if (t === 'styles') for (const o of db.prepare('SELECT id, only_styles FROM options WHERE only_styles IS NOT NULL').all()) {
    let list; try { list = JSON.parse(o.only_styles); } catch { continue; }
    if (Array.isArray(list) && list.map(Number).includes(Number(req.params.id))) run('UPDATE options SET only_styles = ? WHERE id = ?', JSON.stringify([...list, id]), o.id);
  }
  res.json({ id });
});
admin.put('/styles/:id/sizes', (req, res) => {
  // Replace the full size list of a style in one go (used by the admin size grid)
  const sid = Number(req.params.id);
  const keep = [];
  for (const [i, z] of (req.body || []).entries()) {
    const w = Number(z.width), d = Number(z.depth);
    if (!w || !d) continue;
    const on = !(z.active === false || z.active === 0 || z.active === '0');
    const len = v => (Number(v) > 0 ? Number(v) : null);
    const lum = ['4x4', '4x6', '6x6'].includes(z.skid_size) ? z.skid_size : null;
    const cnt = Number(z.skid_count) >= 1 ? Math.min(12, Math.round(Number(z.skid_count))) : null, sp = Number(z.skid_spacing) > 0 ? Math.min(240, Number(z.skid_spacing)) : null;
    if (z.id && get('SELECT id FROM sizes WHERE id=? AND style_id=?', Number(z.id), sid)) { run('UPDATE sizes SET width=?, depth=?, price=?, active=?, sort=?, hip_len=?, upper_len=?, skid_count=?, skid_spacing=?, skid_size=? WHERE id=? AND style_id=?', w, d, Number(z.price) || 0, on ? 1 : 0, i, len(z.hip_len), len(z.upper_len), cnt, sp, lum, Number(z.id), sid); keep.push(Number(z.id)); }
    else keep.push(Number(run('INSERT INTO sizes (style_id, width, depth, price, active, sort, hip_len, upper_len, skid_count, skid_spacing, skid_size) VALUES (?,?,?,?,?,?,?,?,?,?,?)', sid, w, d, Number(z.price) || 0, on ? 1 : 0, i, len(z.hip_len), len(z.upper_len), cnt, sp, lum).lastInsertRowid));
  }
  run(`DELETE FROM sizes WHERE style_id = ? ${keep.length ? `AND id NOT IN (${keep.join(',')})` : ''}`, sid);
  res.json(all('SELECT * FROM sizes WHERE style_id = ? ORDER BY sort', sid));
});

// ---- File uploads (3D models + images)
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /\.(glb|gltf|png|jpe?g|webp|svg)$/i.test(file.originalname)),
});
admin.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return bad(res, 'Upload a .glb model or an image (png/jpg/webp/svg)');
  // a renamed or broken file would upload fine and then silently not show in 3D: check what's really inside
  const head = Buffer.alloc(12); try { const fd = openSync(req.file.path, 'r'); readSync(fd, head, 0, 12, 0); closeSync(fd); } catch { /* empty file */ }
  const ext = extname(req.file.originalname).toLowerCase();
  const okType = ext === '.glb' ? head.toString('latin1', 0, 4) === 'glTF'
    : ext === '.gltf' ? (() => { try { return !!JSON.parse(readFileSync(req.file.path, 'utf8')).asset; } catch { return false; } })()
    : ext === '.png' ? head.readUInt32BE(0) === 0x89504e47
    : ext === '.jpg' || ext === '.jpeg' ? head[0] === 0xff && head[1] === 0xd8
    : ext === '.webp' ? head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP'
    : ext === '.svg' ? /<svg[\s>]/i.test(readFileSync(req.file.path, 'utf8').slice(0, 4000)) : false;
  if (!okType) { try { unlinkSync(req.file.path); } catch { /* */ } return bad(res, ext === '.glb' || ext === '.gltf' ? `"${req.file.originalname}" isn't a valid 3D model. Export it from your 3D program as glTF Binary (.glb) and upload it again.` : `"${req.file.originalname}" isn't a valid ${ext.slice(1).toUpperCase()} image.`); }
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname, size: req.file.size });
});
admin.delete('/upload', (req, res) => {
  const f = String(req.query.url || '').replace(/^\/uploads\//, '');
  if (!f || f.includes('/') || f.includes('..')) return bad(res, 'Bad path');
  try { unlinkSync(join(UPLOAD_DIR, f)); } catch { /* ignore */ }
  res.sendStatus(204);
});
app.use('/api/admin', admin);

// =============================================================================
//  CRM · POINT OF SALE · E-SIGN · INBOUND MESSAGE WEBHOOKS
// =============================================================================
app.use('/api/crm', crmRouter({ baseUrl }));
app.use('/api/pos', posRouter({ baseUrl }));
app.use('/api/sign', rateLimit(60, 60000), signRouter());
app.use('/api/hooks', hooksRouter({ baseUrl }));
app.get('/sign/:token', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(join(__dirname, 'public', 'sign.html')); });

// =============================================================================
//  STATIC
// =============================================================================
// Uploaded images/models are served from this site, so an SVG with a script in it must not run here
app.use('/uploads', (req, res, next) => { res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"); res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); next(); },
  express.static(UPLOAD_DIR, { maxAge: '7d', dotfiles: 'deny', index: false }));
app.get('/docs', (req, res) => res.sendFile(join(__dirname, 'public', 'docs.html')));
app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  // malformed JSON / too-large bodies are the client's fault, not a server error
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  console.error(err);
  // in production don't hand internal details (database errors, file paths) to whoever caused them
  const hide = process.env.NODE_ENV === 'production' && !err.expose;
  res.status(err.status >= 400 && err.status < 500 ? err.status : 500).json({ error: hide ? 'Something went wrong on our side. Please try again, or contact support if it keeps happening.' : (err.message || 'Server error') });
});

const server = app.listen(PORT, () => {
  setSettings({ _app_version: APP_VERSION.id }); // started fine on this version (the next different one backs up first)
  startBackups();
  console.log(`\n  3D Shed Builder ${APP_VERSION.id} running on http://localhost:${PORT}`);
  console.log(`  Configurator:  http://localhost:${PORT}/`);
  console.log(`  Admin:         http://localhost:${PORT}/admin/`);
  console.log(`  API docs:      http://localhost:${PORT}/docs\n`);
});

// Redeploys stop the old copy with SIGTERM: finish open requests, then close the database cleanly (no half-written data).
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  if (stopping) return; stopping = true;
  console.log(`  ${sig}: shutting down…`);
  const done = () => { try { db.close(); } catch { /* already closed */ } process.exit(0); };
  server.close(done);
  setTimeout(done, 8000).unref(); // live-update streams never end on their own
});
