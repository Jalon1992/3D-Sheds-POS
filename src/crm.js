// Built-in CRM: contacts, pipelines & opportunities, two-way texting/email, notes, tasks,
// notifications, and the production / delivery order board.
import express from 'express';
import crypto from 'node:crypto';
import { all, get, run, getSettings, setSettings } from './db.js';
import { requireSession } from './auth.js';
import { can, need, lotFilter, inLot } from './permissions.js';
import { broadcast, streamHandler } from './realtime.js';
import { sendSMS, sendEmail, toE164, fill, logInbound, twilioSignatureOk, updateDeliveryStatus, messagingStatus } from './messaging.js';

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const s500 = v => (v == null || v === '' ? null : String(v).slice(0, 500));
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------
import { DEFAULT_SALES_STAGES, DEFAULT_ORDER_STAGES } from '../public/js/shared/stages.js';
export { DEFAULT_SALES_STAGES, DEFAULT_ORDER_STAGES };
export function seedCRM() {
  if (!get('SELECT id FROM pipelines LIMIT 1')) {
    run("INSERT INTO pipelines (name, kind, stages, sort) VALUES ('Sales', 'sales', ?, 0)", JSON.stringify(DEFAULT_SALES_STAGES));
    run("INSERT INTO pipelines (name, kind, stages, sort) VALUES ('Production & delivery', 'orders', ?, 1)", JSON.stringify(DEFAULT_ORDER_STAGES));
  }
  if (!get('SELECT id FROM snippets LIMIT 1')) {
    const sn = [
      ['Thanks for your design', 'sms', null, 'Hi {{contact.first_name}}, thanks for designing your shed with {{company.name}}! Any questions about your {{quote.style}} {{quote.size}}? Just reply here.'],
      ['Follow-up', 'sms', null, 'Hi {{contact.first_name}}, just checking in on your shed quote. Want to get it on the build schedule?'],
      ['Delivery on the way', 'sms', null, 'Hi {{contact.first_name}}, your building from {{company.name}} is on the way! We\'ll text when we\'re close.'],
      ['Quote follow-up (email)', 'email', 'Your shed design from {{company.name}}', 'Hi {{contact.first_name}},\n\nThanks for designing your shed with us. You can view it in 3D any time here:\n{{quote.view_3d}}\n\nReply to this email or call {{company.phone}} with any questions.\n\nThanks,\n{{user.name}}'],
    ];
    for (const [name, channel, subject, body] of sn) run('INSERT INTO snippets (name, channel, subject, body) VALUES (?,?,?,?)', name, channel, subject, body);
  }
  const s = getSettings();
  if (!s.inbound_key) setSettings({ inbound_key: crypto.randomBytes(18).toString('base64url') });
  if (s.notify_on_signed === undefined) setSettings({ notify_on_signed: true, notify_on_new_lead: true, notify_on_inbound: false });
}
export const salesPipeline = () => get("SELECT * FROM pipelines WHERE kind = 'sales' ORDER BY sort, id LIMIT 1");
export const ordersPipeline = () => get("SELECT * FROM pipelines WHERE kind = 'orders' ORDER BY sort, id LIMIT 1");
const stageOf = (pipe, id) => (pipe?.stages || []).find(st => st.id === id);

// ---------------------------------------------------------------------------
// Contacts, activities, notifications
// ---------------------------------------------------------------------------
export function addActivity(contact_id, type, body, user_id = null, opportunity_id = null) {
  if (!contact_id) return;
  run('INSERT INTO activities (contact_id, opportunity_id, type, body, user_id) VALUES (?,?,?,?,?)', contact_id, opportunity_id, type, String(body ?? '').slice(0, 5000), user_id);
  run("UPDATE contacts SET last_activity_at = datetime('now') WHERE id = ?", contact_id);
}

/** Find by email, then phone; create if missing. Fills blanks on an existing contact, never wipes data. */
export function upsertContact(c, { source = null, dealer_id = null, assigned_to = null } = {}) {
  const email = c.email ? String(c.email).trim().toLowerCase() : null;
  const e164 = toE164(c.phone);
  let row = (email && get('SELECT * FROM contacts WHERE lower(email) = ? ORDER BY id LIMIT 1', email)) || (e164 && get('SELECT * FROM contacts WHERE phone_e164 = ? ORDER BY id LIMIT 1', e164)) || null;
  const vals = {
    first_name: s500(c.first_name), last_name: s500(c.last_name), email, phone: s500(c.phone), phone_e164: e164,
    address: s500(c.address), city: s500(c.city), state: s500(c.state), zip: s500(c.zip), company: s500(c.company),
  };
  if (row) {
    const upd = {};
    for (const [k, v] of Object.entries(vals)) if (v && !row[k]) upd[k] = v;
    // a newer quote with a full address should refresh the delivery address
    if (c.address && c.zip && (c.address !== row.address)) Object.assign(upd, { address: vals.address, city: vals.city, state: vals.state, zip: vals.zip });
    if (c.sms_consent && !row.sms_consent) upd.sms_consent = 1;
    if (dealer_id && !row.dealer_id) upd.dealer_id = String(dealer_id);
    const keys = Object.keys(upd);
    if (keys.length) run(`UPDATE contacts SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map(k => upd[k]), row.id);
    return { contact: get('SELECT * FROM contacts WHERE id = ?', row.id), created: false };
  }
  const tags = Array.isArray(c.tags) ? c.tags.map(String).slice(0, 30) : [];
  const r = run(`INSERT INTO contacts (first_name, last_name, email, phone, phone_e164, address, city, state, zip, company, source, tags, assigned_to, dealer_id, sms_consent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, vals.first_name, vals.last_name, email, vals.phone, e164, vals.address, vals.city, vals.state, vals.zip, vals.company,
    s500(source), JSON.stringify(tags), assigned_to || null, dealer_id ? String(dealer_id) : null, c.sms_consent ? 1 : 0);
  return { contact: get('SELECT * FROM contacts WHERE id = ?', Number(r.lastInsertRowid)), created: true };
}

/**
 * In-app notification (bell + live toast), plus optional text/email to the team.
 * @param {object} n { type, title, body, link, perm, dealer_id, external: bool }
 */
export async function notify(n, baseUrl = '') {
  run('INSERT INTO notifications (type, title, body, link, roles) VALUES (?,?,?,?,?)', n.type, n.title, n.body || '', n.link || '', JSON.stringify({ perm: n.perm || null, dealer_id: n.dealer_id ?? null }));
  broadcast('notification', { type: n.type, title: n.title, body: n.body, link: n.link }, { perm: n.perm, ...(n.dealer_id !== undefined ? { dealer_id: n.dealer_id } : {}) });
  if (!n.external) return;
  const s = getSettings();
  const link = n.link && baseUrl ? baseUrl + '/admin/' + n.link : '';
  const text = `${n.title}${n.body ? '\n' + n.body : ''}${link ? '\n' + link : ''}`;
  const emails = new Set(String(s.notify_emails || '').split(/[,;\s]+/).filter(x => /@/.test(x)).map(x => x.toLowerCase()));
  const phones = new Set(String(s.notify_phones || '').split(/[,;]+/).map(toE164).filter(Boolean));
  // team members who switched on their own alerts (lot-limited users only for their lot)
  for (const u of all("SELECT * FROM users WHERE COALESCE(active,1) = 1 AND (notify_email = 1 OR notify_sms = 1)")) {
    if (n.perm && !can({ role: u.role || 'admin' }, n.perm)) continue;
    if (u.dealer_id && u.role !== 'admin' && n.dealer_id !== undefined && String(u.dealer_id) !== String(n.dealer_id ?? '')) continue;
    if (u.notify_email && u.email) emails.add(u.email.toLowerCase());
    if (u.notify_sms && toE164(u.phone)) phones.add(toE164(u.phone));
  }
  await Promise.all([
    ...[...emails].map(to => sendEmail({ to, subject: n.title, text })),
    ...[...phones].map(to => sendSMS({ to, body: text.slice(0, 600), baseUrl })),
  ]);
}

function companyCtx(s = getSettings()) { return { name: s.company_name || '', phone: s.phone || '', website: s.website || '' }; }
export function contactCtx(contact, extra = {}) {
  return { contact: { ...contact, full_name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') }, company: companyCtx(), ...extra };
}

/** Send a text or email to a contact and log it on their conversation. */
export async function messageContact(contact, { channel, body, subject, user, contract_id, baseUrl, attachments, mediaUrls }) {
  if (channel === 'sms') {
    if (contact.dnd_sms) return { ok: false, error: `${contact.first_name || 'This contact'} opted out of texts (replied STOP).` };
    if (!contact.phone_e164) return { ok: false, error: 'This contact has no valid mobile number.' };
  } else if (channel === 'email') {
    if (contact.dnd_email) return { ok: false, error: 'This contact unsubscribed from email.' };
    if (!contact.email) return { ok: false, error: 'This contact has no email address.' };
  } else return { ok: false, error: 'channel must be sms or email' };
  const r = channel === 'sms'
    ? await sendSMS({ to: contact.phone_e164, body, contact_id: contact.id, contact, user_id: user?.id, contract_id, baseUrl, mediaUrls })
    : await sendEmail({ to: contact.email, subject, text: body, contact_id: contact.id, contact, user_id: user?.id, contract_id, attachments, replyTo: user?.email });
  run("UPDATE contacts SET last_message_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ?", contact.id);
  broadcast('message', { contact_id: contact.id, direction: 'out' }, { perm: 'crm.view', dealer_id: contact.dealer_id });
  return r;
}

/** Called for every new quote from the 3D configurator / API → contact + opportunity in the Sales pipeline. */
export async function onQuoteCreated(q, baseUrl, formatted) {
  const { contact, created } = upsertContact(q, { source: q.source && /dealer configurator/i.test(q.source) ? q.source : '3D configurator', dealer_id: q.dealer_id });
  run('UPDATE quotes SET contact_id = ? WHERE id = ?', contact.id, q.id);
  const pipe = salesPipeline();
  const firstStage = pipe?.stages?.[0]?.id || 'new';
  const early = (pipe?.stages || []).slice(0, 3).map(st => st.id);
  // reuse an early-stage open deal so one customer doesn't pile up cards; otherwise start a new one
  let opp = pipe && get(`SELECT * FROM opportunities WHERE contact_id = ? AND pipeline_id = ? AND status = 'open' AND stage IN (${early.map(() => '?').join(',') || "''"}) ORDER BY id DESC LIMIT 1`, contact.id, pipe.id, ...early);
  const title = `${q.style_name} ${q.size_label}`;
  if (opp) {
    run("UPDATE opportunities SET quote_id = ?, value = ?, title = ?, updated_at = datetime('now') WHERE id = ?", q.id, q.total || 0, title, opp.id);
  } else if (pipe) {
    const r = run('INSERT INTO opportunities (contact_id, quote_id, pipeline_id, stage, title, value, dealer_id, assigned_to) VALUES (?,?,?,?,?,?,?,?)',
      contact.id, q.id, pipe.id, firstStage, title, q.total || 0, q.dealer_id || contact.dealer_id || null, contact.assigned_to || null);
    opp = { id: Number(r.lastInsertRowid) };
  }
  addActivity(contact.id, 'quote', `Submitted 3D design ${q.number}: ${title} — $${Number(q.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}${q.notes ? `\nCustomer notes: ${q.notes}` : ''}`, null, opp?.id);
  broadcast('contact', { id: contact.id, created }, { perm: 'crm.view', dealer_id: contact.dealer_id });
  broadcast('opportunity', { id: opp?.id }, { perm: 'crm.view', dealer_id: contact.dealer_id });

  const s = getSettings();
  const name = [q.first_name, q.last_name].filter(Boolean).join(' ') || q.email;
  notify({ type: 'lead', title: `New 3D lead: ${name}`, body: `${title} · $${Number(q.total || 0).toLocaleString('en-US')} · ${q.number}`, link: `#/crm/contacts/${contact.id}`, perm: 'crm.view', dealer_id: contact.dealer_id, external: !!s.notify_on_new_lead }, baseUrl).catch(() => {});

  // optional instant auto-reply (texts only go out when the customer ticked SMS consent)
  const ctx = contactCtx(contact, { quote: { number: q.number, style: q.style_name, size: q.size_label, total: q.total, view_3d: formatted?.links?.view_3d || '' } });
  if (s.auto_reply_sms && q.sms_consent && contact.phone_e164) await messageContact(contact, { channel: 'sms', body: fill(s.auto_reply_sms, ctx), baseUrl }).catch(() => {});
  if (s.auto_reply_email_body && contact.email) await messageContact(contact, { channel: 'email', subject: fill(s.auto_reply_email_subject || 'Your shed design', ctx), body: fill(s.auto_reply_email_body, ctx), baseUrl }).catch(() => {});
  return { contact, opportunity_id: opp?.id };
}

/** One-time: bring quotes from before the CRM existed into it (no notifications, no auto-replies). */
export function backfillQuotes() {
  if (getSettings().crm_backfilled) return;
  const pipe = salesPipeline();
  const statusStage = { new: 'new', contacted: 'contacted', quoted: 'quoted', won: 'sold', lost: 'new' };
  for (const q of all('SELECT * FROM quotes WHERE contact_id IS NULL ORDER BY id')) {
    const { contact } = upsertContact(q, { source: '3D configurator', dealer_id: q.dealer_id });
    run('UPDATE quotes SET contact_id = ? WHERE id = ?', contact.id, q.id);
    if (pipe) run('INSERT INTO opportunities (contact_id, quote_id, pipeline_id, stage, title, value, status, dealer_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      contact.id, q.id, pipe.id, statusStage[q.status] || 'new', `${q.style_name} ${q.size_label}`, q.total || 0, q.status === 'won' ? 'won' : q.status === 'lost' ? 'lost' : 'open', q.dealer_id, q.created_at);
    run('INSERT INTO activities (contact_id, type, body, created_at) VALUES (?,?,?,?)', contact.id, 'quote', `Submitted 3D design ${q.number}: ${q.style_name} ${q.size_label}`, q.created_at);
  }
  setSettings({ crm_backfilled: true });
}

// When a contract is sent / signed, keep the pipeline in step.
export function moveSalesStage(opportunity_id, stageId, user_id = null, status = null) {
  const o = opportunity_id && get('SELECT * FROM opportunities WHERE id = ?', opportunity_id);
  if (!o) return;
  const pipe = get('SELECT * FROM pipelines WHERE id = ?', o.pipeline_id);
  if (!stageOf(pipe, stageId)) return;
  if (o.stage !== stageId || (status && o.status !== status)) {
    run("UPDATE opportunities SET stage = ?, status = COALESCE(?, status), stage_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", stageId, status, o.id);
    addActivity(o.contact_id, 'stage', `Moved to "${stageOf(pipe, stageId).name}"${status === 'won' ? ' (won)' : ''}`, user_id, o.id);
    broadcast('opportunity', { id: o.id }, { perm: 'orders.view' });
  }
}
/** A signed contract creates a card on the production & delivery board. */
export function createOrder({ contact_id, quote_id, contract_id, title, value, sale_type, dealer_id }) {
  const pipe = ordersPipeline(); if (!pipe) return null;
  const exists = get('SELECT id FROM opportunities WHERE contract_id = ? AND pipeline_id = ?', contract_id, pipe.id);
  if (exists) return exists.id;
  const r = run('INSERT INTO opportunities (contact_id, quote_id, contract_id, pipeline_id, stage, title, value, status, sale_type, dealer_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    contact_id, quote_id, contract_id, pipe.id, pipe.stages[0]?.id || 'sold', title, value || 0, 'won', sale_type, dealer_id || null);
  const id = Number(r.lastInsertRowid);
  run('UPDATE opportunities SET order_number = ? WHERE id = ?', 'O-' + (10000 + id), id);
  addActivity(contact_id, 'system', `Order O-${10000 + id} added to the production board`, null, id);
  broadcast('opportunity', { id }, { perm: 'orders.view' });
  return id;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export function crmRouter({ baseUrl }) {
  const r = express.Router();
  r.use(requireSession);

  const contactFor = (req, id) => { const c = get('SELECT * FROM contacts WHERE id = ?', Number(id)); return c && inLot(req.user, c) ? c : null; };
  const userName = id => (id ? get('SELECT name, email FROM users WHERE id = ?', id) : null);

  r.get('/stream', streamHandler);
  r.get('/me', (req, res) => res.json({ ...req.user, messaging: messagingStatus() }));
  r.get('/users', (req, res) => res.json(all("SELECT id, name, email, COALESCE(role,'admin') role, dealer_id FROM users WHERE COALESCE(active,1) = 1 ORDER BY name, email")));

  // ---- contacts
  r.get('/contacts', need('crm.view'), (req, res) => {
    const where = ['1=1'], p = [];
    const [lf, lp] = lotFilter(req.user, 'c.dealer_id'); if (lf) { where.push(lf.replace(/^ AND /, '')); p.push(...lp); }
    if (req.query.q) { const l = `%${String(req.query.q).trim()}%`; where.push("(c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.phone_e164 LIKE ? OR c.city LIKE ?)"); p.push(l, l, l, `%${String(req.query.q).replace(/\D/g, '') || '§'}%`, l); }
    if (req.query.tag) { where.push('EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ?)'); p.push(String(req.query.tag)); }
    if (req.query.assigned === 'me') { where.push('c.assigned_to = ?'); p.push(req.user.id); }
    else if (req.query.assigned === 'none') where.push('c.assigned_to IS NULL');
    if (req.query.source) { where.push('c.source = ?'); p.push(String(req.query.source)); }
    if (req.query.unread) where.push('c.unread > 0');
    const order = { recent: 'c.last_activity_at DESC', created: 'c.id DESC', name: "lower(COALESCE(c.first_name,'')) , lower(COALESCE(c.last_name,''))", messages: 'c.last_message_at DESC NULLS LAST' }[req.query.sort] || 'c.last_activity_at DESC';
    const limit = Math.min(500, Number(req.query.limit) || 100), offset = Number(req.query.offset) || 0;
    const w = where.join(' AND ');
    const total = get(`SELECT COUNT(*) n FROM contacts c WHERE ${w}`, ...p).n;
    const rows = all(`SELECT c.*, (SELECT stage FROM opportunities o WHERE o.contact_id = c.id AND o.pipeline_id = (SELECT id FROM pipelines WHERE kind='sales' ORDER BY sort, id LIMIT 1) ORDER BY o.id DESC LIMIT 1) AS stage,
      (SELECT body FROM messages m WHERE m.contact_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
      FROM contacts c WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, limit, offset);
    res.json({ total, data: rows });
  });
  r.post('/contacts', need('crm.edit'), wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.first_name && !b.last_name && !b.email && !b.phone) return bad(res, 'Enter at least a name, email or phone.');
    if (b.email && !/^\S+@\S+\.\S+$/.test(b.email)) return bad(res, 'Email looks invalid');
    if (b.phone && !toE164(b.phone)) return bad(res, 'Phone number looks invalid');
    const dealer = req.user.dealer_id || b.dealer_id || null;
    const dup = (b.email && get('SELECT id FROM contacts WHERE lower(email) = ?', String(b.email).toLowerCase())) || (toE164(b.phone) && get('SELECT id FROM contacts WHERE phone_e164 = ?', toE164(b.phone)));
    if (dup && !b.allow_merge) return res.status(409).json({ error: 'A contact with that email or phone already exists.', contact_id: dup.id });
    const { contact, created } = upsertContact({ ...b, tags: b.tags }, { source: b.source || 'Manual', dealer_id: dealer, assigned_to: b.assigned_to || req.user.id });
    if (created) addActivity(contact.id, 'system', `Lead added by ${req.user.name || req.user.email}`, req.user.id);
    if (b.note) addActivity(contact.id, 'note', b.note, req.user.id);
    if (b.create_opportunity !== false) {
      const pipe = salesPipeline();
      if (pipe) {
        const o = run('INSERT INTO opportunities (contact_id, pipeline_id, stage, title, value, dealer_id, assigned_to) VALUES (?,?,?,?,?,?,?)',
          contact.id, pipe.id, b.stage && stageOf(pipe, b.stage) ? b.stage : pipe.stages[0].id, s500(b.opportunity_title) || 'New shed', Number(b.value) || 0, contact.dealer_id, b.assigned_to || req.user.id);
        broadcast('opportunity', { id: Number(o.lastInsertRowid) }, { perm: 'crm.view', dealer_id: contact.dealer_id });
      }
    }
    broadcast('contact', { id: contact.id, created }, { perm: 'crm.view', dealer_id: contact.dealer_id });
    res.status(created ? 201 : 200).json(contact);
  }));
  r.get('/contacts/:id', need('crm.view'), (req, res) => {
    const c = contactFor(req, req.params.id); if (!c) return bad(res, 'Not found', 404);
    const opps = all('SELECT o.*, p.name pipeline_name, p.stages FROM opportunities o LEFT JOIN pipelines p ON p.id = o.pipeline_id WHERE o.contact_id = ? ORDER BY o.id DESC', c.id)
      .map(o => ({ ...o, stage_name: stageOf({ stages: o.stages }, o.stage)?.name || o.stage, stages: undefined }));
    const quotes = all('SELECT id, number, token, style_name, size_label, total, status, created_at, dealer_name FROM quotes WHERE contact_id = ? ORDER BY id DESC', c.id);
    const contracts = all('SELECT id, number, sale_type, status, total, template_name, created_at, sent_at, completed_at FROM contracts WHERE contact_id = ? ORDER BY id DESC', c.id);
    const tasks = all('SELECT t.*, u.name assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.contact_id = ? ORDER BY t.done_at IS NOT NULL, t.due_at IS NULL, t.due_at', c.id);
    const msgs = all('SELECT m.*, u.name user_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.contact_id = ? ORDER BY m.id', c.id).map(m => ({ kind: 'message', ...m }));
    const acts = all('SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.contact_id = ? ORDER BY a.id', c.id).map(a => ({ kind: 'activity', ...a }));
    const timeline = [...msgs, ...acts].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.kind !== b.kind ? (a.kind === 'activity' ? -1 : 1) : a.id - b.id));
    res.json({ ...c, assigned: userName(c.assigned_to), opportunities: opps, quotes, contracts, tasks, timeline });
  });
  r.patch('/contacts/:id', need('crm.edit'), (req, res) => {
    const c = contactFor(req, req.params.id); if (!c) return bad(res, 'Not found', 404);
    const b = req.body || {}, upd = {};
    for (const k of ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'company', 'source']) if (k in b) upd[k] = s500(b[k]);
    if ('email' in upd && upd.email) { if (!/^\S+@\S+\.\S+$/.test(upd.email)) return bad(res, 'Email looks invalid'); upd.email = upd.email.toLowerCase(); }
    if ('phone' in upd) { if (upd.phone && !toE164(upd.phone)) return bad(res, 'Phone number looks invalid'); upd.phone_e164 = toE164(upd.phone); }
    if ('tags' in b) upd.tags = JSON.stringify((Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map(t => String(t).trim()).filter(Boolean).slice(0, 30));
    for (const k of ['sms_consent', 'dnd_sms', 'dnd_email']) if (k in b) upd[k] = b[k] ? 1 : 0;
    if ('assigned_to' in b) upd.assigned_to = b.assigned_to ? Number(b.assigned_to) : null;
    if ('dealer_id' in b && !req.user.dealer_id) upd.dealer_id = b.dealer_id || null;
    const keys = Object.keys(upd); if (!keys.length) return bad(res, 'Nothing to update');
    run(`UPDATE contacts SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map(k => upd[k]), c.id);
    if ('assigned_to' in upd && upd.assigned_to !== c.assigned_to) addActivity(c.id, 'system', `Assigned to ${userName(upd.assigned_to)?.name || userName(upd.assigned_to)?.email || 'nobody'}`, req.user.id);
    broadcast('contact', { id: c.id }, { perm: 'crm.view', dealer_id: c.dealer_id });
    res.json(get('SELECT * FROM contacts WHERE id = ?', c.id));
  });
  r.delete('/contacts/:id', need('crm.delete'), (req, res) => {
    const c = contactFor(req, req.params.id); if (!c) return bad(res, 'Not found', 404);
    run('UPDATE quotes SET contact_id = NULL WHERE contact_id = ?', c.id);
    run('DELETE FROM contacts WHERE id = ?', c.id);
    broadcast('contact', { id: c.id, deleted: true }, { perm: 'crm.view' });
    res.sendStatus(204);
  });
  r.post('/contacts/:id/read', need('crm.view'), (req, res) => {
    const c = contactFor(req, req.params.id); if (!c) return bad(res, 'Not found', 404);
    run('UPDATE contacts SET unread = 0 WHERE id = ?', c.id); broadcast('message', { contact_id: c.id, read: true }, { perm: 'crm.view', dealer_id: c.dealer_id }); res.json({ ok: true });
  });
  r.post('/contacts/:id/messages', wrap(async (req, res) => {
    const c = contactFor(req, req.params.id); if (!c) return bad(res, 'Not found', 404);
    // delivery drivers can text customers whose order is on the board
    const okRole = can(req.user, 'crm.message') || (can(req.user, 'orders.message') && get('SELECT id FROM opportunities WHERE contact_id = ? AND pipeline_id = ?', c.id, ordersPipeline()?.id));
    if (!okRole) return bad(res, 'Your account does not have access to this.', 403);
    const { channel, body, subject } = req.body || {};
    if (!String(body || '').trim()) return bad(res, 'Message is empty');
    if (channel === 'email' && !String(subject || '').trim()) return bad(res, 'Add a subject');
    const ctx = contactCtx(c, { user: { name: req.user.name || '', email: req.user.email } });
    const out = await messageContact(c, { channel, body: fill(body, ctx), subject: fill(subject, ctx), user: req.user, baseUrl: baseUrl(req) });
    if (!out.ok) return res.status(out.status === 'failed' ? 502 : 400).json({ error: out.error || 'Could not send', id: out.id });
    run('UPDATE contacts SET unread = 0 WHERE id = ?', c.id);
    res.json(out);
  }));
  r.post('/contacts/:id/notes', need('crm.edit'), (req, res) => {
    const c = contactFor(req, req.params.id); if (!c) return bad(res, 'Not found', 404);
    const body = String(req.body?.body || '').trim(); if (!body) return bad(res, 'Note is empty');
    addActivity(c.id, req.body?.type === 'call' ? 'call' : 'note', body, req.user.id, req.body?.opportunity_id || null);
    broadcast('contact', { id: c.id }, { perm: 'crm.view', dealer_id: c.dealer_id });
    res.status(201).json({ ok: true });
  });

  // ---- tasks
  r.get('/tasks', need('crm.view'), (req, res) => {
    const where = ['1=1'], p = [];
    if (req.query.open !== '0') where.push('t.done_at IS NULL');
    if (req.query.mine) { where.push('t.assigned_to = ?'); p.push(req.user.id); }
    const [lf, lp] = lotFilter(req.user, 'c.dealer_id'); if (lf) { where.push(lf.replace(/^ AND /, '')); p.push(...lp); }
    res.json(all(`SELECT t.*, c.first_name, c.last_name, u.name assigned_name FROM tasks t JOIN contacts c ON c.id = t.contact_id LEFT JOIN users u ON u.id = t.assigned_to WHERE ${where.join(' AND ')} ORDER BY t.due_at IS NULL, t.due_at LIMIT 300`, ...p));
  });
  r.post('/contacts/:id/tasks', need('crm.edit'), (req, res) => {
    const c = contactFor(req, req.params.id); if (!c) return bad(res, 'Not found', 404);
    const title = String(req.body?.title || '').trim(); if (!title) return bad(res, 'Task needs a title');
    const t = run('INSERT INTO tasks (contact_id, opportunity_id, title, due_at, assigned_to, created_by) VALUES (?,?,?,?,?,?)', c.id, req.body.opportunity_id || null, title.slice(0, 300), req.body.due_at || null, Number(req.body.assigned_to) || req.user.id, req.user.id);
    addActivity(c.id, 'task', `Task added: ${title}${req.body.due_at ? ' (due ' + req.body.due_at + ')' : ''}`, req.user.id);
    broadcast('contact', { id: c.id }, { perm: 'crm.view', dealer_id: c.dealer_id });
    res.status(201).json(get('SELECT * FROM tasks WHERE id = ?', Number(t.lastInsertRowid)));
  });
  r.patch('/tasks/:id', need('crm.edit'), (req, res) => {
    const t = get('SELECT t.*, c.dealer_id FROM tasks t JOIN contacts c ON c.id = t.contact_id WHERE t.id = ?', Number(req.params.id));
    if (!t || !inLot(req.user, t)) return bad(res, 'Not found', 404);
    const b = req.body || {};
    if ('done' in b) {
      run('UPDATE tasks SET done_at = ? WHERE id = ?', b.done ? now() : null, t.id);
      if (b.done && !t.done_at) addActivity(t.contact_id, 'task', `Task done: ${t.title}`, req.user.id);
    }
    if ('title' in b || 'due_at' in b || 'assigned_to' in b) run('UPDATE tasks SET title = COALESCE(?, title), due_at = ?, assigned_to = COALESCE(?, assigned_to) WHERE id = ?', b.title || null, 'due_at' in b ? (b.due_at || null) : t.due_at, b.assigned_to || null, t.id);
    broadcast('contact', { id: t.contact_id }, { perm: 'crm.view', dealer_id: t.dealer_id });
    res.json(get('SELECT * FROM tasks WHERE id = ?', t.id));
  });
  r.delete('/tasks/:id', need('crm.edit'), (req, res) => {
    const t = get('SELECT t.*, c.dealer_id FROM tasks t JOIN contacts c ON c.id = t.contact_id WHERE t.id = ?', Number(req.params.id));
    if (!t || !inLot(req.user, t)) return bad(res, 'Not found', 404);
    run('DELETE FROM tasks WHERE id = ?', t.id); res.sendStatus(204);
  });

  // ---- conversations inbox
  r.get('/conversations', need('crm.view'), (req, res) => {
    const [lf, lp] = lotFilter(req.user, 'c.dealer_id');
    const unread = req.query.unread ? ' AND c.unread > 0' : '';
    const q = req.query.q ? ` AND (c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)` : '';
    const qp = req.query.q ? [`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`] : [];
    res.json(all(`SELECT c.id, c.first_name, c.last_name, c.phone, c.email, c.unread, c.last_message_at,
      (SELECT body FROM messages m WHERE m.contact_id = c.id ORDER BY m.id DESC LIMIT 1) last_message,
      (SELECT channel FROM messages m WHERE m.contact_id = c.id ORDER BY m.id DESC LIMIT 1) last_channel,
      (SELECT direction FROM messages m WHERE m.contact_id = c.id ORDER BY m.id DESC LIMIT 1) last_direction
      FROM contacts c WHERE c.last_message_at IS NOT NULL${lf}${unread}${q} ORDER BY c.last_message_at DESC LIMIT 200`, ...lp, ...qp));
  });

  // ---- pipelines & opportunities
  r.get('/pipelines', need('orders.view'), (req, res) => res.json(all('SELECT * FROM pipelines ORDER BY sort, id')));
  r.put('/pipelines/:id', need('crm.settings'), (req, res) => {
    const p = get('SELECT * FROM pipelines WHERE id = ?', Number(req.params.id)); if (!p) return bad(res, 'Not found', 404);
    const stages = (req.body?.stages || []).filter(s => s && s.name).map((s, i) => ({ ...s, id: String(s.id || s.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) || 'stage' + i, name: String(s.name).slice(0, 60) }));
    if (stages.length < 2) return bad(res, 'A pipeline needs at least 2 stages');
    if (new Set(stages.map(s => s.id)).size !== stages.length) return bad(res, 'Stage names must be different');
    const removed = p.stages.filter(o => !stages.find(s => s.id === o.id)).map(s => s.id);
    if (removed.length) {
      const inUse = get(`SELECT COUNT(*) n FROM opportunities WHERE pipeline_id = ? AND stage IN (${removed.map(() => '?').join(',')})`, p.id, ...removed).n;
      if (inUse) return bad(res, `${inUse} card(s) are in a stage you removed. Move them first.`);
    }
    run('UPDATE pipelines SET name = COALESCE(?, name), stages = ? WHERE id = ?', req.body.name || null, JSON.stringify(stages), p.id);
    res.json(get('SELECT * FROM pipelines WHERE id = ?', p.id));
  });

  const oppRows = (req, where, params) => {
    const [lf, lp] = lotFilter(req.user, 'o.dealer_id');
    const showMoney = can(req.user, 'crm.view');
    return all(`SELECT o.*, c.first_name, c.last_name, c.phone, c.email, c.address, c.city, c.state, c.zip, c.unread,
        q.number quote_number, q.token quote_token, q.style_name, q.size_label,
        k.number contract_number, k.status contract_status,
        (SELECT k2.status FROM contracts k2 WHERE k2.opportunity_id = o.id ORDER BY k2.id DESC LIMIT 1) latest_contract_status,
        u.name assigned_name, d.name driver_name
      FROM opportunities o JOIN contacts c ON c.id = o.contact_id
      LEFT JOIN quotes q ON q.id = o.quote_id LEFT JOIN contracts k ON k.id = o.contract_id
      LEFT JOIN users u ON u.id = o.assigned_to LEFT JOIN users d ON d.id = o.delivery_driver
      WHERE ${where}${lf} ORDER BY o.stage_changed_at DESC LIMIT 1000`, ...params, ...lp)
      .map(o => (showMoney ? o : { ...o, value: undefined }));
  };
  r.get('/opportunities', need('orders.view'), (req, res) => {
    const pid = Number(req.query.pipeline_id) || salesPipeline()?.id;
    const pipe = get('SELECT * FROM pipelines WHERE id = ?', pid); if (!pipe) return bad(res, 'Pipeline not found', 404);
    if (pipe.kind === 'sales' && !can(req.user, 'crm.view')) return bad(res, 'Your account does not have access to this.', 403);
    const status = req.query.status ? ' AND o.status = ?' : (pipe.kind === 'sales' && !req.query.all ? " AND o.status != 'lost'" : '');
    res.json({ pipeline: pipe, data: oppRows(req, `o.pipeline_id = ?${status}`, [pid, ...(req.query.status ? [req.query.status] : [])]) });
  });
  r.post('/opportunities', need('crm.edit'), (req, res) => {
    const b = req.body || {};
    const c = contactFor(req, b.contact_id); if (!c) return bad(res, 'Contact not found', 404);
    const pipe = get('SELECT * FROM pipelines WHERE id = ?', Number(b.pipeline_id) || salesPipeline()?.id); if (!pipe) return bad(res, 'Pipeline not found');
    const stage = stageOf(pipe, b.stage) ? b.stage : pipe.stages[0].id;
    const o = run('INSERT INTO opportunities (contact_id, pipeline_id, stage, title, value, quote_id, dealer_id, assigned_to) VALUES (?,?,?,?,?,?,?,?)',
      c.id, pipe.id, stage, s500(b.title) || 'New shed', Number(b.value) || 0, b.quote_id || null, c.dealer_id, b.assigned_to || req.user.id);
    addActivity(c.id, 'stage', `Opportunity "${s500(b.title) || 'New shed'}" added in ${pipe.name} → ${stageOf(pipe, stage).name}`, req.user.id, Number(o.lastInsertRowid));
    broadcast('opportunity', { id: Number(o.lastInsertRowid) }, { perm: 'orders.view' });
    res.status(201).json(get('SELECT * FROM opportunities WHERE id = ?', Number(o.lastInsertRowid)));
  });
  r.patch('/opportunities/:id', need('orders.view'), (req, res) => {
    const o = get('SELECT * FROM opportunities WHERE id = ?', Number(req.params.id));
    if (!o || !inLot(req.user, o)) return bad(res, 'Not found', 404);
    const pipe = get('SELECT * FROM pipelines WHERE id = ?', o.pipeline_id);
    const b = req.body || {}, upd = {};
    const isOrders = pipe.kind === 'orders';
    const crmEdit = can(req.user, 'crm.edit');
    if (!isOrders && !crmEdit) return bad(res, 'Your account does not have access to this.', 403);
    if (b.stage && b.stage !== o.stage) {
      const to = stageOf(pipe, b.stage), from = stageOf(pipe, o.stage);
      if (!to) return bad(res, 'Unknown stage');
      if (isOrders && req.user.role !== 'admin') {
        const g = st => st?.group || 'production';
        const mayTo = can(req.user, 'orders.' + g(to));
        const mayFrom = can(req.user, 'orders.' + g(from)) || (from?.handoff && g(to) === 'delivery');
        if (!(mayTo && mayFrom) && !crmEdit) return bad(res, `Your role can't move cards ${g(to) === 'delivery' ? 'into delivery stages' : 'into production stages'}.`, 403);
      }
      upd.stage = b.stage; upd.stage_changed_at = now();
      addActivity(o.contact_id, 'stage', `${o.order_number || o.title || 'Opportunity'} moved to "${to.name}"`, req.user.id, o.id);
      if (to.id === 'delivered') addActivity(o.contact_id, 'system', `Delivered${o.order_number ? ' — ' + o.order_number : ''}`, req.user.id, o.id);
    }
    if (crmEdit) {
      for (const k of ['title', 'sale_type']) if (k in b) upd[k] = s500(b[k]);
      if ('value' in b) upd.value = Number(b.value) || 0;
      if ('status' in b && ['open', 'won', 'lost'].includes(b.status)) upd.status = b.status;
      if ('assigned_to' in b) upd.assigned_to = b.assigned_to ? Number(b.assigned_to) : null;
    }
    if (isOrders) {
      if (can(req.user, 'orders.delivery') || crmEdit) for (const k of ['delivery_date', 'delivery_window', 'delivery_notes']) if (k in b) upd[k] = s500(b[k]);
      if ((can(req.user, 'orders.delivery') || crmEdit) && 'delivery_driver' in b) upd.delivery_driver = b.delivery_driver ? Number(b.delivery_driver) : null;
      if (can(req.user, 'orders.production') || crmEdit) for (const k of ['production_notes', 'serial_number']) if (k in b) upd[k] = s500(b[k]);
    }
    const keys = Object.keys(upd); if (!keys.length) return bad(res, 'Nothing you can change here');
    run(`UPDATE opportunities SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map(k => upd[k]), o.id);
    if (upd.delivery_date && upd.delivery_date !== o.delivery_date) addActivity(o.contact_id, 'system', `Delivery scheduled for ${upd.delivery_date}${upd.delivery_window ? ' (' + upd.delivery_window + ')' : ''}`, req.user.id, o.id);
    broadcast('opportunity', { id: o.id }, { perm: 'orders.view' });
    res.json(get('SELECT * FROM opportunities WHERE id = ?', o.id));
  });
  r.delete('/opportunities/:id', need('crm.delete'), (req, res) => { run('DELETE FROM opportunities WHERE id = ?', Number(req.params.id)); broadcast('opportunity', { id: Number(req.params.id) }, { perm: 'orders.view' }); res.sendStatus(204); });

  // ---- snippets (saved replies)
  r.get('/snippets', need('crm.view'), (req, res) => res.json(all('SELECT * FROM snippets ORDER BY channel, name')));
  r.post('/snippets', need('crm.settings'), (req, res) => {
    const b = req.body || {}; if (!b.name || !b.body) return bad(res, 'Name and message are required');
    const x = run('INSERT INTO snippets (name, channel, subject, body) VALUES (?,?,?,?)', s500(b.name), b.channel === 'email' ? 'email' : 'sms', s500(b.subject), String(b.body).slice(0, 5000));
    res.status(201).json(get('SELECT * FROM snippets WHERE id = ?', Number(x.lastInsertRowid)));
  });
  r.put('/snippets/:id', need('crm.settings'), (req, res) => {
    const b = req.body || {}; if (!b.name || !b.body) return bad(res, 'Name and message are required');
    run('UPDATE snippets SET name = ?, channel = ?, subject = ?, body = ? WHERE id = ?', s500(b.name), b.channel === 'email' ? 'email' : 'sms', s500(b.subject), String(b.body).slice(0, 5000), Number(req.params.id));
    res.json(get('SELECT * FROM snippets WHERE id = ?', Number(req.params.id)));
  });
  r.delete('/snippets/:id', need('crm.settings'), (req, res) => { run('DELETE FROM snippets WHERE id = ?', Number(req.params.id)); res.sendStatus(204); });

  // ---- notifications (bell)
  const visibleNotif = (u, n) => { const r = n.roles || {}; if (r.perm && !can(u, r.perm)) return false; if (u.dealer_id && u.role !== 'admin' && 'dealer_id' in r && String(r.dealer_id ?? '') !== String(u.dealer_id)) return false; return true; };
  r.get('/notifications', (req, res) => {
    const rows = all('SELECT * FROM notifications ORDER BY id DESC LIMIT 200').filter(n => visibleNotif(req.user, n)).slice(0, 50)
      .map(n => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, created_at: n.created_at, read: (n.read_by || []).includes(req.user.id) }));
    res.json({ unread: rows.filter(n => !n.read).length, data: rows });
  });
  r.post('/notifications/read', (req, res) => {
    for (const n of all('SELECT id, read_by, roles FROM notifications ORDER BY id DESC LIMIT 200')) {
      if (!visibleNotif(req.user, n) || (n.read_by || []).includes(req.user.id)) continue;
      run('UPDATE notifications SET read_by = ? WHERE id = ?', JSON.stringify([...(n.read_by || []), req.user.id]), n.id);
    }
    res.json({ ok: true });
  });

  // ---- production & delivery board
  r.get('/orders', need('orders.view'), (req, res) => {
    const pipe = ordersPipeline(); if (!pipe) return res.json({ pipeline: null, data: [] });
    res.json({ pipeline: pipe, data: oppRows(req, 'o.pipeline_id = ?', [pipe.id]), me: { production: can(req.user, 'orders.production'), delivery: can(req.user, 'orders.delivery'), message: can(req.user, 'orders.message') } });
  });

  return r;
}

// ---------------------------------------------------------------------------
// Inbound webhooks (public; Twilio is signature-checked, the others use a secret key in the URL)
// ---------------------------------------------------------------------------
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i, START = /^\s*(start|unstop|yes)\s*$/i;
async function inboundMessage({ channel, from, to, subject, body, provider, provider_id, name }, baseUrl) {
  const isSms = channel === 'sms';
  let contact = isSms ? get('SELECT * FROM contacts WHERE phone_e164 = ? ORDER BY id LIMIT 1', toE164(from)) : get('SELECT * FROM contacts WHERE lower(email) = ? ORDER BY id LIMIT 1', String(from).toLowerCase());
  if (!contact) {
    const [first, ...rest] = String(name || '').trim().split(/\s+/);
    contact = upsertContact(isSms ? { phone: from, first_name: first || null, last_name: rest.join(' ') || null } : { email: from, first_name: first || null, last_name: rest.join(' ') || null }, { source: isSms ? 'Inbound text' : 'Inbound email' }).contact;
    addActivity(contact.id, 'system', `New contact from an inbound ${isSms ? 'text' : 'email'}`);
  }
  logInbound({ contact_id: contact.id, channel, from, to, subject, body, provider, provider_id });
  if (isSms && STOP.test(body)) { run('UPDATE contacts SET dnd_sms = 1 WHERE id = ?', contact.id); addActivity(contact.id, 'system', 'Opted out of texts (STOP)'); }
  if (isSms && START.test(body) && contact.dnd_sms) { run('UPDATE contacts SET dnd_sms = 0 WHERE id = ?', contact.id); addActivity(contact.id, 'system', 'Opted back in to texts (START)'); }
  run("UPDATE contacts SET unread = unread + 1, last_message_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ?", contact.id);
  broadcast('message', { contact_id: contact.id, direction: 'in' }, { perm: 'crm.view', dealer_id: contact.dealer_id });
  const who = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || from;
  notify({ type: 'message', title: `New ${isSms ? 'text' : 'email'} from ${who}`, body: String(body || subject || '').slice(0, 140), link: `#/crm/conversations/${contact.id}`, perm: 'crm.view', dealer_id: contact.dealer_id, external: !!getSettings().notify_on_inbound }, baseUrl).catch(() => {});
  return contact;
}

export function hooksRouter({ baseUrl }) {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false, limit: '5mb' }));
  const keyOk = req => { const k = getSettings().inbound_key; return !!k && req.params.key === k; };
  // Twilio signs the exact URL it was configured with. Accept the Public URL form and the address the request
  // actually arrived on (custom domain vs onrender.com), and remember why a text was refused so the
  // Messaging page can explain it instead of replies silently disappearing.
  const twilioOk = req => {
    const s = getSettings();
    if (s.twilio_skip_signature === true) return true;
    const fail = reason => { setSettings({ inbound_last_error: { at: now(), channel: 'sms', reason } }); return false; };
    if (!s.twilio_token) return fail('A text arrived, but the Twilio Auth Token isn\'t saved, so it could not be verified.');
    if (!req.get('X-Twilio-Signature')) return fail('A request without a Twilio signature was refused.');
    const fwdProto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
    const urls = new Set([baseUrl(req) + req.originalUrl, `${fwdProto}://${req.get('host')}${req.originalUrl}`, `https://${req.get('host')}${req.originalUrl}`]);
    for (const u of urls) if (twilioSignatureOk(u, req.body || {}, req.get('X-Twilio-Signature'), s.twilio_token)) return true;
    return fail(`A text arrived but its signature didn't match. Make sure Settings → Public URL is exactly the address Twilio uses (Twilio is sending to ${req.get('host')}), and that the Auth Token is current.`);
  };
  r.post('/twilio/sms', wrap(async (req, res) => {
    if (!twilioOk(req)) return res.status(403).type('text/plain').send('Bad signature');
    const b = req.body || {};
    const media = Object.keys(b).filter(k => /^MediaUrl\d+$/.test(k)).map(k => b[k]);
    await inboundMessage({ channel: 'sms', from: b.From, to: b.To, body: [b.Body, ...media].filter(Boolean).join('\n'), provider: 'twilio', provider_id: b.MessageSid }, baseUrl(req));
    setSettings({ inbound_last_ok: { at: now(), channel: 'sms', from: b.From } });
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }));
  r.post('/twilio/status', (req, res) => {
    if (!twilioOk(req)) return res.status(403).send('Bad signature');
    const b = req.body || {};
    if (b.MessageSid && b.MessageStatus) {
      const m = updateDeliveryStatus(b.MessageSid, b.MessageStatus === 'undelivered' ? 'failed' : b.MessageStatus, b.ErrorCode ? `Carrier error ${b.ErrorCode}` : null, b.ErrorCode || null);
      if (m) { const row = get('SELECT contact_id FROM messages WHERE id = ?', m.id); if (row?.contact_id) broadcast('message', { contact_id: row.contact_id, status: b.MessageStatus }, { perm: 'crm.view' }); }
    }
    res.sendStatus(204);
  });
  // Inbound email: Mailgun / SendGrid inbound parse / Postmark / any service that POSTs from + subject + text
  r.post('/email/:key', express.json({ limit: '5mb' }), wrap(async (req, res) => {
    if (!keyOk(req)) return res.sendStatus(403);
    const b = req.body || {};
    const rawFrom = b.sender || b.From || b.from || b.FromFull?.Email || '';
    const m = String(rawFrom).match(/<?([^\s<>"]+@[^\s<>"]+)>?\s*$/);
    if (!m) return res.status(400).json({ error: 'No sender address' });
    const name = (String(b.from || b.From || '').match(/^\s*"?([^"<]+?)"?\s*</) || [])[1] || b.FromName || '';
    const text = b['stripped-text'] || b['body-plain'] || b.TextBody || b.StrippedTextReply || b.text || b.body || '';
    setSettings({ inbound_last_ok: { at: now(), channel: 'email', from: m[1] } });
    await inboundMessage({ channel: 'email', from: m[1], to: b.recipient || b.to || b.To || '', subject: b.subject || b.Subject || '', body: String(text).slice(0, 20000), provider: 'inbound-email', name }, baseUrl(req));
    res.json({ ok: true });
  }));
  // GoHighLevel workflow "Customer replied" → Webhook action pointing here
  r.post('/ghl/:key', express.json({ limit: '2mb' }), wrap(async (req, res) => {
    if (!keyOk(req)) return res.sendStatus(403);
    const b = req.body || {};
    const msg = b.message?.body || b.message_body || b.body || (typeof b.message === 'string' ? b.message : '') || '';
    const type = String(b.message?.type || b.message_type || b.type || '').toLowerCase();
    const isEmail = /email/.test(type);
    const from = isEmail ? (b.email || b.contact?.email) : (b.phone || b.contact?.phone);
    if (!from) return res.status(400).json({ error: 'Payload needs phone (or email) and message' });
    await inboundMessage({ channel: isEmail ? 'email' : 'sms', from, body: msg, subject: b.message?.subject || '', provider: 'ghl', name: b.full_name || [b.first_name, b.last_name].filter(Boolean).join(' ') }, baseUrl(req));
    res.json({ ok: true });
  }));
  return r;
}
