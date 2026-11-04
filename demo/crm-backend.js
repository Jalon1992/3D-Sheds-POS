// Demo: in-browser version of the CRM, point of sale, e-signing and order board APIs.
// Contract PDFs are built with the real PDF code; texts/emails are logged as "test mode".
// Files (templates, contracts) live in IndexedDB; everything else in localStorage with the rest of the demo.
import { api, hooks, setReady } from './backend.js';
import { can, permissionsFor } from '../src/permissions.js';
import { FIELD_TYPES, TAGS, DEFAULT_RTO, rtoCalc, saleTypeLabel, usd, DRAWING_INITIALS_BOX } from '../public/js/shared/contract.js';
import { buildData, signerFirst } from '../public/js/shared/contract-data.js';
import { inspectPdf, preparePdf, finalizePdf, sha256, buildSampleTemplate } from '../src/contract-pdf.js';
import { DEFAULT_SALES_STAGES, DEFAULT_ORDER_STAGES } from '../public/js/shared/stages.js';
import { dailyReport, localDay } from '../public/js/shared/reports.js';

const { on, json, err, save, nextId, now, tok, fmt } = api;
const D = () => api.db;
const me = () => api.currentUser();
const need = perm => (can(me(), perm) ? null : err('Your account does not have access to this.', 403));
const fill = (t, ctx) => String(t ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => { const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), ctx); return v == null ? '' : String(v); });
const toE164 = raw => { if (!raw) return null; const t = String(raw).trim(), d = t.replace(/\D/g, ''); if (t.startsWith('+') && d.length >= 8) return '+' + d; if (d.length === 10) return '+1' + d; if (d.length === 11 && d[0] === '1') return '+' + d; return null; };
const fullName = c => [c.first_name, c.last_name].filter(Boolean).join(' ');

// ---- files in IndexedDB --------------------------------------------------------
const files = new Map();
let idb = null;
const openIdb = () => new Promise(res => { try { const r = indexedDB.open('shedbuilder-demo-files', 1); r.onupgradeneeded = () => r.result.createObjectStore('f'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); } });
async function loadFiles() {
  idb = await openIdb(); if (!idb) return;
  await new Promise(res => { try { const tx = idb.transaction('f').objectStore('f').openCursor(); tx.onsuccess = e => { const c = e.target.result; if (c) { files.set(c.key, c.value); c.continue(); } else res(); }; tx.onerror = () => res(); } catch { res(); } });
}
function putFile(bytes) { const id = 'f' + tok().slice(0, 12); const u = new Uint8Array(bytes); files.set(id, u); try { idb?.transaction('f', 'readwrite').objectStore('f').put(u, id); } catch { /* memory only */ } return id; }
window.__shedDemoClearFiles = () => new Promise(res => { try { const r = indexedDB.deleteDatabase('shedbuilder-demo-files'); r.onsuccess = r.onerror = r.onblocked = () => res(); } catch { res(); } });
const pdfResp = (id, name) => { const b = files.get(id); return b ? new Response(b, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"` } }) : err('This file is no longer in this browser (demo data is kept per browser).', 404); };

// ---- setup / backfill ----------------------------------------------------------
async function init() {
  await loadFiles();
  const d = D();
  if (!d.crm) {
    Object.assign(d, { crm: 1, contacts: [], opps: [], messages: [], activities: [], tasks: [], notifications: [], templates: [], contracts: [],
      pipelines: [{ id: 1, name: 'Sales', kind: 'sales', stages: DEFAULT_SALES_STAGES }, { id: 2, name: 'Production & delivery', kind: 'orders', stages: DEFAULT_ORDER_STAGES }],
      snippets: [
        { id: 1, name: 'Thanks for your design', channel: 'sms', body: 'Hi {{contact.first_name}}, thanks for designing your shed with {{company.name}}! Any questions? Just reply here.' },
        { id: 2, name: 'Delivery on the way', channel: 'sms', body: "Hi {{contact.first_name}}, your building from {{company.name}} is on the way!" },
        { id: 3, name: 'Quote follow-up (email)', channel: 'email', subject: 'Your shed design from {{company.name}}', body: 'Hi {{contact.first_name}},\n\nThanks for designing your shed with us. Reply with any questions.\n\n{{user.name}}' },
      ] });
    Object.assign(d.settings, { rto: DEFAULT_RTO, cash_deposit_pct: 10, contract_link_days: 30, timezone: 'America/Chicago', messaging_test_mode: true, notify_on_signed: true });
    for (const q of [...d.quotes].reverse()) onQuote(q, true);
  }
  if (!d.templates.length || d.templates.some(t => !files.has(t.file))) {
    d.templates = d.templates.filter(t => files.has(t.file));
    if (!d.templates.length) for (const [kind, name] of [['cash', 'Sample — Cash Purchase Agreement'], ['rto', 'Sample — Rent-to-Own Agreement']]) {
      const { bytes, fields } = await buildSampleTemplate(kind);
      d.templates.push({ id: nextId(), name, sale_type: kind, file: putFile(bytes), file_name: name + '.pdf', pages: await inspectPdf(bytes), fields, append_drawings: 1, initial_drawings: 1, active: 1, created_at: now() });
    }
  }
  save();
}
setReady(init());

// ---- CRM helpers ---------------------------------------------------------------
const pipe = kind => D().pipelines.find(p => p.kind === kind);
const stageOf = (p, id) => p?.stages.find(s => s.id === id);
const lotOk = row => !me().dealer_id || me().role === 'admin' || String(row?.dealer_id ?? '') === String(me().dealer_id);
function act(contact_id, type, body, opp = null) { if (!contact_id) return; D().activities.push({ id: nextId(), contact_id, opportunity_id: opp, type, body, user_id: me()?.id, created_at: now() }); const c = D().contacts.find(x => x.id === contact_id); if (c) c.last_activity_at = now(); }
function notify(type, title, body, link, perm) { D().notifications.unshift({ id: nextId(), type, title, body, link, perm, read_by: [], created_at: now() }); D().notifications = D().notifications.slice(0, 100); }
function upsert(c, source, dealer_id) {
  const email = c.email ? String(c.email).toLowerCase() : null, e164 = toE164(c.phone);
  let row = D().contacts.find(x => (email && x.email === email) || (e164 && x.phone_e164 === e164));
  if (row) { for (const k of ['first_name', 'last_name', 'phone', 'address', 'city', 'state', 'zip']) if (c[k] && !row[k]) row[k] = c[k]; if (email && !row.email) row.email = email; if (e164 && !row.phone_e164) row.phone_e164 = e164; return { contact: row, created: false }; }
  row = { id: nextId(), first_name: c.first_name || '', last_name: c.last_name || '', email, phone: c.phone || '', phone_e164: e164, address: c.address || '', city: c.city || '', state: c.state || '', zip: c.zip || '',
    source, tags: c.tags || [], assigned_to: c.assigned_to || null, dealer_id: dealer_id || null, sms_consent: c.sms_consent ? 1 : 0, dnd_sms: 0, dnd_email: 0, unread: 0, last_message_at: null, last_activity_at: now(), created_at: now() };
  D().contacts.push(row); return { contact: row, created: true };
}
function onQuote(q, quiet = false, opts = {}) {
  const forced = opts.contact_id ? D().contacts.find(x => x.id === opts.contact_id) : null;
  if (forced) for (const k of ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'zip']) if (!String(q[k] || '').trim() && forced[k]) q[k] = forced[k];
  const { contact } = forced ? { contact: forced } : upsert(q, /dealer configurator/i.test(q.source || '') ? q.source : '3D configurator', q.dealer_id);
  q.contact_id = contact.id;
  const p = pipe('sales'), early = p.stages.slice(0, 3).map(s => s.id);
  let o = D().opps.find(x => x.contact_id === contact.id && x.pipeline_id === p.id && x.status === 'open' && early.includes(x.stage));
  if (!o && opts.pos) o = [...D().opps].reverse().sort((a, b) => (b.status === 'open') - (a.status === 'open')).find(x => x.contact_id === contact.id && x.pipeline_id === p.id);
  const title = `${q.style_name} ${q.size_label}`;
  const status = { won: 'won', lost: 'lost' }[q.status] || 'open', stage = { contacted: 'contacted', quoted: 'quoted', won: 'sold' }[q.status] || p.stages[0].id;
  if (o) Object.assign(o, { quote_id: q.id, value: q.total, title });
  else { o = { id: nextId(), contact_id: contact.id, quote_id: q.id, pipeline_id: p.id, stage: quiet ? stage : p.stages[0].id, status: quiet ? status : 'open', title, value: q.total, dealer_id: q.dealer_id, stage_changed_at: q.created_at || now(), created_at: q.created_at || now() }; D().opps.push(o); }
  if (opts.pos) { act(contact.id, 'quote', `${me()?.name || 'Sales'} designed ${q.number} for a contract: ${title} — ${usd(q.total)}`, o.id); return; }
  D().activities.push({ id: nextId(), contact_id: contact.id, opportunity_id: o.id, type: 'quote', body: `Submitted 3D design ${q.number}: ${title} — ${usd(q.total)}`, created_at: q.created_at || now() });
  if (!quiet) notify('lead', `New 3D lead: ${fullName(q) || q.email}`, `${title} · ${usd(q.total)}`, `#/crm/contacts/${contact.id}`, 'crm.view');
}
hooks.quoteCreated.push((q, opts) => { onQuote(q, false, opts || {}); save(); });

function logMsg(contact, channel, body, subject, contract_id) {
  const m = { id: nextId(), contact_id: contact?.id || null, channel, direction: 'out', to_addr: channel === 'sms' ? contact?.phone : contact?.email, subject, body, status: 'test', user_id: me()?.id, contract_id, created_at: now() };
  D().messages.push(m); if (contact) { contact.last_message_at = now(); contact.last_activity_at = now(); } return m;
}
const userName = id => D().users.find(u => u.id === id)?.name || null;
const contactView = c => {
  const opps = D().opps.filter(o => o.contact_id === c.id).map(o => { const p = D().pipelines.find(x => x.id === o.pipeline_id); return { ...o, pipeline_name: p?.name, stage_name: stageOf(p, o.stage)?.name }; }).reverse();
  const quotes = D().quotes.filter(q => q.contact_id === c.id).map(q => ({ id: q.id, number: q.number, token: q.token, style_name: q.style_name, size_label: q.size_label, total: q.total, status: q.status, created_at: q.created_at }));
  const contracts = D().contracts.filter(k => k.contact_id === c.id).map(k => ({ id: k.id, number: k.number, sale_type: k.sale_type, status: k.status, total: k.total, created_at: k.created_at })).reverse();
  const tasks = D().tasks.filter(t => t.contact_id === c.id).map(t => ({ ...t, assigned_name: userName(t.assigned_to) }));
  const tl = [...D().messages.filter(m => m.contact_id === c.id).map(m => ({ kind: 'message', ...m, user_name: userName(m.user_id) })), ...D().activities.filter(a => a.contact_id === c.id).map(a => ({ kind: 'activity', ...a, user_name: userName(a.user_id) }))]
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.kind !== b.kind ? (a.kind === 'activity' ? -1 : 1) : a.id - b.id));
  return { ...c, opportunities: opps, quotes, contracts, tasks, timeline: tl };
};
const getContact = id => { const c = D().contacts.find(x => x.id === +id); return c && lotOk(c) ? c : null; };

// ---- CRM routes ----------------------------------------------------------------
on('GET', /^\/api\/crm\/me$/, () => json({ ...me(), messaging: { sms: true, email: true, test_mode: true } }));
on('GET', /^\/api\/crm\/users$/, () => json(D().users.filter(u => u.active !== 0).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, dealer_id: u.dealer_id }))));
on('GET', /^\/api\/crm\/contacts$/, (m, b, url) => {
  const x = need('crm.view'); if (x) return x;
  const q = url.searchParams, s = (q.get('q') || '').toLowerCase(), digits = s.replace(/\D/g, '');
  let rows = D().contacts.filter(c => lotOk(c) && (!s || [fullName(c), c.email, c.phone, c.city].join(' ').toLowerCase().includes(s) || (digits && String(c.phone_e164 || '').includes(digits))));
  if (q.get('unread')) rows = rows.filter(c => c.unread > 0);
  if (q.get('assigned') === 'me') rows = rows.filter(c => c.assigned_to === me().id); if (q.get('assigned') === 'none') rows = rows.filter(c => !c.assigned_to);
  if (q.get('tag')) rows = rows.filter(c => (c.tags || []).includes(q.get('tag')));
  const sort = q.get('sort') || 'recent';
  rows.sort(sort === 'created' ? (a, b) => b.id - a.id : sort === 'name' ? (a, b) => fullName(a).localeCompare(fullName(b)) : sort === 'messages' ? (a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')) : (a, b) => String(b.last_activity_at).localeCompare(String(a.last_activity_at)));
  const sp = pipe('sales');
  return json({ total: rows.length, data: rows.map(c => ({ ...c, stage: D().opps.filter(o => o.contact_id === c.id && o.pipeline_id === sp.id).at(-1)?.stage, last_message: D().messages.filter(mm => mm.contact_id === c.id).at(-1)?.body })) });
});
on('POST', /^\/api\/crm\/contacts$/, (m, b) => {
  const x = need('crm.edit'); if (x) return x;
  if (!b.first_name && !b.last_name && !b.email && !b.phone) return err('Enter at least a name, email or phone.');
  if (b.phone && !toE164(b.phone)) return err('Phone number looks invalid');
  const dup = D().contacts.find(c => (b.email && c.email === String(b.email).toLowerCase()) || (toE164(b.phone) && c.phone_e164 === toE164(b.phone)));
  if (dup) return json({ error: 'A contact with that email or phone already exists.', contact_id: dup.id }, 409);
  const { contact } = upsert({ ...b, assigned_to: b.assigned_to || me().id }, b.source || 'Manual', me().dealer_id || null);
  act(contact.id, 'system', `Lead added by ${me().name}`); if (b.note) act(contact.id, 'note', b.note);
  const p = pipe('sales'); D().opps.push({ id: nextId(), contact_id: contact.id, pipeline_id: p.id, stage: stageOf(p, b.stage) ? b.stage : p.stages[0].id, status: 'open', title: b.opportunity_title || 'New shed', value: Number(b.value) || 0, dealer_id: contact.dealer_id, assigned_to: b.assigned_to || me().id, stage_changed_at: now(), created_at: now() });
  save(); return json(contact, 201);
});
on('GET', /^\/api\/crm\/contacts\/(\d+)$/, m => { const x = need('crm.view'); if (x) return x; const c = getContact(m[1]); return c ? json(contactView(c)) : err('Not found', 404); });
on('PATCH', /^\/api\/crm\/contacts\/(\d+)$/, (m, b) => {
  const c = getContact(m[1]); if (!c) return err('Not found', 404);
  for (const k of ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'source']) if (k in b) c[k] = b[k];
  if ('phone' in b) c.phone_e164 = toE164(b.phone); if ('tags' in b) c.tags = b.tags;
  for (const k of ['sms_consent', 'dnd_sms', 'dnd_email']) if (k in b) c[k] = b[k] ? 1 : 0;
  if ('assigned_to' in b) c.assigned_to = b.assigned_to ? +b.assigned_to : null;
  save(); return json(c);
});
on('DELETE', /^\/api\/crm\/contacts\/(\d+)$/, m => { const x = need('crm.delete'); if (x) return x; const id = +m[1]; for (const k of ['contacts']) D()[k] = D()[k].filter(c => c.id !== id); for (const k of ['opps', 'messages', 'activities', 'tasks']) D()[k] = D()[k].filter(r => r.contact_id !== id); save(); return json(null, 204); });
on('POST', /^\/api\/crm\/contacts\/(\d+)\/read$/, m => { const c = getContact(m[1]); if (c) { c.unread = 0; save(); } return json({ ok: true }); });
on('POST', /^\/api\/crm\/contacts\/(\d+)\/messages$/, (m, b) => {
  const c = getContact(m[1]); if (!c) return err('Not found', 404);
  if (!String(b.body || '').trim()) return err('Message is empty');
  if (b.channel === 'sms' && c.dnd_sms) return err(`${c.first_name || 'This contact'} opted out of texts (replied STOP).`);
  if (b.channel === 'sms' && !c.phone_e164) return err('This contact has no valid mobile number.');
  if (b.channel === 'email' && !c.email) return err('This contact has no email address.');
  if (b.channel === 'email' && !String(b.subject || '').trim()) return err('Add a subject');
  const ctx = { contact: { ...c, full_name: fullName(c) }, company: { name: D().settings.company_name, phone: D().settings.phone }, user: { name: me().name } };
  logMsg(c, b.channel, fill(b.body, ctx), fill(b.subject, ctx)); c.unread = 0;
  // the demo "customer" writes back a few seconds later so you can see two-way texting
  if (b.channel === 'sms' && !c._replied) { c._replied = 1; setTimeout(() => { D().messages.push({ id: nextId(), contact_id: c.id, channel: 'sms', direction: 'in', body: 'Thanks! Does that price include delivery? (demo reply)', status: 'received', created_at: now() }); c.unread = (c.unread || 0) + 1; c.last_message_at = now(); notify('message', `New text from ${fullName(c)}`, 'Thanks! Does that price include delivery?', `#/conversations/${c.id}`, 'crm.view'); save();
    window.__liveEmit?.('message', { contact_id: c.id, direction: 'in' }); window.__liveEmit?.('notification', { title: `New text from ${fullName(c)}`, body: 'Does that price include delivery? (demo reply)' }); }, 4000); }
  save(); return json({ ok: true, status: 'test' });
});
on('POST', /^\/api\/crm\/contacts\/(\d+)\/notes$/, (m, b) => { const c = getContact(m[1]); if (!c) return err('Not found', 404); if (!String(b.body || '').trim()) return err('Note is empty'); act(c.id, b.type === 'call' ? 'call' : 'note', b.body); save(); return json({ ok: true }, 201); });
on('POST', /^\/api\/crm\/contacts\/(\d+)\/tasks$/, (m, b) => { const c = getContact(m[1]); if (!c) return err('Not found', 404); if (!String(b.title || '').trim()) return err('Task needs a title'); const t = { id: nextId(), contact_id: c.id, title: b.title, due_at: b.due_at || null, assigned_to: +b.assigned_to || me().id, done_at: null, created_at: now() }; D().tasks.push(t); act(c.id, 'task', `Task added: ${t.title}`); save(); return json(t, 201); });
on('GET', /^\/api\/crm\/tasks$/, (m, b, url) => { let rows = D().tasks.filter(t => lotOk(D().contacts.find(c => c.id === t.contact_id))); if (url.searchParams.get('open') !== '0') rows = rows.filter(t => !t.done_at); if (url.searchParams.get('mine')) rows = rows.filter(t => t.assigned_to === me().id); return json(rows.map(t => { const c = D().contacts.find(x => x.id === t.contact_id) || {}; return { ...t, first_name: c.first_name, last_name: c.last_name, assigned_name: userName(t.assigned_to) }; })); });
on('PATCH', /^\/api\/crm\/tasks\/(\d+)$/, (m, b) => { const t = D().tasks.find(x => x.id === +m[1]); if (!t) return err('Not found', 404); if ('done' in b) { t.done_at = b.done ? now() : null; if (b.done) act(t.contact_id, 'task', `Task done: ${t.title}`); } save(); return json(t); });
on('GET', /^\/api\/crm\/conversations$/, (m, b, url) => {
  const s = (url.searchParams.get('q') || '').toLowerCase();
  return json(D().contacts.filter(c => c.last_message_at && lotOk(c) && (!url.searchParams.get('unread') || c.unread) && (!s || [fullName(c), c.phone, c.email].join(' ').toLowerCase().includes(s)))
    .sort((a, b2) => String(b2.last_message_at).localeCompare(String(a.last_message_at)))
    .map(c => { const last = D().messages.filter(x => x.contact_id === c.id).at(-1) || {}; return { ...c, last_message: last.body, last_channel: last.channel, last_direction: last.direction }; }));
});
on('GET', /^\/api\/crm\/pipelines$/, () => json(D().pipelines));
on('PUT', /^\/api\/crm\/pipelines\/(\d+)$/, (m, b) => {
  const p = D().pipelines.find(x => x.id === +m[1]); if (!p) return err('Not found', 404);
  const stages = (b.stages || []).filter(s => s.name).map((s, i) => ({ ...s, id: String(s.id || s.name).toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'stage' + i }));
  if (stages.length < 2) return err('A pipeline needs at least 2 stages');
  const gone = p.stages.filter(o => !stages.some(s => s.id === o.id)).map(s => s.id);
  const n = D().opps.filter(o => o.pipeline_id === p.id && gone.includes(o.stage)).length; if (n) return err(`${n} card(s) are in a stage you removed. Move them first.`);
  p.stages = stages; save(); return json(p);
});
const oppView = o => { const c = D().contacts.find(x => x.id === o.contact_id) || {}; const q = D().quotes.find(x => x.id === o.quote_id); const k = D().contracts.find(x => x.id === o.contract_id); const lk = D().contracts.filter(x => x.opportunity_id === o.id).at(-1);
  return { ...o, first_name: c.first_name, last_name: c.last_name, phone: c.phone, email: c.email, address: c.address, city: c.city, state: c.state, zip: c.zip, unread: c.unread, quote_number: q?.number, quote_token: q?.token, style_name: q?.style_name, size_label: q?.size_label, contract_number: k?.number, contract_status: k?.status, latest_contract_status: lk?.status, assigned_name: userName(o.assigned_to), driver_name: userName(o.delivery_driver), value: can(me(), 'crm.view') ? o.value : undefined }; };
on('GET', /^\/api\/crm\/opportunities$/, (m, b, url) => {
  const p = D().pipelines.find(x => x.id === +url.searchParams.get('pipeline_id')) || pipe('sales');
  let rows = D().opps.filter(o => o.pipeline_id === p.id && lotOk(o)); if (p.kind === 'sales' && !url.searchParams.get('all')) rows = rows.filter(o => o.status !== 'lost');
  return json({ pipeline: p, data: rows.map(oppView).sort((a, b2) => String(b2.stage_changed_at).localeCompare(String(a.stage_changed_at))) });
});
on('POST', /^\/api\/crm\/opportunities$/, (m, b) => { const c = getContact(b.contact_id); if (!c) return err('Contact not found', 404); const p = pipe('sales'); const o = { id: nextId(), contact_id: c.id, pipeline_id: p.id, stage: p.stages[0].id, status: 'open', title: b.title || 'New shed', value: +b.value || 0, stage_changed_at: now(), created_at: now() }; D().opps.push(o); save(); return json(o, 201); });
on('PATCH', /^\/api\/crm\/opportunities\/(\d+)$/, (m, b) => {
  const o = D().opps.find(x => x.id === +m[1]); if (!o) return err('Not found', 404);
  const p = D().pipelines.find(x => x.id === o.pipeline_id), crmEdit = can(me(), 'crm.edit');
  if (p.kind === 'sales' && !crmEdit) return err('Your account does not have access to this.', 403);
  if (b.stage && b.stage !== o.stage) {
    const to = stageOf(p, b.stage), from = stageOf(p, o.stage); if (!to) return err('Unknown stage');
    if (p.kind === 'orders' && me().role !== 'admin' && !crmEdit) {
      const g = s => s?.group || 'production';
      if (!(can(me(), 'orders.' + g(to)) && (can(me(), 'orders.' + g(from)) || (from?.handoff && g(to) === 'delivery')))) return err(`Your role can't move cards ${g(to) === 'delivery' ? 'into delivery stages' : 'into production stages'}.`, 403);
    }
    o.stage = b.stage; o.stage_changed_at = now(); act(o.contact_id, 'stage', `${o.order_number || o.title} moved to "${to.name}"`, o.id);
  }
  if (crmEdit) { for (const k of ['title']) if (k in b) o[k] = b[k]; if ('value' in b) o.value = +b.value || 0; if (['open', 'won', 'lost'].includes(b.status)) o.status = b.status; }
  if (p.kind === 'orders') {
    if (can(me(), 'orders.delivery') || crmEdit) { for (const k of ['delivery_date', 'delivery_window', 'delivery_notes']) if (k in b) o[k] = b[k]; if ('delivery_driver' in b) o.delivery_driver = b.delivery_driver ? +b.delivery_driver : null; }
    if (can(me(), 'orders.production') || crmEdit) for (const k of ['serial_number', 'production_notes']) if (k in b) o[k] = b[k];
  }
  save(); return json(o);
});
on('GET', /^\/api\/crm\/snippets$/, () => json(D().snippets));
on('POST', /^\/api\/crm\/snippets$/, (m, b) => { const s = { id: nextId(), ...b }; D().snippets.push(s); save(); return json(s, 201); });
on('PUT', /^\/api\/crm\/snippets\/(\d+)$/, (m, b) => { const s = D().snippets.find(x => x.id === +m[1]); Object.assign(s || {}, b); save(); return json(s); });
on('DELETE', /^\/api\/crm\/snippets\/(\d+)$/, m => { D().snippets = D().snippets.filter(x => x.id !== +m[1]); save(); return json(null, 204); });
on('GET', /^\/api\/crm\/notifications$/, () => { const rows = D().notifications.filter(n => !n.perm || can(me(), n.perm)).slice(0, 50).map(n => ({ ...n, read: n.read_by.includes(me().id) })); return json({ unread: rows.filter(n => !n.read).length, data: rows }); });
on('POST', /^\/api\/crm\/notifications\/read$/, () => { for (const n of D().notifications) if (!n.read_by.includes(me().id)) n.read_by.push(me().id); save(); return json({ ok: true }); });
on('GET', /^\/api\/crm\/orders$/, () => { const x = need('orders.view'); if (x) return x; const p = pipe('orders'); return json({ pipeline: p, data: D().opps.filter(o => o.pipeline_id === p.id && lotOk(o)).map(oppView), me: { production: can(me(), 'orders.production'), delivery: can(me(), 'orders.delivery'), message: can(me(), 'orders.message') } }); });
on('POST', /^\/api\/admin\/messaging\/test$/, () => json({ ok: true, status: 'test' }));
on('GET', /^\/api\/admin\/messaging\/status$/, () => {
  const last = (ch, dir) => D().messages.filter(x => x.channel === ch && x.direction === dir).at(-1) || null;
  const nm = id => { const c = D().contacts.find(x => x.id === id); return c ? { first_name: c.first_name, last_name: c.last_name } : {}; };
  return json({ sms: true, email: true, test_mode: true, sms_provider: D().settings.sms_provider || '', email_provider: D().settings.email_provider || '', from: D().settings.email_from || '',
    hooks: { twilio: 'https://your-app.onrender.com/api/hooks/twilio/sms', email: 'https://your-app.onrender.com/api/hooks/email/…', ghl: 'https://your-app.onrender.com/api/hooks/ghl/…', https: true, public_url_set: true },
    last_sms: last('sms', 'out'), last_email: last('email', 'out'), last_sms_in: last('sms', 'in'), last_email_in: last('email', 'in'), inbound_last_ok: null, inbound_last_error: null,
    recent: D().messages.slice(-25).reverse().map(x => ({ ...x, from_addr: x.direction === 'in' ? D().contacts.find(c => c.id === x.contact_id)?.phone : '', ...nm(x.contact_id) })) });
});
on('POST', /^\/api\/admin\/messaging\/verify$/, () => json({ ok: true, checks: [{ ok: null, label: 'Demo', detail: 'The demo never contacts Twilio, GoHighLevel or an email server. On your live app this button logs in with your saved details and tells you exactly what to fix.' }] }));
on('POST', /^\/api\/admin\/messaging\/twilio-connect$/, () => err('The demo does not contact Twilio. On your live app this sets your number\'s reply webhook for you.'));
on('POST', /^\/api\/admin\/messaging\/clear-inbound-error$/, () => json({ ok: true }));
on('POST', /^\/api\/admin\/account$/, (m, b) => { const u = me(); for (const k of ['name', 'email', 'phone']) if (b[k] !== undefined && b[k] !== '') u[k] = b[k]; if ('notify_sms' in b) u.notify_sms = b.notify_sms ? 1 : 0; if ('notify_email' in b) u.notify_email = b.notify_email ? 1 : 0; save(); return json({ ok: true }); });

// ---- Dashboard reports (demo: real demo activity + generated sample history so the charts have shape) ----
function sampleHistory(today) {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const season = [0.55, 0.65, 0.95, 1.25, 1.35, 1.2, 1.05, 1.0, 0.95, 0.9, 0.7, 0.5];
  const out = []; const [ty] = today.split('-').map(Number);
  for (let d = new Date(Date.UTC(ty - 1, 0, 1)); d.toISOString().slice(0, 10) < today; d = new Date(d.getTime() + 864e5)) {
    const m = season[d.getUTCMonth()] * (d.getUTCFullYear() === ty ? 1.15 : 1);
    const r = { d: d.toISOString().slice(0, 10), leads: 0, leads_3d: 0, leads_manual: 0, leads_msg: 0, quotes: 0, quote_value: 0, sales: 0, sales_value: 0, cash: 0, cash_value: 0, rto: 0, rto_value: 0 };
    for (let i = Math.round(rnd() * 4 * m); i > 0; i--) { r.leads++; const x = rnd(); r[x < 0.68 ? 'leads_3d' : x < 0.9 ? 'leads_manual' : 'leads_msg']++; }
    for (let i = Math.round(rnd() * 3 * m); i > 0; i--) { r.quotes++; r.quote_value += Math.round(4000 + rnd() * 9000); }
    if (rnd() < 0.42 * m) { const v = Math.round(4500 + rnd() * 10000), t = rnd() < 0.45 ? 'rto' : 'cash'; r.sales++; r.sales_value += v; r[t]++; r[t + '_value'] += v; }
    out.push(r);
  }
  return out;
}
on('GET', /^\/api\/admin\/reports$/, (m, b, url) => {
  const tz = D().settings.timezone || 'America/Chicago', today = localDay(new Date().toISOString(), tz), dealer = url.searchParams.get('dealer') || '';
  const real = dailyReport({ contacts: D().contacts, quotes: D().quotes, contracts: D().contracts, tz, dealer });
  const map = new Map(dealer ? [] : sampleHistory(today).map(r => [r.d, r]));
  for (const r of real) { const x = map.get(r.d); if (!x) map.set(r.d, r); else for (const k of Object.keys(r)) if (k !== 'd') x[k] += r[k]; }
  return json({ tz, today, days: [...map.values()].sort((a, c) => a.d.localeCompare(c.d)), dealers: (D().settings.dealers || []).map(d => ({ id: d.id, name: d.name })) });
});

// ---- Point of sale ----------------------------------------------------------------
const customTags = f => [...new Set((f || []).filter(x => x.type === 'data' && String(x.tag).startsWith('custom:')).map(x => String(x.tag).slice(7)))];
const signLink = t => `sign.html#${t}`;
on('GET', /^\/api\/pos\/meta$/, () => json({ field_types: FIELD_TYPES, tags: TAGS, rto: D().settings.rto || DEFAULT_RTO, cash_deposit_pct: D().settings.cash_deposit_pct ?? 10, tax_rate: D().settings.tax_rate || 0, messaging: { sms: true, email: true, test_mode: true },
  templates: D().templates.filter(t => t.active).map(t => ({ id: t.id, name: t.name, sale_type: t.sale_type, pages: t.pages, append_drawings: t.append_drawings, initial_drawings: t.initial_drawings, custom: customTags(t.fields), roles: [...new Set(t.fields.filter(f => f.role).map(f => f.role))] })) }));
on('GET', /^\/api\/pos\/templates$/, () => json(D().templates.map(t => ({ ...t, used: D().contracts.filter(k => k.template_id === t.id).length }))));
on('GET', /^\/api\/pos\/templates\/(\d+)$/, m => { const t = D().templates.find(x => x.id === +m[1]); return t ? json(t) : err('Not found', 404); });
on('GET', /^\/api\/pos\/templates\/(\d+)\/file\.pdf$/, m => { const t = D().templates.find(x => x.id === +m[1]); return t ? pdfResp(t.file, t.file_name) : err('Not found', 404); });
async function readUpload(b) {
  const f = b instanceof FormData ? b.get('file') : null; if (!f) throw new Error('Choose a PDF file');
  const bytes = new Uint8Array(await f.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('That file is not a valid PDF');
  if (bytes.length > 25e6) throw new Error('The demo keeps files in your browser, so PDFs must be under 25 MB.');
  try { return { f, bytes, pages: await inspectPdf(bytes) }; } catch (e) { throw new Error(/encrypt/i.test(e.message) ? 'LOCKED_PDF: That PDF is locked (it has a password or editing restrictions).' : 'Could not read that PDF: ' + e.message); }
}
on('POST', /^\/api\/pos\/templates$/, async (m, b) => {
  const x = need('pos.templates'); if (x) return x;
  let u; try { u = await readUpload(b); } catch (e) { return err(e.message); }
  const t = { id: nextId(), name: b.get('name') || u.f.name.replace(/\.pdf$/i, ''), sale_type: ['cash', 'rto', 'any'].includes(b.get('sale_type')) ? b.get('sale_type') : 'cash', file: putFile(u.bytes), file_name: u.f.name, pages: u.pages, fields: [], append_drawings: 1, initial_drawings: 1, active: 1, created_at: now() };
  D().templates.push(t); save(); return json(t, 201);
});
on('POST', /^\/api\/pos\/templates\/(\d+)\/file$/, async (m, b) => {
  const t = D().templates.find(x => x.id === +m[1]); if (!t) return err('Not found', 404);
  let u; try { u = await readUpload(b); } catch (e) { return err(e.message); }
  Object.assign(t, { file: putFile(u.bytes), file_name: u.f.name, pages: u.pages, fields: t.fields.filter(f => f.page < u.pages.length) }); save(); return json(t);
});
on('PUT', /^\/api\/pos\/templates\/(\d+)$/, (m, b) => {
  const x = need('pos.templates'); if (x) return x;
  const t = D().templates.find(y => y.id === +m[1]); if (!t) return err('Not found', 404);
  if (b.fields) { if (b.fields.some(f => !FIELD_TYPES[f.type])) return err('Unknown field type'); t.fields = b.fields.map(f => ({ ...f, page: Math.max(0, Math.min(t.pages.length - 1, +f.page || 0)), required: FIELD_TYPES[f.type].signer ? f.required !== false : false })); }
  for (const k of ['name', 'sale_type']) if (b[k]) t[k] = b[k];
  for (const k of ['append_drawings', 'initial_drawings', 'active']) if (k in b) t[k] = b[k] ? 1 : 0;
  save(); return json(t);
});
on('POST', /^\/api\/pos\/templates\/(\d+)\/duplicate$/, m => { const t = D().templates.find(y => y.id === +m[1]); const c = { ...structuredClone(t), id: nextId(), name: t.name + ' (copy)' }; D().templates.push(c); save(); return json({ id: c.id }, 201); });
on('DELETE', /^\/api\/pos\/templates\/(\d+)$/, m => { const t = D().templates.find(y => y.id === +m[1]); if (!t) return err('Not found', 404); if (D().contracts.some(k => k.template_id === t.id)) { t.active = 0; save(); return json({ archived: true }); } D().templates = D().templates.filter(y => y !== t); save(); return json(null, 204); });

const ev = (k, event, detail = '', signer_id = null) => k.events.push({ id: nextId(), event, detail, signer_id, user_id: me()?.id, user_name: signer_id ? null : me()?.name, ip: 'demo', created_at: now() });
const groupOf = k => k.group_id || k.id;
const versions = k => D().contracts.filter(x => groupOf(x) === groupOf(k)).sort((a, c) => (c.revision || 1) - (a.revision || 1))
  .map(v => ({ id: v.id, number: v.number, revision: v.revision || 1, status: v.status, prev_status: v.prev_status, created_at: v.created_at, sent_at: v.sent_at, completed_at: v.completed_at, superseded_at: v.superseded_at, change_note: v.change_note, total: v.total, superseded_by: v.superseded_by }));
const kView = k => ({ ...k, versions: versions(k), latest_id: (versions(k).find(v => !v.superseded_by) || versions(k)[0]).id, revision: k.revision || 1, data: undefined, raw: k.data?.raw, summary: { customer: k.data?.customer?.full_name, shed: k.data?.shed?.description, total: k.data?.pricing?.total, rto: k.data?.rto }, custom: k.data?.custom, signers: k.signers.map(s => ({ ...s, values_json: undefined, link: signLink(s.token) })) });
on('GET', /^\/api\/pos\/contracts$/, (m, b, url) => {
  const x = need('pos.view'); if (x) return x;
  const q = url.searchParams, s = (q.get('q') || '').toLowerCase();
  return json(D().contracts.filter(k => lotOk(k) && (q.get('all_versions') || !k.superseded_by) && (!q.get('status') || k.status === q.get('status')) && (!q.get('sale_type') || k.sale_type === q.get('sale_type')) && (!s || [k.number, k.data?.customer?.full_name, k.data?.customer?.email].join(' ').toLowerCase().includes(s)))
    .slice().reverse().map(k => ({ id: k.id, number: k.number, status: k.status, sale_type: k.sale_type, total: k.total, template_name: k.template_name, created_at: k.created_at, customer: k.data?.customer?.full_name, phone: k.data?.customer?.phone, email: k.data?.customer?.email, shed: k.data?.shed?.description, monthly: k.data?.rto?.monthly_total, created_by_name: userName(k.created_by), revision: k.revision || 1, versions: versions(k).length, completed_at: k.completed_at, signers: k.signers.length, signed: k.signers.filter(z => z.status === 'signed').length })));
});
on('GET', /^\/api\/pos\/contracts\/(\d+)$/, m => { const k = D().contracts.find(y => y.id === +m[1]); return k && lotOk(k) ? json({ ...kView(k), events: k.events }) : err('Not found', 404); });
on('GET', /^\/api\/pos\/contracts\/(\d+)\/document\.pdf$/, (m, b, url) => { const k = D().contracts.find(y => y.id === +m[1]); if (!k) return err('Not found', 404); const signed = k.completed_at && k.signed_file && url.searchParams.get('which') !== 'prepared'; return pdfResp(signed ? k.signed_file : k.prepared_file, `${k.number}${signed ? '-signed' : ''}.pdf`); });
on('POST', /^\/api\/pos\/contracts$/, async (m, b) => {
  const x = need('pos.create'); if (x) return x;
  const p = JSON.parse(b.get('payload') || '{}'); const s = D().settings;
  const prev = p.revise_of ? D().contracts.find(y => y.id === +p.revise_of) : null;
  if (p.revise_of && !prev) return err('The contract you are revising was not found', 404);
  if (prev?.superseded_by) return err('That version was already replaced. Open the latest version and edit that one.');
  const t = D().templates.find(y => y.id === +p.template_id && y.active); if (!t) return err('Pick a contract template');
  const sale_type = p.sale_type === 'rto' ? 'rto' : 'cash';
  if (t.sale_type !== 'any' && t.sale_type !== sale_type) return err(`"${t.name}" is a ${saleTypeLabel(t.sale_type)} template`);
  const q = p.quote_id ? D().quotes.find(y => y.id === +p.quote_id) : null;
  const cust = p.signers?.customer || {}; if (!String(cust.name || '').trim()) return err("Enter the customer's name");
  if (!cust.email && !cust.phone) return err('The customer needs an email or a mobile number to receive the signing link');
  const roles = new Set(t.fields.filter(f => f.role).map(f => f.role)); if (!roles.has('customer')) return err('This template has no customer signature fields. Add some in the template designer.');
  let contact = (p.contact_id && D().contacts.find(c => c.id === +p.contact_id)) || (q?.contact_id && D().contacts.find(c => c.id === q.contact_id));
  if (!contact) contact = upsert({ first_name: signerFirst(cust.name), last_name: String(cust.name).split(/\s+/).slice(1).join(' '), email: cust.email, phone: cust.phone }, 'Point of sale').contact;
  const cob = p.signers?.cobuyer?.name ? p.signers.cobuyer : null;
  const custom = { ...(p.custom || {}) };
  const pr = q?.pricing || {}, total = Number(pr.total ?? q?.total) || 0;
  const rto = sale_type === 'rto' ? { ...rtoCalc((+pr.subtotal || 0) + (+pr.delivery || 0) || total, p.rto?.term_months, s.rto || DEFAULT_RTO, s.tax_rate, +p.rto?.monthly_override || null), first_payment_date: p.rto?.first_payment_date || '' } : null;
  const cash = { deposit: p.cash?.deposit != null && p.cash.deposit !== '' ? Number(p.cash.deposit) : Math.round(total * (+s.cash_deposit_pct || 0)) / 100 };
  if (sale_type === 'cash' && (!Number.isFinite(cash.deposit) || cash.deposit < 0)) return err("The deposit can't be negative.");
  if (sale_type === 'cash' && total > 0 && cash.deposit > total + 0.005) return err(`The deposit ($${cash.deposit.toFixed(2)}) is more than the contract total ($${total.toFixed(2)}).`);
  if (sale_type === 'rto' && p.rto?.monthly_override != null && p.rto.monthly_override !== '' && !(Number(p.rto.monthly_override) > 0)) return err('The monthly payment override must be more than $0.');
  const id = nextId();
  const revision = prev ? Math.max(...versions(prev).map(v => v.revision)) + 1 : 1;
  const number = prev ? `${D().contracts.find(y => y.id === groupOf(prev)).number}-R${revision}` : 'C-' + (10000 + D().contracts.filter(y => !y.group_id).length + 1);
  const data = buildData({ q, fq: q ? fmt(q) : null, contact, sale_type, signers: { customer: cust, cobuyer: cob }, rto, cash, custom, user: me(), number, s });
  const getBytes = async k => { const f = b.get(k); return f ? new Uint8Array(await f.arrayBuffer()) : null; };
  let prep; const drawings = await getBytes('drawings');
  try { prep = await preparePdf({ templateBytes: files.get(t.file), fields: t.fields, data, rendering: await getBytes('rendering'), floorplan: await getBytes('floorplan'), drawingsBytes: drawings, appendDrawings: !!t.append_drawings }); }
  catch (e) { return err('Could not prepare the contract: ' + e.message); }
  const fields = [...t.fields];
  if (t.append_drawings && t.initial_drawings && drawings) for (let i = prep.templatePages; i < prep.pages.length; i++) fields.push({ id: 'dwg' + i, type: 'initials', role: 'customer', page: i, x: DRAWING_INITIALS_BOX.x + 0.004, y: DRAWING_INITIALS_BOX.y + 0.016, w: DRAWING_INITIALS_BOX.w - 0.008, h: DRAWING_INITIALS_BOX.h - 0.02, required: true });
  const sp = pipe('sales'); const opp = (q && D().opps.find(o => o.quote_id === q.id && o.pipeline_id === sp.id)) || D().opps.find(o => o.contact_id === contact.id && o.pipeline_id === sp.id && o.status === 'open');
  const signers = [{ id: nextId(), role: 'customer', name: cust.name, email: cust.email, phone: cust.phone, token: tok(), status: 'pending' }];
  if (cob && roles.has('cobuyer')) signers.push({ id: nextId(), role: 'cobuyer', name: cob.name, email: cob.email, phone: cob.phone, token: tok(), status: 'pending' });
  if (roles.has('company')) { const rep = D().users.find(u => u.id === +p.company_signer_id) || me(); signers.push({ id: nextId(), role: 'company', name: rep.name || rep.email, email: rep.email, token: tok(), status: 'pending', user_id: rep.id }); }
  const k = { id, number, quote_id: q?.id || null, contact_id: contact.id, opportunity_id: opp?.id || null, template_id: t.id, template_name: t.name, sale_type, status: 'draft', data, fields, pages: prep.pages, prepared_file: putFile(prep.bytes), prepared_hash: sha256(prep.bytes), total, dealer_id: q?.dealer_id || null, created_by: me().id, created_at: now(), expires_at: now(-30 * 864e5), signers, events: [],
    group_id: prev ? groupOf(prev) : null, revision, change_note: prev ? (p.change_note || '') : null,
    payload: { quote_id: q?.id || null, contact_id: contact.id, template_id: t.id, sale_type, signers: { customer: cust, cobuyer: cob }, company_signer_id: p.company_signer_id || null, custom, rto: p.rto || null, cash: p.cash || null } };
  ev(k, prev ? `Created as revision ${revision} of ${prev.number}` : 'Created', `${t.name} · ${saleTypeLabel(sale_type)} · ${usd(total)}${prev && p.change_note ? ' · ' + p.change_note : ''}`);
  if (prev) { prev.prev_status = prev.status; prev.status = 'superseded'; prev.superseded_by = id; prev.superseded_at = now(); ev(prev, 'Replaced by a revised version', `${number}${p.change_note ? ' · ' + p.change_note : ''} — this version's signing links no longer work`); }
  act(contact.id, 'contract', `Contract ${number} prepared (${saleTypeLabel(sale_type)}, ${usd(total)})`, opp?.id);
  D().contracts.push(k); save(); return json(kView(k), 201);
});
function moveSales(oppId, stage, status) { const o = D().opps.find(x => x.id === oppId); if (!o || (o.stage === stage && (!status || o.status === status))) return; o.stage = stage; if (status) o.status = status; o.stage_changed_at = now(); act(o.contact_id, 'stage', `Moved to "${stageOf(pipe('sales'), stage)?.name}"`, o.id); }
on('POST', /^\/api\/pos\/contracts\/(\d+)\/send$/, (m, b) => {
  const k = D().contracts.find(y => y.id === +m[1]); if (!k) return err('Not found', 404);
  if (['completed', 'void', 'superseded'].includes(k.status)) return err(k.status === 'superseded' ? 'This version was replaced. Send the latest version instead.' : 'This contract is ' + (k.status === 'void' ? 'void' : 'already signed'));
  const contact = D().contacts.find(c => c.id === k.contact_id);
  const results = [];
  for (const s of k.signers.filter(z => z.status !== 'signed' && (b.signer_ids ? b.signer_ids.includes(z.id) : z.role !== 'company'))) {
    const ctx = { ...k.data, signer: { first_name: signerFirst(s.name) }, link: signLink(s.token) };
    if (b.sms !== false && s.phone) { logMsg(s.role === 'customer' ? contact : null, 'sms', ((k.revision || 1) > 1 ? 'UPDATED CONTRACT — please use this new link. ' : '') + fill(D().settings.contract_sms || 'Hi {{signer.first_name}}, your {{company.name}} contract for your {{shed.description}} is ready to sign: {{link}}', ctx), null, k.id); ev(k, 'Signing link texted', `${s.name} · ${s.phone} (demo: not actually sent)`, s.id); results.push({ channel: 'sms', ok: true }); }
    if (b.email !== false && s.email) { logMsg(s.role === 'customer' ? contact : null, 'email', `Hi ${signerFirst(s.name)},\n\nYour contract is ready to sign:\n${signLink(s.token)}`, `Please sign: contract ${k.number}`, k.id); ev(k, 'Signing link emailed', `${s.name} · ${s.email} (demo: not actually sent)`, s.id); results.push({ channel: 'email', ok: true }); }
  }
  if (!results.length) return json({ ok: false, results, error: 'Nobody left to send to' }, 400);
  if (k.status === 'draft') k.status = 'sent'; k.sent_at ||= now();
  if (k.opportunity_id) moveSales(k.opportunity_id, 'contract');
  save(); return json({ ok: true, results });
});
on('POST', /^\/api\/pos\/contracts\/(\d+)\/sign-in-person$/, (m, b) => { const k = D().contracts.find(y => y.id === +m[1]); const s = k?.signers.find(z => z.id === +b.signer_id); if (!s) return err('Signer not found', 404); if (k.status === 'draft') k.status = 'sent'; ev(k, 'In-person signing started', `${s.name} (${s.role})`); if (k.opportunity_id && s.role !== 'company') moveSales(k.opportunity_id, 'contract'); save(); return json({ url: signLink(s.token) }); });
on('PATCH', /^\/api\/pos\/contracts\/(\d+)\/signers\/(\d+)$/, (m, b) => { const k = D().contracts.find(y => y.id === +m[1]); const s = k?.signers.find(z => z.id === +m[2]); if (!s) return err('Signer not found', 404); if (b.email) s.email = b.email; if (b.phone) s.phone = b.phone; save(); return json({ ok: true }); });
on('POST', /^\/api\/pos\/contracts\/(\d+)\/void$/, (m, b) => { const k = D().contracts.find(y => y.id === +m[1]); if (!k) return err('Not found', 404); if (k.status === 'superseded') return err('This version was already replaced by a newer one.'); k.status = 'void'; k.voided_at = now(); k.void_reason = b.reason || ''; ev(k, 'Voided', b.reason || ''); save(); return json({ ok: true }); });
on('DELETE', /^\/api\/pos\/contracts\/(\d+)$/, m => {
  const k = D().contracts.find(y => y.id === +m[1]); if (!k) return err('Not found', 404);
  if (k.completed_at) return err("Signed contracts can't be deleted. Void it instead.");
  if (k.status === 'superseded') return err('Earlier versions are kept as a record and cannot be deleted.');
  D().contracts = D().contracts.filter(y => y !== k);
  const r = D().contracts.find(y => y.superseded_by === k.id); if (r) { r.status = r.prev_status || 'draft'; r.superseded_by = null; r.superseded_at = null; ev(r, 'Revision deleted', `${k.number} was deleted, so this version is the latest again`); }
  save(); return json(null, 204);
});

// ---- public signing API (sign.html#token) ------------------------------------------
const bySigner = t => { for (const k of D().contracts) { const s = k.signers.find(z => z.token === t); if (s) return { k, s }; } return null; };
on('GET', /^\/api\/sign\/([\w-]+)$/, m => {
  const x = bySigner(m[1]); if (!x) return err('This signing link is not valid.', 404); const { k, s } = x; const st = D().settings;
  return json({ company: { name: st.company_name, logo_url: st.logo_url, brand_color: st.brand_color, phone: st.phone },
    contract: { number: k.number, status: k.status, sale_type: k.sale_type, template_name: k.template_name, shed: k.data?.shed?.description, total: k.data?.pricing?.total, rto: k.sale_type === 'rto' ? k.data?.rto : null, expired: false, void_reason: k.void_reason,
      replaced_by: (() => { if (k.status !== 'superseded') return null; const l = D().contracts.find(y => groupOf(y) === groupOf(k) && !y.superseded_by); const sg = l && l.status !== 'void' && l.signers.find(z => z.role === s.role); return sg ? { number: l.number, link: signLink(sg.token) } : null; })() },
    signer: { role: s.role, name: s.name, status: s.status, signed_at: s.signed_at }, others: k.signers.filter(z => z !== s).map(z => ({ role: z.role, name: z.name, status: z.status })), pages: k.pages,
    fields: k.fields.filter(f => FIELD_TYPES[f.type]?.signer).map(f => ({ ...f, mine: f.role === s.role })),
    consent_text: `I agree to use electronic records and signatures for this agreement with ${st.company_name || 'the seller'}, and that my electronic signature is the legal equivalent of my handwritten signature.`,
    signed_pdf: k.status === 'completed' ? `/api/sign/${s.token}/signed.pdf` : null });
});
on('GET', /^\/api\/sign\/([\w-]+)\/document\.pdf$/, m => { const x = bySigner(m[1]); if (!x) return err('Not found', 404); return pdfResp(x.k.completed_at && x.k.signed_file ? x.k.signed_file : x.k.prepared_file, x.k.number + '.pdf'); });
on('GET', /^\/api\/sign\/([\w-]+)\/signed\.pdf$/, m => { const x = bySigner(m[1]); if (!x || x.k.status !== 'completed') return err('Not everyone has signed yet', 409); return pdfResp(x.k.signed_file, x.k.number + '-signed.pdf'); });
on('POST', /^\/api\/sign\/([\w-]+)\/viewed$/, m => { const x = bySigner(m[1]); if (x && !x.s.viewed_at && x.s.status !== 'signed') { x.s.viewed_at = now(); x.s.status = 'viewed'; if (x.k.status === 'sent' || x.k.status === 'draft') x.k.status = 'viewed'; ev(x.k, 'Viewed', `${x.s.name} (${x.s.role})`, x.s.id); save(); } return json({ ok: true }); });
on('POST', /^\/api\/sign\/([\w-]+)\/sign$/, async (m, b) => {
  const x = bySigner(m[1]); if (!x) return err('Not found', 404); const { k, s } = x;
  if (k.status === 'void') return err('This contract was voided and can no longer be signed.', 410);
  if (k.status === 'superseded') return err('This contract was replaced by an updated version. Please use the newest link you were sent.', 410);
  if (s.status === 'signed') return err('You already signed this contract.', 409);
  if (b.consent !== true) return err('Please agree to sign electronically.');
  for (const f of k.fields.filter(f => FIELD_TYPES[f.type]?.signer && f.role === s.role && f.required && f.type !== 'date_signed')) if (!b.values?.[f.id]) return err('Please complete every highlighted box.');
  Object.assign(s, { status: 'signed', values_json: b.values || {}, signed_at: now(), consent_at: now(), ip: 'demo', user_agent: navigator.userAgent });
  ev(k, 'Agreed to sign electronically', s.name, s.id); ev(k, 'Signed', `${s.name} (${s.role})`, s.id);
  if (s.role !== 'company') act(k.contact_id, 'contract', `${s.name} signed contract ${k.number}`, k.opportunity_id);
  const left = k.signers.filter(z => z.status !== 'signed').length;
  if (left) { k.status = 'partial'; save(); return json({ ok: true, completed: false, waiting_on: left }); }
  k.status = 'completed'; k.completed_at = now(); ev(k, 'Completed', 'All parties signed');
  const bytes = await finalizePdf({ preparedBytes: files.get(k.prepared_file), fields: k.fields, signers: k.signers, contract: k, events: k.events, tz: D().settings.timezone, company: D().settings.company_name });
  k.signed_file = putFile(bytes); k.signed_hash = sha256(bytes);
  if (k.opportunity_id) moveSales(k.opportunity_id, 'sold', 'won');
  const q = D().quotes.find(y => y.id === k.quote_id); if (q) q.status = 'won';
  const op = pipe('orders');
  const prevOrder = D().opps.find(o => o.pipeline_id === op.id && D().contracts.some(c => c.id === o.contract_id && groupOf(c) === groupOf(k)));
  if (prevOrder) { Object.assign(prevOrder, { contract_id: k.id, title: k.data?.shed?.description || k.template_name, value: k.total, sale_type: k.sale_type }); act(k.contact_id, 'system', `Order ${prevOrder.order_number} updated to revised contract ${k.number}`, prevOrder.id); }
  const oid = nextId();
  if (!prevOrder) D().opps.push({ id: oid, order_number: 'O-' + (10000 + D().opps.filter(o => o.pipeline_id === op.id).length + 1), contact_id: k.contact_id, quote_id: k.quote_id, contract_id: k.id, pipeline_id: op.id, stage: op.stages[0].id, status: 'won', title: k.data?.shed?.description || k.template_name, value: k.total, sale_type: k.sale_type, serial_number: k.data?.custom?.serial_number || '', stage_changed_at: now(), created_at: now() });
  act(k.contact_id, 'contract', `Contract ${k.number} signed by all parties`, k.opportunity_id);
  notify('contract', `Contract signed: ${k.data?.customer?.full_name} — ${k.number}`, `${k.data?.shed?.description} · ${saleTypeLabel(k.sale_type)} · ${k.data?.pricing?.total}`, `#/pos/contracts/${k.id}`, 'pos.view');
  ev(k, 'Signed copy emailed', `${k.data?.customer?.full_name} (demo: not actually sent)`);
  save(); return json({ ok: true, completed: true, waiting_on: 0, signed_pdf: `/api/sign/${s.token}/signed.pdf` });
});
export { permissionsFor };
