// Outbound integrations: generic signed webhooks + native GoHighLevel (LeadConnector API v2).
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { all, get, run, getSettings } from './db.js';
import { formatQuote } from '../public/js/shared/quote-format.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { buildQuotePdf } from './quote-pdf.js';

export const EVENTS = ['quote.created', 'quote.updated', 'quote.status_changed', 'test'];

export { formatQuote };

function log(webhook_id, target, event, status, ok, attempt, response) {
  run('INSERT INTO webhook_log (webhook_id, target, event, status, ok, attempt, response) VALUES (?,?,?,?,?,?,?)',
    webhook_id, target, event, status, ok ? 1 : 0, attempt, String(response ?? '').slice(0, 2000));
  run('DELETE FROM webhook_log WHERE id NOT IN (SELECT id FROM webhook_log ORDER BY id DESC LIMIT 1000)');
}

// ---- Outgoing requests may only go to the public internet: a webhook pointed at this server's own network
// (localhost, 10.x, 169.254.169.254 cloud metadata, *.railway.internal…) is refused, and redirects aren't followed.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = String(ip).toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('ff');
}
const allowPrivate = () => ['1', 'true'].includes(String(process.env.ALLOW_PRIVATE_WEBHOOKS || '').toLowerCase());
export const isPrivateIp = ip => privateIp(ip);
/** Quick check without a DNS lookup (used when saving a webhook): '' when fine, otherwise the reason. */
export function checkOutboundUrl(raw) {
  let u; try { u = new URL(String(raw || '')); } catch { return 'url must be a full http(s):// address'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'url must start with http(s)://';
  if (u.username || u.password) return 'url must not contain a username or password (use the headers field instead)';
  if (allowPrivate()) return '';
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host) || (!host.includes('.') && !net.isIP(host))) return 'url must be a public internet address';
  if (net.isIP(host) && privateIp(host)) return 'url must be a public internet address';
  return '';
}
/** Returns a reason when this URL may not be called, or null when it's fine. */
export async function blockedTarget(url) {
  let u; try { u = new URL(url); } catch { return 'is not a valid web address'; }
  if (!/^https?:$/.test(u.protocol)) return 'must start with http:// or https://';
  if (u.username || u.password) return 'must not contain a username or password';
  if (allowPrivate()) return null; // tests / self-hosted setups that need it
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return 'points at a private address';
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(a => a.address);
  if (!addrs.length) return "can't be found (check the address)";
  if (addrs.some(privateIp)) return 'points at a private or internal address';
  return null;
}

async function postJSON(url, body, headers = {}, timeoutMs = 10000) {
  const why = await blockedTarget(url);
  if (why) return { status: 0, ok: false, text: `Blocked: the address ${why}.` };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal: ctrl.signal, redirect: 'manual' });
    const text = r.status >= 300 && r.status < 400 ? `Not followed: redirected to ${r.headers.get('location') || 'another address'}` : await r.text();
    return { status: r.status, ok: r.ok, text };
  } catch (e) {
    return { status: 0, ok: false, text: e.message, blocked: String(e.message).startsWith('Blocked') };
  } finally { clearTimeout(t); }
}

/** Deliver one webhook with signature + retries (1s, 5s, 25s). */
export async function deliver(hook, event, data) {
  const payload = JSON.stringify({ event, delivery_id: crypto.randomUUID(), sent_at: new Date().toISOString(), data });
  const headers = { 'User-Agent': 'ShedBuilder-Webhooks/1.0', 'X-ShedBuilder-Event': event };
  if (hook.secret) headers['X-ShedBuilder-Signature'] = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(payload).digest('hex');
  for (const [k, v] of Object.entries(hook.headers && typeof hook.headers === 'object' ? hook.headers : {}))
    if (/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/i.test(k) && !/[\r\n]/.test(String(v))) headers[k] = String(v);
  const delays = [0, 1000, 5000, 25000];
  let last;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    last = await postJSON(hook.url, payload, headers);
    log(hook.id || null, hook.url, event, last.status, last.ok, i + 1, last.text);
    if (last.ok || (last.status >= 300 && last.status < 500 && last.status !== 429) || /^Blocked:/.test(last.text)) break;
  }
  return last;
}

/** Fire an event to every subscribed webhook + GHL. Runs in the background. */
export function emit(event, quoteRow, baseUrl) {
  const data = formatQuote(quoteRow, baseUrl);
  const hooks = all('SELECT * FROM webhooks WHERE active = 1');
  for (const h of hooks) {
    const evs = Array.isArray(h.events) ? h.events : [];
    if (evs.includes(event) || evs.includes('*')) deliver(h, event, data).catch(() => {});
  }
  const s = getSettings();
  if (s.ghl_inbound_webhook_url && (event === 'quote.created' || s.ghl_send_updates)) {
    deliver({ id: null, url: s.ghl_inbound_webhook_url, headers: {} }, event, flatForGHL(data)).catch(() => {});
  }
  if (event === 'quote.created' && s.ghl_enabled && s.ghl_token && s.ghl_location_id) {
    ghlPushes.set(quoteRow.id, pushToGHL(quoteRow, data).catch(e => { log(null, 'GHL API', event, 0, false, 1, e.message); return null; }));
    setTimeout(() => ghlPushes.delete(quoteRow.id), 10 * 60 * 1000).unref?.();
  }
}

/** GHL inbound-webhook triggers map flat keys most easily — send both nested and flat. */
function flatForGHL(d) {
  return {
    ...d,
    first_name: d.customer.first_name, last_name: d.customer.last_name, full_name: d.customer.full_name,
    email: d.customer.email, phone: d.customer.phone, address1: d.customer.address, city: d.customer.city,
    state: d.customer.state, postal_code: d.customer.zip, quote_number: d.number, quote_total: d.pricing.total,
    shed_style: d.shed.style, shed_size: d.shed.size, shed_roofing: d.shed.roofing,
    dealer_name: d.dealer?.name || '', dealer_id: d.dealer?.id || '', price_tier: d.pricing.tier || '', shed_summary: d.summary, shed_3d_link: d.links.view_3d,
    floor_plan_link: d.links.floor_plan_svg, options_list: d.options.map(o => o.name).join(', '),
  };
}

function pick(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }

const GHL_BASE = () => (process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/$/, '');

async function ghl(method, path, token, body) {
  const r = await fetch(GHL_BASE() + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  log(null, 'GHL ' + method + ' ' + path.split('?')[0], 'ghl', r.status, r.ok, 1, text);
  if (!r.ok) throw new Error(`GHL ${path} → ${r.status}: ${text.slice(0, 300)}`);
  return json;
}

/** Native GHL push: upsert contact → (optional) opportunity → note with the full quote. */
export async function pushToGHL(quoteRow, data) {
  const s = getSettings();
  const token = s.ghl_token, locationId = s.ghl_location_id;
  const tags = String(s.ghl_tags || 'shed-quote').split(',').map(t => t.trim()).filter(Boolean);
  if (data.dealer?.name) tags.push('dealer: ' + data.dealer.name);
  const customFields = [];
  if (s.ghl_custom_fields && typeof s.ghl_custom_fields === 'object') {
    for (const [key, path] of Object.entries(s.ghl_custom_fields)) {
      const v = pick(data, String(path));
      if (v != null) customFields.push({ key, field_value: typeof v === 'object' ? JSON.stringify(v) : v });
    }
  }
  const c = data.customer;
  const contact = await ghl('POST', '/contacts/upsert', token, {
    locationId, firstName: c.first_name, lastName: c.last_name, email: c.email, phone: c.phone,
    address1: c.address, city: c.city, state: c.state, postalCode: c.zip,
    source: s.ghl_source || '3D Shed Builder', tags,
    ...(customFields.length ? { customFields } : {}),
  });
  const contactId = contact?.contact?.id || contact?.id;
  let oppId = null;
  if (contactId && s.ghl_pipeline_id && s.ghl_stage_id) {
    const opp = await ghl('POST', '/opportunities/', token, {
      locationId, pipelineId: s.ghl_pipeline_id, pipelineStageId: s.ghl_stage_id, contactId,
      name: `${c.full_name || c.email} – ${data.shed.style} ${data.shed.size} (${data.number})`,
      status: 'open', monetaryValue: data.pricing.total,
    });
    oppId = opp?.opportunity?.id || opp?.id || null;
  }
  if (contactId && !off(s.ghl_add_note)) {
    const body = [
      `Shed quote ${data.number} — $${Number(data.pricing.total).toFixed(2)}`,
      `${data.shed.style} ${data.shed.size}`,
      data.shed.roofing ? `Roofing: ${data.shed.roofing}` : '',
      data.dealer?.name ? `Dealer lot: ${data.dealer.name}` : '',
      data.pricing.tier ? `Price tier: ${data.pricing.tier}${data.pricing.pricing_zip ? ' (ZIP ' + data.pricing.pricing_zip + ')' : ''}` : '',
      ...Object.entries(data.shed.colors).map(([k, v]) => `${k}: ${v}`),
      '', 'Options:', ...data.options.map(o => `• ${o.name}${o.wall ? ' (' + o.wall + ')' : ''} ${o.price ? '$' + o.price : ''}`),
      '', `3D view: ${data.links.view_3d}`, `Floor plan: ${data.links.floor_plan_svg}`,
      c.notes ? `\nCustomer notes: ${c.notes}` : '',
    ].join('\n');
    await ghl('POST', `/contacts/${contactId}/notes`, token, { body });
  }
  run("UPDATE quotes SET ghl_contact_id = ?, ghl_opportunity_id = ?, ghl_status = 'synced' WHERE id = ?", contactId || null, oppId, quoteRow.id);
  return { contactId, oppId };
}

// ---- Quote PDF (with pricing) → GoHighLevel ------------------------------------------------
// The customer's browser renders the drawing set (3D view, elevations, floor plan) and uploads it right after
// the quote is sent; the server puts its own pricing page in front, uploads the PDF to the GHL media library,
// and links it on the contact (note) and the opportunity (optional custom field). When no drawings arrive
// in time (customer closed the page, quote sent through the API, point of sale), the pricing pages go alone.
const ghlPushes = new Map();   // quote id → promise of { contactId, oppId } from the push above
const pdfWaits = new Map();    // quote id → { timer, baseUrl }
export const PDF_WAIT_MS = Number(process.env.QUOTE_PDF_WAIT_MS) || 120000;
const QUOTE_FILES = () => join(process.env.FILES_DIR || join(dirname(process.env.DB_PATH || './data/shedbuilder.db'), 'files'), 'quotes');
const quotePdfName = q => `${q.number || 'quote-' + q.id}-quote.pdf`;

/** A checkbox setting that is on unless it was switched off (saved as false / 0). */
const off = v => v === false || v === 0 || v === '0';
export const ghlPdfOn = (s = getSettings()) => !!(s.ghl_enabled && s.ghl_token && s.ghl_location_id && !off(s.ghl_send_pdf));

/** The company's quote PDF for a stored quote (pricing page + drawings, when the browser sent them). */
export async function quotePdfBytes(q, baseUrl, drawings = null) {
  const s = getSettings();
  return buildQuotePdf({ quote: formatQuote(q, baseUrl), lines: q.pricing?.lines || [], company: s.company_name || '', terms: s.quote_terms || '', drawings });
}
/** Stored copy, if this quote's PDF has been made. */
export function storedQuotePdf(q) {
  const f = q.pdf_file && join(QUOTE_FILES(), q.pdf_file.replace(/[^\w.-]/g, ''));
  return f && existsSync(f) ? readFileSync(f) : null;
}

/** Called when a quote is created: either wait for the browser's drawings, or make the PDF now. */
export function expectQuotePdf(q, baseUrl, browserWillSend) {
  if (!ghlPdfOn()) return false;
  if (!browserWillSend) { finishQuotePdf(q.id, null, baseUrl); return false; }
  const timer = setTimeout(() => finishQuotePdf(q.id, null, baseUrl), PDF_WAIT_MS); timer.unref?.();
  pdfWaits.set(q.id, { timer, baseUrl });
  return true;
}
/** Is the server still waiting for this quote's drawings? (one upload per quote, only for a short while) */
export const waitingForDrawings = id => pdfWaits.has(id);
export function drawingsArrived(id, bytes) {
  const w = pdfWaits.get(id); if (!w) return false;
  finishQuotePdf(id, bytes, w.baseUrl); return true;
}

export async function finishQuotePdf(id, drawings, baseUrl) {
  const w = pdfWaits.get(id); if (w) { clearTimeout(w.timer); pdfWaits.delete(id); }
  try {
    const synced = await (ghlPushes.get(id) || Promise.resolve(null));
    const q = get('SELECT * FROM quotes WHERE id = ?', id); if (!q) return;
    const bytes = Buffer.from(await quotePdfBytes(q, baseUrl, drawings));
    mkdirSync(QUOTE_FILES(), { recursive: true });
    const file = `${q.id}-${crypto.randomBytes(4).toString('hex')}.pdf`, pdfToken = crypto.randomBytes(16).toString('hex');
    writeFileSync(join(QUOTE_FILES(), file), bytes);
    run('UPDATE quotes SET pdf_file = ?, pdf_token = ? WHERE id = ?', file, pdfToken, q.id);
    const contactId = synced?.contactId || q.ghl_contact_id, oppId = synced?.oppId || q.ghl_opportunity_id;
    if (contactId && ghlPdfOn()) await sendQuotePdfToGHL({ ...q, pdf_token: pdfToken }, bytes, contactId, oppId, baseUrl, !!drawings);
  } catch (e) { log(null, 'GHL quote PDF', 'quote.created', 0, false, 1, e.message); }
}

/** "Re-send to GHL" on a quote: the PDF goes again (the stored copy, drawings included, when there is one). */
export async function resendQuotePdf(id, baseUrl) {
  if (!ghlPdfOn()) return;
  const first = get('SELECT * FROM quotes WHERE id = ?', id), stored = first && storedQuotePdf(first);
  if (!stored) return finishQuotePdf(id, null, baseUrl);
  try {
    const synced = await (ghlPushes.get(id) || Promise.resolve(null));
    const q = get('SELECT * FROM quotes WHERE id = ?', id), contactId = synced?.contactId || q.ghl_contact_id;
    if (contactId) await sendQuotePdfToGHL(q, stored, contactId, synced?.oppId || q.ghl_opportunity_id, baseUrl, null);
  } catch (e) { log(null, 'GHL quote PDF', 'quote.created', 0, false, 1, e.message); }
}

/** Upload to the GHL media library (needs the medias.write scope), else fall back to a private link on this app. */
async function sendQuotePdfToGHL(q, bytes, contactId, oppId, baseUrl, withDrawings) {
  const s = getSettings(), name = quotePdfName(q);
  let url = null;
  try {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'application/pdf' }), name); fd.append('name', name); fd.append('hosted', 'false');
    const r = await fetch(GHL_BASE() + '/medias/upload-file', { method: 'POST', headers: { Authorization: `Bearer ${s.ghl_token}`, Version: '2021-07-28', Accept: 'application/json' }, body: fd });
    const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch { /* */ }
    log(null, 'GHL POST /medias/upload-file', 'ghl', r.status, r.ok, 1, r.ok ? text : (r.status === 401 || r.status === 403 ? 'Give the Private Integration token the medias.write scope to store quote PDFs in GHL. ' : '') + text);
    if (r.ok) url = j.url || j.fileUrl || j.file?.url || null;
  } catch (e) { log(null, 'GHL POST /medias/upload-file', 'ghl', 0, false, 1, e.message); }
  const pub = String(s.public_url || baseUrl || '').replace(/\/$/, '');
  if (!url && pub) url = `${pub}/q/pdf/${q.pdf_token}`;
  if (!url) return;
  run('UPDATE quotes SET ghl_pdf_url = ? WHERE id = ?', url, q.id);
  const t = Number(q.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await ghl('POST', `/contacts/${contactId}/notes`, s.ghl_token, { body: `Quote PDF ${q.number} — $${t}${withDrawings === true ? ' (pricing + drawings)' : withDrawings === false ? ' (pricing)' : ''}\n${url}` });
  const key = String(s.ghl_pdf_field || '').trim().replace(/^\{\{\s*|\s*\}\}$/g, '').replace(/^(contact|opportunity)\./, '');
  if (key) {
    try {
      const model = oppId ? 'opportunity' : 'contact', id = await ghlFieldId(s, model, key);
      const cf = [{ ...(id ? { id } : {}), key, field_value: url }];
      if (oppId) await ghl('PUT', `/opportunities/${oppId}`, s.ghl_token, { customFields: cf });
      else await ghl('PUT', `/contacts/${contactId}`, s.ghl_token, { customFields: cf });
    } catch { /* logged by ghl(); the note already has the link */ }
  }
}
/** A custom field's id from its key (as GHL shows it: {{opportunity.quote_pdf}} or quote_pdf). Cached; null if it can't be looked up. */
const fieldIds = new Map();
async function ghlFieldId(s, model, key) {
  const ck = `${s.ghl_location_id}|${model}|${key}`;
  if (fieldIds.has(ck)) return fieldIds.get(ck);
  try {
    const r = await ghl('GET', `/locations/${encodeURIComponent(s.ghl_location_id)}/customFields?model=${model}`, s.ghl_token);
    const f = (r?.customFields || []).find(x => [key, `${model}.${key}`].includes(String(x.fieldKey || '').replace(/^\{\{\s*|\s*\}\}$/g, '')));
    if (f?.id) fieldIds.set(ck, f.id); // not found: look again next time (field or scope may be added later)
    return f?.id || null;
  } catch { return null; }
}

export function recentLog(limit = 100) {
  return all('SELECT * FROM webhook_log ORDER BY id DESC LIMIT ?', limit);
}
export function getQuoteRow(id) { return get('SELECT * FROM quotes WHERE id = ?', id); }
