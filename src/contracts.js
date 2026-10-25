// Point of sale: contract templates (Cash / Rent to Own), contracts, e-signature links by text & email,
// signed PDF with the 3D rendering, floor plan and elevations, and alerts when a contract is signed.
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { all, get, run, getSettings, setSettings } from './db.js';
import { requireSession } from './auth.js';
import { can, need, lotFilter, inLot } from './permissions.js';
import { broadcast } from './realtime.js';
import { formatQuote } from '../public/js/shared/quote-format.js';
import { FIELD_TYPES, TAGS, DEFAULT_RTO, rtoCalc, usd, saleTypeLabel, DRAWING_INITIALS_BOX } from '../public/js/shared/contract.js';
import { inspectPdf, preparePdf, finalizePdf, sha256, buildSampleTemplate } from './contract-pdf.js';
import { buildData, signerFirst } from '../public/js/shared/contract-data.js';
import { addActivity, notify, messageContact, moveSalesStage, createOrder, salesPipeline, ordersPipeline, upsertContact } from './crm.js';
import { fill, sendEmail, sendSMS, toE164, prettyPhone, messagingStatus } from './messaging.js';

const DB_PATH = process.env.DB_PATH || './data/shedbuilder.db';
export const FILES_DIR = process.env.FILES_DIR || join(dirname(DB_PATH), 'files');
for (const d of ['templates', 'contracts']) mkdirSync(join(FILES_DIR, d), { recursive: true });

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const rid = (n = 24) => crypto.randomBytes(n).toString('base64url');
const fpath = rel => { if (!rel || rel.includes('..')) throw new Error('Bad file path'); return join(FILES_DIR, rel); };
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
/** Content-Disposition that survives any file name (ASCII fallback + UTF-8 version). */
export const disposition = (type, name) => {
  const ascii = String(name || 'file.pdf').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim() || 'file.pdf';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name || 'file.pdf'))}`;
};
const ipOf = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || '';

export const DEFAULT_MESSAGES = {
  contract_sms: 'Hi {{signer.first_name}}, your {{company.name}} contract for your {{shed.description}} is ready to sign: {{link}}',
  contract_email_subject: 'Please sign: your {{company.name}} contract {{contract.number}}',
  contract_email_body: 'Hi {{signer.first_name}},\n\nYour contract for your {{shed.description}} is ready. It includes your 3D rendering, floor plan and elevations.\n\nReview and sign here:\n{{link}}\n\nQuestions? Reply to this email or call {{company.phone}}.\n\nThank you,\n{{sales_rep.name}}\n{{company.name}}',
  signed_customer_sms: 'Thanks {{signer.first_name}}! Your {{company.name}} contract {{contract.number}} is signed by everyone. Download your copy: {{link}}',
  signed_customer_email_subject: 'Signed: your {{company.name}} contract {{contract.number}}',
  signed_customer_email_body: 'Hi {{signer.first_name}},\n\nThank you! Everyone has signed contract {{contract.number}}. Your signed copy, with your 3D rendering, floor plan and elevations, is attached and can also be downloaded here:\n{{link}}\n\n{{company.name}}',
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
export async function seedContracts() {
  const s = getSettings();
  if (s.rto === undefined) setSettings({ rto: DEFAULT_RTO });
  if (s.cash_deposit_pct === undefined) setSettings({ cash_deposit_pct: 10, contract_link_days: 30, timezone: 'America/Chicago' });
  for (const [k, v] of Object.entries(DEFAULT_MESSAGES)) if (s[k] === undefined) setSettings({ [k]: v });
  if (s.sample_templates_seeded) return;
  for (const [kind, name] of [['cash', 'Sample — Cash Purchase Agreement'], ['rto', 'Sample — Rent-to-Own Agreement']]) {
    const { bytes, fields } = await buildSampleTemplate(kind);
    const file = `templates/${rid(9)}.pdf`;
    writeFileSync(fpath(file), bytes);
    run('INSERT INTO contract_templates (name, sale_type, file, file_name, pages, fields) VALUES (?,?,?,?,?,?)', name, kind, file, name + '.pdf', JSON.stringify(await inspectPdf(bytes)), JSON.stringify(fields));
  }
  setSettings({ sample_templates_seeded: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function contractEvent(contract_id, event, detail = '', { req, signer_id, user_id } = {}) {
  run('INSERT INTO contract_events (contract_id, signer_id, event, detail, ip, user_agent, user_id) VALUES (?,?,?,?,?,?,?)',
    contract_id, signer_id || null, event, String(detail || '').slice(0, 1000), req ? ipOf(req) : null, req ? String(req.get('user-agent') || '').slice(0, 300) : null, user_id || null);
}
function cleanFields(fields, pageCount) {
  if (!Array.isArray(fields)) throw new Error('fields must be a list');
  const seen = new Set();
  return fields.slice(0, 400).map((f, i) => {
    if (!FIELD_TYPES[f.type]) throw new Error(`Unknown field type "${f.type}"`);
    const n = v => Math.max(0, Math.min(1, Number(v) || 0));
    let id = String(f.id || 'f' + i).replace(/[^\w-]/g, '').slice(0, 40) || 'f' + i;
    while (seen.has(id)) id += 'x'; seen.add(id);
    const page = Math.max(0, Math.min(pageCount - 1, Number(f.page) || 0));
    const out = { id, type: f.type, page, x: n(f.x), y: n(f.y), w: Math.max(0.005, n(f.w)), h: Math.max(0.005, n(f.h)) };
    if (FIELD_TYPES[f.type].signer) out.role = ['customer', 'cobuyer', 'company'].includes(f.role) ? f.role : 'customer';
    if (f.type === 'data') out.tag = String(f.tag || 'customer.full_name').slice(0, 80);
    if (f.label) out.label = String(f.label).slice(0, 80);
    if (f.fontSize) out.fontSize = Math.max(5, Math.min(36, Number(f.fontSize) || 0)) || undefined;
    if (['left', 'center', 'right'].includes(f.align)) out.align = f.align;
    out.required = FIELD_TYPES[f.type].signer ? f.required !== false : false;
    return out;
  });
}
export const customTags = fields => [...new Set((fields || []).filter(f => f.type === 'data' && String(f.tag).startsWith('custom:')).map(f => String(f.tag).slice(7)))];

/** Every version of a contract (newest first). Revisions share a group: the id of the original contract. */
export function versionsOf(k) {
  const g = k.group_id || k.id;
  return all(`SELECT id, number, revision, status, prev_status, created_at, sent_at, completed_at, superseded_at, voided_at, change_note, total, sale_type, superseded_by
    FROM contracts WHERE id = ? OR group_id = ? ORDER BY COALESCE(revision, 1) DESC, id DESC`, g, g);
}
function contractView(k, req) {
  const signers = all('SELECT * FROM contract_signers WHERE contract_id = ? ORDER BY id', k.id);
  const versions = versionsOf(k);
  const base = req ? (getSettings().public_url || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '') : '';
  return {
    ...k, data: undefined, raw: k.data?.raw, summary: { customer: k.data?.customer?.full_name, shed: k.data?.shed?.description, total: k.data?.pricing?.total, rto: k.data?.rto },
    custom: k.data?.custom, revision: k.revision || 1, versions, latest_id: (versions.find(v => !v.superseded_by) || versions[0])?.id,
    signers: signers.map(s => ({ id: s.id, role: s.role, name: s.name, email: s.email, phone: s.phone, status: s.status, viewed_at: s.viewed_at, signed_at: s.signed_at, link: `${base}/sign/${s.token}` })),
  };
}

async function sendSignerLink(k, s, { sms, email }, req, user) {
  const st = getSettings();
  const base = (st.public_url || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const ctx = { ...k.data, signer: { name: s.name, first_name: signerFirst(s.name) }, link: `${base}/sign/${s.token}` };
  const contact = k.contact_id ? get('SELECT * FROM contacts WHERE id = ?', k.contact_id) : null;
  const useContact = s.role === 'customer' && contact;
  const results = [];
  const revised = (k.revision || 1) > 1; // a revised contract says so, so the customer knows to sign the new one
  if (sms && s.phone) {
    const body = (revised ? 'UPDATED CONTRACT — please use this new link. ' : '') + fill(st.contract_sms || DEFAULT_MESSAGES.contract_sms, ctx);
    const r = useContact && toE164(contact.phone) === toE164(s.phone) ? await messageContact(contact, { channel: 'sms', body, user, contract_id: k.id, baseUrl: base })
      : await sendSMS({ to: s.phone, body, contact_id: useContact ? contact.id : null, user_id: user?.id, contract_id: k.id, baseUrl: base });
    results.push({ channel: 'sms', to: s.phone, ok: r.ok, error: r.error });
    contractEvent(k.id, r.ok ? 'Signing link texted' : 'Text failed', `${s.name} · ${s.phone}${r.ok ? '' : ' — ' + r.error}`, { signer_id: s.id, user_id: user?.id });
  }
  if (email && s.email) {
    const subject = (revised ? 'Updated: ' : '') + fill(st.contract_email_subject || DEFAULT_MESSAGES.contract_email_subject, ctx);
    const body = (revised ? `We've updated your contract${k.change_note ? ` (${k.change_note})` : ''}. Please sign this new version — the earlier link no longer works.\n\n` : '') + fill(st.contract_email_body || DEFAULT_MESSAGES.contract_email_body, ctx);
    const r = useContact && String(contact.email || '').toLowerCase() === String(s.email).toLowerCase() ? await messageContact(contact, { channel: 'email', subject, body, user, contract_id: k.id, baseUrl: base })
      : await sendEmail({ to: s.email, subject, text: body, contact_id: useContact ? contact.id : null, user_id: user?.id, contract_id: k.id, replyTo: user?.email });
    results.push({ channel: 'email', to: s.email, ok: r.ok, error: r.error });
    contractEvent(k.id, r.ok ? 'Signing link emailed' : 'Email failed', `${s.name} · ${s.email}${r.ok ? '' : ' — ' + r.error}`, { signer_id: s.id, user_id: user?.id });
  }
  return results;
}

async function completeContract(k, req) {
  const s = getSettings();
  const fresh = get('SELECT * FROM contracts WHERE id = ?', k.id);
  if (fresh.status === 'completed') return fresh;
  run("UPDATE contracts SET status = 'completed', completed_at = ? WHERE id = ?", nowSql(), k.id);
  contractEvent(k.id, 'Completed', 'All parties signed');
  const done = get('SELECT * FROM contracts WHERE id = ?', k.id);
  const signers = all('SELECT * FROM contract_signers WHERE contract_id = ? ORDER BY id', k.id);
  const events = all('SELECT * FROM contract_events WHERE contract_id = ? ORDER BY id', k.id);
  const bytes = await finalizePdf({ preparedBytes: readFileSync(fpath(done.prepared_file)), fields: done.fields, signers, contract: done, events, tz: s.timezone, company: s.company_name });
  const file = `contracts/${done.number}-signed-${rid(6)}.pdf`;
  writeFileSync(fpath(file), bytes);
  run("UPDATE contracts SET signed_file = ?, signed_hash = ?, updated_at = datetime('now') WHERE id = ?", file, sha256(bytes), k.id);

  // CRM: deal won → production board; quote marked won
  if (done.opportunity_id) moveSalesStage(done.opportunity_id, 'sold', null, 'won');
  if (done.quote_id) run("UPDATE quotes SET status = 'won', updated_at = datetime('now') WHERE id = ?", done.quote_id);
  // a signed revision of an already-sold building updates its existing order instead of adding a second one
  const grp = done.group_id || done.id;
  const prevOrder = get('SELECT * FROM opportunities WHERE pipeline_id = ? AND contract_id IN (SELECT id FROM contracts WHERE id = ? OR group_id = ?) ORDER BY id LIMIT 1', ordersPipeline()?.id, grp, grp);
  let orderId;
  if (prevOrder) {
    run("UPDATE opportunities SET contract_id = ?, quote_id = COALESCE(?, quote_id), title = ?, value = ?, sale_type = ?, updated_at = datetime('now') WHERE id = ?", done.id, done.quote_id, done.data?.shed?.description || done.template_name, done.total || 0, done.sale_type, prevOrder.id);
    addActivity(done.contact_id, 'system', `Order ${prevOrder.order_number} updated to revised contract ${done.number}`, null, prevOrder.id);
    broadcast('opportunity', { id: prevOrder.id }, { perm: 'orders.view' });
    orderId = prevOrder.id;
  } else orderId = createOrder({ contact_id: done.contact_id, quote_id: done.quote_id, contract_id: done.id, title: done.data?.shed?.description || done.template_name, value: done.total, sale_type: done.sale_type, dealer_id: done.dealer_id });
  if (done.data?.custom?.serial_number && orderId) run('UPDATE opportunities SET serial_number = ? WHERE id = ?', done.data.custom.serial_number, orderId);
  if (done.contact_id) addActivity(done.contact_id, 'contract', `Contract ${done.number} signed by all parties (${saleTypeLabel(done.sale_type)}, ${done.data?.pricing?.total || ''})`, null, done.opportunity_id);

  // Signed copy to the customer (and co-buyer)
  const base = (s.public_url || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const attach = [{ filename: `${done.number}-signed.pdf`, content: Buffer.from(bytes), contentType: 'application/pdf' }];
  for (const sg of signers.filter(x => x.role !== 'company')) {
    const ctx = { ...done.data, signer: { name: sg.name, first_name: signerFirst(sg.name) }, link: `${base}/api/sign/${sg.token}/signed.pdf` };
    const contact = sg.role === 'customer' && done.contact_id ? get('SELECT * FROM contacts WHERE id = ?', done.contact_id) : null;
    if (sg.email && s.send_signed_copy !== false) {
      const r = await sendEmail({ to: sg.email, subject: fill(s.signed_customer_email_subject || DEFAULT_MESSAGES.signed_customer_email_subject, ctx), text: fill(s.signed_customer_email_body || DEFAULT_MESSAGES.signed_customer_email_body, ctx), attachments: attach, contact_id: contact?.id, contract_id: done.id });
      contractEvent(done.id, r.ok ? 'Signed copy emailed' : 'Signed copy email failed', `${sg.name} · ${sg.email}${r.ok ? '' : ' — ' + r.error}`, { signer_id: sg.id });
    } else if (sg.phone && s.send_signed_copy !== false && !sg.email) {
      const r = await sendSMS({ to: sg.phone, body: fill(s.signed_customer_sms || DEFAULT_MESSAGES.signed_customer_sms, ctx), contact_id: contact?.id, contract_id: done.id, baseUrl: base });
      contractEvent(done.id, r.ok ? 'Signed copy link texted' : 'Signed copy text failed', `${sg.name} · ${sg.phone}${r.ok ? '' : ' — ' + r.error}`, { signer_id: sg.id });
    }
  }
  // Tell the team (in-app + text/email per Settings → Notifications)
  await notify({ type: 'contract', title: `Contract signed: ${done.data?.customer?.full_name || ''} — ${done.number}`, body: `${done.data?.shed?.description || ''} · ${saleTypeLabel(done.sale_type)} · ${done.data?.pricing?.total || ''}`, link: `#/pos/contracts/${done.id}`, perm: 'pos.view', dealer_id: done.dealer_id, external: s.notify_on_signed !== false }, base);
  if (s.notify_attach_pdf && s.notify_emails) {
    for (const to of String(s.notify_emails).split(/[,;\s]+/).filter(x => /@/.test(x))) await sendEmail({ to, subject: `Signed contract ${done.number} (PDF)`, text: `Signed contract ${done.number} for ${done.data?.customer?.full_name || ''} is attached.`, attachments: attach });
  }
  broadcast('contract', { id: done.id, status: 'completed' }, { perm: 'pos.view' });
  return get('SELECT * FROM contracts WHERE id = ?', k.id);
}

// ---------------------------------------------------------------------------
// Admin router  (/api/pos)
// ---------------------------------------------------------------------------
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 4 } });

export function posRouter({ baseUrl }) {
  const r = express.Router();
  r.use(requireSession);

  r.get('/meta', need('pos.view'), (req, res) => {
    const s = getSettings();
    res.json({ field_types: FIELD_TYPES, tags: TAGS, rto: s.rto || DEFAULT_RTO, cash_deposit_pct: s.cash_deposit_pct ?? 10, tax_rate: s.tax_rate || 0, messaging: messagingStatus(),
      templates: all('SELECT id, name, sale_type, pages, fields, append_drawings, initial_drawings, active FROM contract_templates WHERE active = 1 ORDER BY sale_type, name').map(t => ({ ...t, custom: customTags(t.fields), roles: [...new Set(t.fields.filter(f => f.role).map(f => f.role))], fields: undefined })) });
  });

  // ---- templates
  r.get('/templates', need('pos.view'), (req, res) => res.json(all('SELECT id, name, sale_type, file_name, pages, fields, append_drawings, initial_drawings, active, created_at, updated_at, (SELECT COUNT(*) FROM contracts k WHERE k.template_id = t.id) used FROM contract_templates t ORDER BY active DESC, sale_type, name')));
  r.get('/templates/:id', need('pos.view'), (req, res) => { const t = get('SELECT * FROM contract_templates WHERE id = ?', Number(req.params.id)); t ? res.json(t) : bad(res, 'Not found', 404); });
  r.get('/templates/:id/file.pdf', need('pos.view'), (req, res) => {
    const t = get('SELECT * FROM contract_templates WHERE id = ?', Number(req.params.id)); if (!t || !existsSync(fpath(t.file))) return bad(res, 'Not found', 404);
    res.type('application/pdf').setHeader('Content-Disposition', disposition('inline', t.file_name || 'template.pdf')); res.send(readFileSync(fpath(t.file)));
  });
  const readPdfUpload = async file => {
    if (!file) throw new Error('Choose a PDF file');
    if (!/\.pdf$/i.test(file.originalname) && file.mimetype !== 'application/pdf') throw new Error('Contract templates must be PDF files. In Word or Google Docs use File → Save/Download as PDF.');
    if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('That file is not a valid PDF');
    // LOCKED_PDF tells the admin screen to make an unlocked copy in the browser and try again
    try { return await inspectPdf(file.buffer); } catch (e) { throw new Error(/encrypt/i.test(e.message) ? 'LOCKED_PDF: That PDF is locked (it has a password or editing restrictions).' : 'Could not read that PDF: ' + e.message); }
  };
  r.post('/templates', need('pos.templates'), pdfUpload.single('file'), wrap(async (req, res) => {
    let pages; try { pages = await readPdfUpload(req.file); } catch (e) { return bad(res, e.message); }
    const file = `templates/${rid(9)}.pdf`; writeFileSync(fpath(file), req.file.buffer);
    const sale = ['cash', 'rto', 'any'].includes(req.body.sale_type) ? req.body.sale_type : 'cash';
    const x = run('INSERT INTO contract_templates (name, sale_type, file, file_name, pages) VALUES (?,?,?,?,?)', String(req.body.name || req.file.originalname.replace(/\.pdf$/i, '')).slice(0, 120), sale, file, req.file.originalname.slice(0, 200), JSON.stringify(pages));
    res.status(201).json(get('SELECT * FROM contract_templates WHERE id = ?', Number(x.lastInsertRowid)));
  }));
  r.post('/templates/:id/file', need('pos.templates'), pdfUpload.single('file'), wrap(async (req, res) => {
    const t = get('SELECT * FROM contract_templates WHERE id = ?', Number(req.params.id)); if (!t) return bad(res, 'Not found', 404);
    let pages; try { pages = await readPdfUpload(req.file); } catch (e) { return bad(res, e.message); }
    const file = `templates/${rid(9)}.pdf`; writeFileSync(fpath(file), req.file.buffer);
    const fields = t.fields.filter(f => f.page < pages.length);  // keep placed fields; drop ones on pages that no longer exist
    run("UPDATE contract_templates SET file = ?, file_name = ?, pages = ?, fields = ?, updated_at = datetime('now') WHERE id = ?", file, req.file.originalname.slice(0, 200), JSON.stringify(pages), JSON.stringify(fields), t.id);
    res.json(get('SELECT * FROM contract_templates WHERE id = ?', t.id));
  }));
  r.put('/templates/:id', need('pos.templates'), (req, res) => {
    const t = get('SELECT * FROM contract_templates WHERE id = ?', Number(req.params.id)); if (!t) return bad(res, 'Not found', 404);
    const b = req.body || {};
    let fields = t.fields; if ('fields' in b) { try { fields = cleanFields(b.fields, t.pages.length); } catch (e) { return bad(res, e.message); } }
    const sale = ['cash', 'rto', 'any'].includes(b.sale_type) ? b.sale_type : t.sale_type;
    run("UPDATE contract_templates SET name = ?, sale_type = ?, fields = ?, append_drawings = ?, initial_drawings = ?, active = ?, updated_at = datetime('now') WHERE id = ?",
      String(b.name ?? t.name).slice(0, 120) || t.name, sale, JSON.stringify(fields), 'append_drawings' in b ? (b.append_drawings ? 1 : 0) : t.append_drawings,
      'initial_drawings' in b ? (b.initial_drawings ? 1 : 0) : t.initial_drawings, 'active' in b ? (b.active ? 1 : 0) : t.active, t.id);
    res.json(get('SELECT * FROM contract_templates WHERE id = ?', t.id));
  });
  r.post('/templates/:id/duplicate', need('pos.templates'), (req, res) => {
    const t = get('SELECT * FROM contract_templates WHERE id = ?', Number(req.params.id)); if (!t) return bad(res, 'Not found', 404);
    const file = `templates/${rid(9)}.pdf`; writeFileSync(fpath(file), readFileSync(fpath(t.file)));
    const x = run('INSERT INTO contract_templates (name, sale_type, file, file_name, pages, fields, append_drawings, initial_drawings) VALUES (?,?,?,?,?,?,?,?)', t.name + ' (copy)', t.sale_type, file, t.file_name, JSON.stringify(t.pages), JSON.stringify(t.fields), t.append_drawings, t.initial_drawings);
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.delete('/templates/:id', need('pos.templates'), (req, res) => {
    const t = get('SELECT * FROM contract_templates WHERE id = ?', Number(req.params.id)); if (!t) return bad(res, 'Not found', 404);
    if (get('SELECT id FROM contracts WHERE template_id = ? LIMIT 1', t.id)) { run('UPDATE contract_templates SET active = 0 WHERE id = ?', t.id); return res.json({ archived: true }); }
    try { unlinkSync(fpath(t.file)); } catch { /* gone */ }
    run('DELETE FROM contract_templates WHERE id = ?', t.id); res.sendStatus(204);
  });

  // ---- contracts
  const contractFor = (req, id) => { const k = get('SELECT * FROM contracts WHERE id = ?', Number(id)); return k && inLot(req.user, k) ? k : null; };
  r.get('/contracts', need('pos.view'), (req, res) => {
    const where = ['1=1'], p = [];
    const [lf, lp] = lotFilter(req.user, 'k.dealer_id'); if (lf) { where.push(lf.replace(/^ AND /, '')); p.push(...lp); }
    if (!req.query.all_versions) where.push('k.superseded_by IS NULL'); // one row per sale: its latest version
    if (req.query.status) { where.push('k.status = ?'); p.push(String(req.query.status)); }
    if (req.query.sale_type) { where.push('k.sale_type = ?'); p.push(String(req.query.sale_type)); }
    if (req.query.contact_id) { where.push('k.contact_id = ?'); p.push(Number(req.query.contact_id)); }
    if (req.query.q) { const l = `%${req.query.q}%`; where.push("(k.number LIKE ? OR c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)"); p.push(l, l, l, l); }
    const rows = all(`SELECT k.id, k.number, k.status, k.sale_type, k.total, k.template_name, k.created_at, k.sent_at, k.completed_at, k.contact_id, k.quote_id, k.data, COALESCE(k.revision, 1) revision,
      (SELECT COUNT(*) FROM contracts v WHERE v.id = COALESCE(k.group_id, k.id) OR v.group_id = COALESCE(k.group_id, k.id)) versions,
      c.first_name, c.last_name, c.email, c.phone, u.name created_by_name,
      (SELECT COUNT(*) FROM contract_signers s WHERE s.contract_id = k.id) signers, (SELECT COUNT(*) FROM contract_signers s WHERE s.contract_id = k.id AND s.status = 'signed') signed
      FROM contracts k LEFT JOIN contacts c ON c.id = k.contact_id LEFT JOIN users u ON u.id = k.created_by WHERE ${where.join(' AND ')} ORDER BY k.id DESC LIMIT 500`, ...p);
    res.json(rows.map(k => ({ ...k, shed: k.data?.shed?.description, customer: k.data?.customer?.full_name, monthly: k.data?.rto?.monthly_total, data: undefined })));
  });
  r.get('/contracts/:id', need('pos.view'), (req, res) => {
    const k = contractFor(req, req.params.id); if (!k) return bad(res, 'Not found', 404);
    res.json({ ...contractView(k, req), events: all('SELECT e.*, u.name user_name FROM contract_events e LEFT JOIN users u ON u.id = e.user_id WHERE contract_id = ? ORDER BY e.id', k.id) });
  });
  r.get('/contracts/:id/document.pdf', (req, res) => {
    const k = contractFor(req, req.params.id); if (!k) return bad(res, 'Not found', 404);
    if (!can(req.user, 'contracts.download') && !(can(req.user, 'orders.view') && k.completed_at)) return bad(res, 'Your account does not have access to this.', 403);
    const signed = k.completed_at && k.signed_file && req.query.which !== 'prepared';
    const f = signed ? k.signed_file : k.prepared_file;
    if (!f || !existsSync(fpath(f))) return bad(res, 'File not found', 404);
    const name = `${k.number}${signed ? '-signed' : ''}.pdf`;
    res.type('application/pdf').setHeader('Content-Disposition', disposition(req.query.download ? 'attachment' : 'inline', name));
    res.send(readFileSync(fpath(f)));
  });

  // Create (prepare) a contract. Multipart: payload (JSON) + drawings (PDF built in the browser) + rendering (JPEG) + floorplan (PNG)
  r.post('/contracts', need('pos.create'), pdfUpload.fields([{ name: 'drawings', maxCount: 1 }, { name: 'rendering', maxCount: 1 }, { name: 'floorplan', maxCount: 1 }]), wrap(async (req, res) => {
    let b; try { b = JSON.parse(req.body.payload || '{}'); } catch { return bad(res, 'payload must be JSON'); }
    const s = getSettings();
    // editing a sale = a new version of the same contract; the old one is kept and its links stop working
    let prev = null;
    if (b.revise_of) {
      prev = contractFor(req, b.revise_of);
      if (!prev) return bad(res, 'The contract you are revising was not found', 404);
      if (prev.superseded_by) return bad(res, 'That version was already replaced. Open the latest version and edit that one.');
    }
    const t = get('SELECT * FROM contract_templates WHERE id = ? AND active = 1', Number(b.template_id)); if (!t) return bad(res, 'Pick a contract template');
    const sale_type = b.sale_type === 'rto' ? 'rto' : 'cash';
    if (t.sale_type !== 'any' && t.sale_type !== sale_type) return bad(res, `"${t.name}" is a ${saleTypeLabel(t.sale_type)} template`);
    const q = b.quote_id ? get('SELECT * FROM quotes WHERE id = ?', Number(b.quote_id)) : null;
    if (b.quote_id && !q) return bad(res, 'Quote not found', 404);
    if (q && req.user.dealer_id && req.user.role !== 'admin' && String(q.dealer_id) !== String(req.user.dealer_id)) return bad(res, 'Quote not found', 404);
    let contact = b.contact_id ? get('SELECT * FROM contacts WHERE id = ?', Number(b.contact_id)) : (q?.contact_id ? get('SELECT * FROM contacts WHERE id = ?', q.contact_id) : null);
    if (contact && !inLot(req.user, contact)) return bad(res, 'Contact not found', 404);
    const sg = b.signers || {};
    const cust = sg.customer || {};
    if (!String(cust.name || '').trim()) return bad(res, "Enter the customer's name");
    if (!cust.email && !cust.phone) return bad(res, 'The customer needs an email or a mobile number to receive the signing link');
    if (cust.email && !/^\S+@\S+\.\S+$/.test(cust.email)) return bad(res, "Customer's email looks invalid");
    if (cust.phone && !toE164(cust.phone)) return bad(res, "Customer's mobile number looks invalid");
    if (!contact) contact = upsertContact({ first_name: signerFirst(cust.name), last_name: String(cust.name).trim().split(/\s+/).slice(1).join(' '), email: cust.email, phone: cust.phone }, { source: 'Point of sale', dealer_id: req.user.dealer_id || q?.dealer_id }).contact;
    const roles = new Set(t.fields.filter(f => f.role).map(f => f.role));
    const cob = sg.cobuyer && String(sg.cobuyer.name || '').trim() ? sg.cobuyer : null;
    if (cob && !cob.email && !cob.phone) return bad(res, 'The co-buyer needs an email or a mobile number');
    if (roles.has('cobuyer') && t.fields.some(f => f.role === 'cobuyer' && f.required) && !cob) return bad(res, 'This template needs a co-buyer');
    if (!roles.has('customer')) return bad(res, 'This template has no customer signature fields. Add some in the template designer.');
    // custom values the template asks for
    const custom = {};
    for (const key of customTags(t.fields)) custom[key] = String(b.custom?.[key] ?? '').slice(0, 500);
    if (b.custom?.serial_number) custom.serial_number = String(b.custom.serial_number).slice(0, 100);
    // money
    const fq = q ? formatQuote(q, baseUrl(req)) : null;
    const p = q?.pricing || {};
    const total = Number(p.total ?? q?.total ?? b.total) || 0;
    const rtoCfg = s.rto || DEFAULT_RTO;
    const rto = sale_type === 'rto' ? { ...rtoCalc((Number(p.subtotal) || 0) + (Number(p.delivery) || 0) || total, b.rto?.term_months, rtoCfg, s.tax_rate, Number(b.rto?.monthly_override) || null), first_payment_date: String(b.rto?.first_payment_date || '').slice(0, 40) } : null;
    const cash = { deposit: b.cash?.deposit != null && b.cash.deposit !== '' ? Number(b.cash.deposit) : Math.round(total * (Number(s.cash_deposit_pct) || 0)) / 100 };
    if (sale_type === 'cash' && (!Number.isFinite(cash.deposit) || cash.deposit < 0)) return bad(res, "The deposit can't be negative.");
    if (sale_type === 'cash' && total > 0 && cash.deposit > total + 0.005) return bad(res, `The deposit ($${cash.deposit.toFixed(2)}) is more than the contract total ($${total.toFixed(2)}).`);
    if (sale_type === 'rto' && b.rto?.monthly_override != null && b.rto.monthly_override !== '' && !(Number(b.rto.monthly_override) > 0)) return bad(res, 'The monthly payment override must be more than $0.');
    // insert first to get the number
    const group = prev ? (prev.group_id || prev.id) : null;
    const revision = prev ? (get('SELECT MAX(COALESCE(revision, 1)) r FROM contracts WHERE id = ? OR group_id = ?', group, group).r || 1) + 1 : 1;
    const saved = { quote_id: q?.id || null, contact_id: contact.id, template_id: t.id, sale_type, signers: { customer: cust, cobuyer: cob }, company_signer_id: b.company_signer_id || null, custom, rto: b.rto || null, cash: b.cash || null };
    const x = run('INSERT INTO contracts (quote_id, contact_id, template_id, template_name, sale_type, status, total, dealer_id, created_by, group_id, revision, payload, change_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      q?.id || null, contact.id, t.id, t.name, sale_type, 'draft', total, q?.dealer_id || contact.dealer_id || req.user.dealer_id || prev?.dealer_id || null, req.user.id,
      group, revision, JSON.stringify(saved), prev ? String(b.change_note || '').slice(0, 300) : null);
    const id = Number(x.lastInsertRowid);
    const number = prev ? `${get('SELECT number FROM contracts WHERE id = ?', group).number}-R${revision}` : 'C-' + (10000 + id);
    try {
      const signers = { customer: cust, cobuyer: cob };
      const data = buildData({ q, fq, contact, sale_type, signers, rto, cash, custom, user: req.user, number, s });
      const drawings = req.files?.drawings?.[0]?.buffer || null;
      const rendering = req.files?.rendering?.[0]?.buffer || null, floorplan = req.files?.floorplan?.[0]?.buffer || null;
      if (drawings && drawings.subarray(0, 5).toString() !== '%PDF-') throw new Error('Drawings file is not a PDF');
      if (rendering && !(rendering[0] === 0xff && rendering[1] === 0xd8)) throw new Error('3D rendering must be a JPEG');
      if (floorplan && floorplan.subarray(1, 4).toString() !== 'PNG') throw new Error('Floor plan image must be a PNG');
      const prep = await preparePdf({ templateBytes: readFileSync(fpath(t.file)), fields: t.fields, data, rendering, floorplan, drawingsBytes: drawings, appendDrawings: !!t.append_drawings });
      // initials box on each appended drawing sheet
      const fields = [...t.fields];
      if (t.append_drawings && t.initial_drawings && drawings) for (let i = prep.templatePages; i < prep.pages.length; i++) fields.push({ id: 'dwg' + i, type: 'initials', role: 'customer', page: i, ...DRAWING_INITIALS_BOX, x: DRAWING_INITIALS_BOX.x + 0.004, y: DRAWING_INITIALS_BOX.y + 0.016, w: DRAWING_INITIALS_BOX.w - 0.008, h: DRAWING_INITIALS_BOX.h - 0.02, required: true, label: 'Initial to approve this drawing' });
      const file = `contracts/${number}-${rid(6)}.pdf`; writeFileSync(fpath(file), prep.bytes);
      const opp = (q && get("SELECT id FROM opportunities WHERE quote_id = ? AND pipeline_id = ? ORDER BY id DESC LIMIT 1", q.id, salesPipeline()?.id)) || get("SELECT id FROM opportunities WHERE contact_id = ? AND pipeline_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", contact.id, salesPipeline()?.id);
      const days = Number(s.contract_link_days) || 30;
      run(`UPDATE contracts SET number = ?, data = ?, fields = ?, pages = ?, prepared_file = ?, prepared_hash = ?, opportunity_id = ?, expires_at = datetime('now', ?) WHERE id = ?`,
        number, JSON.stringify(data), JSON.stringify(fields), JSON.stringify(prep.pages), file, sha256(prep.bytes), opp?.id || null, `+${days} days`, id);
      const addSigner = (role, p2, user_id = null) => run('INSERT INTO contract_signers (contract_id, role, name, email, phone, token, user_id) VALUES (?,?,?,?,?,?,?)', id, role, String(p2.name || '').slice(0, 120), p2.email ? String(p2.email).toLowerCase().slice(0, 200) : null, p2.phone ? String(p2.phone).slice(0, 40) : null, rid(), user_id);
      addSigner('customer', cust);
      if (cob && roles.has('cobuyer')) addSigner('cobuyer', cob);
      if (roles.has('company')) {
        const rep = b.company_signer_id ? get('SELECT * FROM users WHERE id = ?', Number(b.company_signer_id)) : get('SELECT * FROM users WHERE id = ?', req.user.id);
        addSigner('company', { name: rep?.name || rep?.email || 'Sales rep', email: rep?.email, phone: rep?.phone }, rep?.id);
      }
      contractEvent(id, prev ? `Created as revision ${revision} of ${prev.number}` : 'Created', `${t.name} · ${saleTypeLabel(sale_type)} · ${usd(total)}${prev && b.change_note ? ' · ' + String(b.change_note).slice(0, 300) : ''}`, { req, user_id: req.user.id });
      if (prev) {
        run("UPDATE contracts SET prev_status = status, status = 'superseded', superseded_by = ?, superseded_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", id, prev.id);
        contractEvent(prev.id, 'Replaced by a revised version', `${number}${b.change_note ? ' · ' + String(b.change_note).slice(0, 300) : ''} — this version's signing links no longer work`, { req, user_id: req.user.id });
      }
      addActivity(contact.id, 'contract', `Contract ${number} ${prev ? `prepared as a revision of ${prev.number}${b.change_note ? ' — ' + String(b.change_note).slice(0, 200) : ''}` : 'prepared'} (${saleTypeLabel(sale_type)}, ${usd(total)}${rto ? `, ${rto.term_months} mo at ${usd(rto.monthly_total)}` : ''})`, req.user.id, opp?.id || null);
    } catch (e) {
      run('DELETE FROM contracts WHERE id = ?', id);
      return bad(res, 'Could not prepare the contract: ' + e.message);
    }
    broadcast('contract', { id, status: 'draft' }, { perm: 'pos.view' });
    res.status(201).json(contractView(get('SELECT * FROM contracts WHERE id = ?', id), req));
  }));

  r.post('/contracts/:id/send', need('pos.create'), wrap(async (req, res) => {
    const k = contractFor(req, req.params.id); if (!k) return bad(res, 'Not found', 404);
    if (['completed', 'void', 'superseded'].includes(k.status)) return bad(res, k.status === 'superseded' ? 'This version was replaced. Send the latest version instead.' : `This contract is ${k.status === 'void' ? 'void' : 'already signed'}`);
    const { sms = true, email = true, signer_ids } = req.body || {};
    if (!sms && !email) return bad(res, 'Pick text, email or both');
    const signers = all("SELECT * FROM contract_signers WHERE contract_id = ? AND status != 'signed'", k.id).filter(s => (signer_ids ? signer_ids.map(Number).includes(s.id) : s.role !== 'company'));
    if (!signers.length) return bad(res, 'Nobody left to send to');
    const results = [];
    for (const s of signers) results.push(...await sendSignerLink(k, s, { sms, email }, req, req.user));
    const okAny = results.some(x => x.ok);
    if (okAny) {
      run("UPDATE contracts SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, datetime('now')), expires_at = datetime('now', ?), updated_at = datetime('now') WHERE id = ?", `+${Number(getSettings().contract_link_days) || 30} days`, k.id);
      if (k.opportunity_id) moveSalesStage(k.opportunity_id, 'contract', req.user.id);
      if (k.contact_id) addActivity(k.contact_id, 'contract', `Contract ${k.number} sent for signature (${results.filter(x => x.ok).map(x => x.channel === 'sms' ? 'text' : 'email').join(' + ')})`, req.user.id, k.opportunity_id);
    }
    broadcast('contract', { id: k.id }, { perm: 'pos.view' });
    res.status(okAny ? 200 : 502).json({ ok: okAny, results, ...(okAny ? {} : { error: results.map(x => x.error).filter(Boolean).join('; ') || 'Nothing was sent' }) });
  }));
  // in-person signing at the lot: mark as sent and hand back the signer's link
  r.post('/contracts/:id/sign-in-person', need('pos.create'), (req, res) => {
    const k = contractFor(req, req.params.id); if (!k) return bad(res, 'Not found', 404);
    if (['completed', 'void', 'superseded'].includes(k.status)) return bad(res, k.status === 'superseded' ? 'This version was replaced. Use the latest version.' : `This contract is ${k.status === 'void' ? 'void' : 'already signed'}`);
    const s = get('SELECT * FROM contract_signers WHERE id = ? AND contract_id = ?', Number(req.body?.signer_id), k.id); if (!s) return bad(res, 'Signer not found', 404);
    if (s.role === 'company' && s.user_id && s.user_id !== req.user.id && req.user.role !== 'admin') return bad(res, 'Only the assigned rep can sign for the company', 403);
    run("UPDATE contracts SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, datetime('now')), expires_at = MAX(COALESCE(expires_at, ''), datetime('now', '+1 day')) WHERE id = ?", k.id);
    contractEvent(k.id, 'In-person signing started', `${s.name} (${s.role}) on ${req.user.name || req.user.email}'s device`, { req, signer_id: s.id, user_id: req.user.id });
    if (k.opportunity_id && s.role !== 'company') moveSalesStage(k.opportunity_id, 'contract', req.user.id);
    res.json({ url: `/sign/${s.token}` });
  });
  r.patch('/contracts/:id/signers/:sid', need('pos.create'), (req, res) => {
    const k = contractFor(req, req.params.id); if (!k) return bad(res, 'Not found', 404);
    const s = get('SELECT * FROM contract_signers WHERE id = ? AND contract_id = ?', Number(req.params.sid), k.id); if (!s) return bad(res, 'Signer not found', 404);
    if (s.status === 'signed') return bad(res, 'Already signed');
    const b = req.body || {};
    if (b.email && !/^\S+@\S+\.\S+$/.test(b.email)) return bad(res, 'Email looks invalid');
    if (b.phone && !toE164(b.phone)) return bad(res, 'Mobile number looks invalid');
    run('UPDATE contract_signers SET email = COALESCE(?, email), phone = COALESCE(?, phone) WHERE id = ?', b.email ? String(b.email).toLowerCase() : null, b.phone || null, s.id);
    contractEvent(k.id, 'Signer details changed', `${s.name}: ${[b.email, b.phone].filter(Boolean).join(', ')}`, { req, signer_id: s.id, user_id: req.user.id });
    res.json({ ok: true });
  });
  r.post('/contracts/:id/void', need('pos.void'), (req, res) => {
    const k = contractFor(req, req.params.id); if (!k) return bad(res, 'Not found', 404);
    if (k.status === 'completed' && req.user.role !== 'admin') return bad(res, 'Only an admin can void a signed contract', 403);
    if (k.status === 'void') return bad(res, 'Already void');
    if (k.status === 'superseded') return bad(res, 'This version was already replaced by a newer one.');
    const reason = String(req.body?.reason || '').slice(0, 300);
    run("UPDATE contracts SET status = 'void', voided_at = datetime('now'), void_reason = ? WHERE id = ?", reason, k.id);
    contractEvent(k.id, 'Voided', reason, { req, user_id: req.user.id });
    if (k.contact_id) addActivity(k.contact_id, 'contract', `Contract ${k.number} voided${reason ? ': ' + reason : ''}`, req.user.id, k.opportunity_id);
    broadcast('contract', { id: k.id }, { perm: 'pos.view' });
    res.json({ ok: true });
  });
  r.delete('/contracts/:id', need('pos.create'), (req, res) => {
    const k = contractFor(req, req.params.id); if (!k) return bad(res, 'Not found', 404);
    if (k.status !== 'draft' && req.user.role !== 'admin') return bad(res, 'Only drafts can be deleted. Void it instead.');
    if (k.status === 'completed' || k.completed_at) return bad(res, "Signed contracts can't be deleted. Void it instead.");
    if (k.status === 'superseded') return bad(res, 'Earlier versions are kept as a record and cannot be deleted.');
    for (const f of [k.prepared_file, k.signed_file]) if (f) try { unlinkSync(fpath(f)); } catch { /* gone */ }
    run('DELETE FROM contracts WHERE id = ?', k.id);
    // deleting an unsent revision brings the version it replaced back as the latest
    const restored = get('SELECT * FROM contracts WHERE superseded_by = ?', k.id);
    if (restored) {
      run("UPDATE contracts SET status = COALESCE(prev_status, 'draft'), prev_status = NULL, superseded_by = NULL, superseded_at = NULL WHERE id = ?", restored.id);
      contractEvent(restored.id, 'Revision deleted', `${k.number} was deleted, so this version is the latest again`, { req, user_id: req.user.id });
    }
    broadcast('contract', { id: k.id, deleted: true }, { perm: 'pos.view' });
    res.sendStatus(204);
  });
  return r;
}

// ---------------------------------------------------------------------------
// Public signing API  (/api/sign/:token) — the link customers get by text / email
// ---------------------------------------------------------------------------
export function signRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '6mb' }));
  const load = (req, res) => {
    const s = get('SELECT * FROM contract_signers WHERE token = ?', String(req.params.token || ''));
    const k = s && get('SELECT * FROM contracts WHERE id = ?', s.contract_id);
    if (!s || !k) { bad(res, 'This signing link is not valid. Ask your sales rep for a new one.', 404); return null; }
    return { s, k };
  };
  // a replaced version points its signers to the same person's link on the newest version
  const replacement = (k, s) => {
    if (k.status !== 'superseded') return null;
    const g = k.group_id || k.id;
    const latest = get('SELECT * FROM contracts WHERE (id = ? OR group_id = ?) AND superseded_by IS NULL ORDER BY id DESC LIMIT 1', g, g);
    if (!latest || latest.status === 'void') return null;
    const sg = get('SELECT token FROM contract_signers WHERE contract_id = ? AND role = ?', latest.id, s.role);
    return sg ? { number: latest.number, link: `/sign/${sg.token}` } : null;
  };
  const expired = k => k.expires_at && k.status !== 'completed' && new Date(k.expires_at.replace(' ', 'T') + 'Z') < new Date();

  r.get('/:token', (req, res) => {
    const x = load(req, res); if (!x) return; const { s, k } = x;
    const st = getSettings();
    const others = all('SELECT role, name, status FROM contract_signers WHERE contract_id = ? AND id != ?', k.id, s.id);
    res.set('Cache-Control', 'no-store');
    res.json({
      company: { name: st.company_name || '', logo_url: st.logo_url || '', brand_color: st.brand_color || '#2f6b4f', phone: st.phone || '' },
      contract: { number: k.number, status: k.status, sale_type: k.sale_type, template_name: k.template_name, shed: k.data?.shed?.description, total: k.data?.pricing?.total, rto: k.sale_type === 'rto' ? k.data?.rto : null, expired: expired(k), void_reason: k.status === 'void' ? k.void_reason : undefined, replaced_by: replacement(k, s) },
      signer: { role: s.role, name: s.name, status: s.status, signed_at: s.signed_at },
      others, pages: k.pages,
      fields: k.fields.filter(f => FIELD_TYPES[f.type]?.signer).map(f => ({ id: f.id, type: f.type, role: f.role, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label, mine: f.role === s.role })),
      consent_text: st.esign_consent_text || `I agree to use electronic records and signatures for this agreement with ${st.company_name || 'the seller'}, and that my electronic signature is the legal equivalent of my handwritten signature. I can ask for a paper copy at any time.`,
      signed_pdf: k.status === 'completed' ? `/api/sign/${s.token}/signed.pdf` : null,
    });
  });
  r.get('/:token/document.pdf', (req, res) => {
    const x = load(req, res); if (!x) return; const { k } = x;
    if (k.status === 'void') return bad(res, 'This contract was voided', 410);
    const f = k.completed_at && k.signed_file ? k.signed_file : k.prepared_file;
    res.set('Cache-Control', 'no-store'); res.type('application/pdf').setHeader('Content-Disposition', disposition('inline', `${k.number}.pdf`));
    res.send(readFileSync(fpath(f)));
  });
  r.get('/:token/signed.pdf', (req, res) => {
    const x = load(req, res); if (!x) return; const { k } = x;
    if (!k.completed_at || !k.signed_file) return bad(res, 'Not everyone has signed yet', 409);
    res.set('Cache-Control', 'no-store'); res.type('application/pdf').setHeader('Content-Disposition', disposition('attachment', `${k.number}-signed.pdf`));
    res.send(readFileSync(fpath(k.signed_file)));
  });
  r.post('/:token/viewed', (req, res) => {
    const x = load(req, res); if (!x) return; const { s, k } = x;
    if (['void', 'completed'].includes(k.status) || s.status === 'signed') return res.json({ ok: true });
    if (!s.viewed_at) {
      run("UPDATE contract_signers SET viewed_at = datetime('now'), status = CASE WHEN status = 'pending' THEN 'viewed' ELSE status END WHERE id = ?", s.id);
      if (['draft', 'sent'].includes(k.status)) run("UPDATE contracts SET status = 'viewed' WHERE id = ?", k.id);
      contractEvent(k.id, 'Viewed', `${s.name} (${s.role})`, { req, signer_id: s.id });
      broadcast('contract', { id: k.id }, { perm: 'pos.view' });
    }
    res.json({ ok: true });
  });
  r.post('/:token/sign', wrap(async (req, res) => {
    const x = load(req, res); if (!x) return; const { s, k } = x;
    if (k.status === 'void') return bad(res, 'This contract was voided and can no longer be signed.', 410);
    if (k.status === 'superseded') return bad(res, 'This contract was replaced by an updated version. Please use the newest link you were sent.', 410);
    if (s.status === 'signed') return bad(res, 'You already signed this contract.', 409);
    if (expired(k)) return bad(res, 'This signing link has expired. Ask your sales rep to send a new one.', 410);
    const b = req.body || {};
    if (b.consent !== true) return bad(res, 'Please agree to sign electronically.');
    const mine = k.fields.filter(f => FIELD_TYPES[f.type]?.signer && f.role === s.role);
    const values = {};
    for (const f of mine) {
      const v = (b.values || {})[f.id];
      if (f.type === 'signature' || f.type === 'initials') {
        if (v) {
          if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 1_500_000) return bad(res, 'Signature image is not valid. Please sign again.');
          values[f.id] = v;
        } else if (f.required) return bad(res, `Please ${f.type === 'initials' ? 'initial' : 'sign'} every highlighted ${f.type === 'initials' ? 'initials box' : 'signature box'}.`);
      } else if (f.type === 'text') {
        const t = String(v ?? '').trim().slice(0, 500);
        if (!t && f.required) return bad(res, `Please fill in "${f.label || 'the highlighted text box'}".`);
        if (t) values[f.id] = t;
      } else if (f.type === 'checkbox') {
        if (f.required && v !== true) return bad(res, 'Please tick every required checkbox.');
        values[f.id] = v === true;
      }
    }
    // atomic claim so two taps can't sign twice
    const claim = run("UPDATE contract_signers SET status = 'signed', values_json = ?, signed_at = datetime('now'), consent_at = datetime('now'), ip = ?, user_agent = ? WHERE id = ? AND status != 'signed'",
      JSON.stringify(values), ipOf(req), String(req.get('user-agent') || '').slice(0, 300), s.id);
    if (!claim.changes) return bad(res, 'You already signed this contract.', 409);
    contractEvent(k.id, 'Agreed to sign electronically', s.name, { req, signer_id: s.id });
    contractEvent(k.id, 'Signed', `${s.name} (${s.role})`, { req, signer_id: s.id });
    if (k.contact_id && s.role !== 'company') addActivity(k.contact_id, 'contract', `${s.name} signed contract ${k.number}`, null, k.opportunity_id);
    const left = get("SELECT COUNT(*) n FROM contract_signers WHERE contract_id = ? AND status != 'signed'", k.id).n;
    let done = null;
    if (!left) done = await completeContract(k, req);
    else {
      run("UPDATE contracts SET status = 'partial', updated_at = datetime('now') WHERE id = ? AND status != 'completed'", k.id);
      const st = getSettings();
      notify({ type: 'contract', title: `${s.name} signed ${k.number}`, body: `Waiting on ${left} more signer${left === 1 ? '' : 's'}`, link: `#/pos/contracts/${k.id}`, perm: 'pos.view', dealer_id: k.dealer_id, external: st.notify_on_signed !== false && !!st.notify_each_signer }).catch(() => {});
      broadcast('contract', { id: k.id }, { perm: 'pos.view' });
    }
    res.json({ ok: true, completed: !!done, waiting_on: left, signed_pdf: done ? `/api/sign/${s.token}/signed.pdf` : null });
  }));
  return r;
}
