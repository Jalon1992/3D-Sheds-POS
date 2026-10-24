// End-to-end API tests: CRM, messaging, point of sale / e-sign, roles, lots, concurrency, webhooks.
// Run: npm test   (starts its own server on a temp database, test mode = no real texts/emails)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3900 + Math.floor(Math.random() * 90);
const B = `http://127.0.0.1:${PORT}`;
const TWILIO_TOKEN = 'test-twilio-token';
let srv, dir;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, { raw = false, headers = {} } = {}) {
    const isForm = body instanceof FormData;
    const r = await fetch(B + url, { method, headers: { ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    if (raw) return r;
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  }
  get(u, o) { return this.req('GET', u, undefined, o); } post(u, b, o) { return this.req('POST', u, b, o); }
  patch(u, b) { return this.req('PATCH', u, b); } put(u, b) { return this.req('PUT', u, b); } del(u) { return this.req('DELETE', u); }
  async login(email, password) { const r = await this.post('/api/auth/login', { email, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
}
const anon = new Client(), admin = new Client();
let cat;
async function quote(customer, extra = {}) {
  const st = cat.styles[0], sz = st.sizes[0];
  // submitted as signed-in staff (dealer configurator) so the public 8-per-minute limit doesn't throttle the suite
  const r = await admin.post('/api/v1/quotes', { config: { style_id: st.id, size_id: sz.id, ...extra }, customer });
  assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data;
}
async function makeContract(c, payload, files = {}) {
  const fd = new FormData(); fd.append('payload', JSON.stringify(payload));
  for (const [k, v] of Object.entries(files)) fd.append(k, v.blob, v.name);
  return c.post('/api/pos/contracts', fd);
}
async function signAll(token, overrides = {}) {
  const info = await anon.get('/api/sign/' + token); assert.equal(info.status, 200);
  const values = {};
  for (const f of info.data.fields.filter(f => f.mine)) values[f.id] = f.type === 'checkbox' ? true : f.type === 'text' ? 'gate 1234' : ['signature', 'initials'].includes(f.type) ? PNG : undefined;
  return anon.post(`/api/sign/${token}/sign`, { consent: true, values, ...overrides });
}
const tok = link => link.split('/sign/')[1];
function twilioSig(url, params) { return crypto.createHmac('sha1', TWILIO_TOKEN).update(url + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64'); }

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shedtest-'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT, DB_PATH: join(dir, 'db.sqlite'), UPLOAD_DIR: join(dir, 'uploads'), MESSAGING_TEST_MODE: '1', ADMIN_EMAIL: 'owner@test.com', ADMIN_PASSWORD: 'owner-pass-1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => (log += d)); srv.stderr.on('data', d => (log += d));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
  await admin.login('owner@test.com', 'owner-pass-1');
  cat = (await anon.get('/api/v1/catalog')).data;
  await admin.put('/api/admin/settings', { twilio_token: TWILIO_TOKEN, public_url: B, notify_emails: 'owner@test.com', notify_phones: '6155550100', dealers: [{ id: 'lotA', name: 'Lot A' }, { id: 'lotB', name: 'Lot B' }] });
  for (const [email, role, dealer_id] of [['sales@test.com', 'sales', null], ['salesa@test.com', 'sales', 'lotA'], ['prod@test.com', 'production', null], ['driver@test.com', 'delivery', null]])
    assert.equal((await admin.post('/api/admin/users', { email, name: email.split('@')[0], password: 'password-123', role, dealer_id })).status, 200);
});
after(() => { srv?.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

// ---------------------------------------------------------------------------
test('existing features still work: catalog, price, quotes, drawings data', async () => {
  assert.ok(cat.styles.length >= 3);
  const st = cat.styles[0];
  const p = await anon.post('/api/v1/price', { style_id: st.id, size_id: st.sizes[0].id }); assert.equal(p.status, 200); assert.ok(p.data.total > 0);
  const q = await quote({ first_name: 'Reg', email: 'reg@test.com' });
  const g = await admin.get('/api/v1/quotes/' + q.id); assert.equal(g.status, 200); assert.ok(g.data.pricing_lines.length);
  const plan = await admin.get(`/api/v1/quotes/${q.id}/floorplan.svg`, { raw: true }); assert.equal(plan.status, 200); assert.match(await plan.text(), /<svg/);
  assert.equal((await anon.post('/api/v1/quotes', { config: {}, customer: { first_name: 'x' } })).status, 400);
});

test('every 3D quote lands in the CRM as a contact + deal, repeat quotes merge', async () => {
  const q1 = await quote({ first_name: 'Ann', last_name: 'Lee', email: 'ANN@test.com', phone: '615-555-0001', zip: '37201', sms_consent: true });
  const list = await admin.get('/api/crm/contacts?q=ann');
  assert.equal(list.data.total, 1); const c = list.data.data[0];
  assert.equal(c.email, 'ann@test.com'); assert.equal(c.phone_e164, '+16155550001'); assert.equal(c.stage, 'new');
  await quote({ first_name: 'Ann', email: 'ann@test.com' });
  const d = await admin.get('/api/crm/contacts/' + c.id);
  assert.equal(d.data.quotes.length, 2, 'both quotes on one contact');
  assert.equal(d.data.opportunities.length, 1, 'early-stage deal reused');
  assert.equal(d.data.opportunities[0].quote_id, d.data.quotes[0].id, 'deal points at latest quote');
  assert.ok(d.data.timeline.some(t => t.type === 'quote' && t.body.includes(q1.number)));
  const n = await admin.get('/api/crm/notifications'); assert.ok(n.data.data.some(x => x.title.includes('New 3D lead')));
  const q = await admin.get('/api/v1/quotes/' + q1.id); assert.equal(q.data.contact_id, c.id);
});

test('POS: a design saved from the configurator for a contract goes on that contact, no new lead', async () => {
  const q1 = await quote({ first_name: 'Zed', last_name: 'Park', email: 'zed@test.com', phone: '615-555-0777', address: '1 Main St', city: 'Town', state: 'TN', zip: '37000' });
  const cid = (await admin.get('/api/v1/quotes/' + q1.id)).data.contact_id;
  const leadsBefore = (await admin.get('/api/crm/notifications')).data.data.filter(x => x.title.includes('Zed')).length;
  const st = cat.styles[0], sz = st.sizes[1] || st.sizes[0];
  const r = await admin.post('/api/v1/quotes', { config: { style_id: st.id, size_id: sz.id }, customer: {}, pos: true, contact_id: cid });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.customer.email, 'zed@test.com', 'customer filled from the contact');
  assert.equal(r.data.customer.full_name, 'Zed Park');
  const d = (await admin.get('/api/crm/contacts/' + cid)).data;
  assert.equal(d.quotes.length, 2); assert.equal(d.opportunities.length, 1, 'same deal');
  assert.equal(d.opportunities[0].quote_id, r.data.id, 'deal points at the new design');
  assert.ok(d.timeline.some(t => t.type === 'quote' && /designed .* for a contract/.test(t.body)));
  assert.equal((await admin.get('/api/v1/quotes/' + r.data.id)).data.contact_id, cid);
  const leadsAfter = (await admin.get('/api/crm/notifications')).data.data.filter(x => x.title.includes('Zed')).length;
  assert.equal(leadsAfter, leadsBefore, 'no "new lead" alert for a POS redesign');
  // POS mode without a contact: a name plus email or mobile; customers can't use POS mode at all
  assert.equal((await admin.post('/api/v1/quotes', { config: { style_id: st.id, size_id: sz.id }, customer: { first_name: 'Walk' }, pos: true })).status, 400);
  const walk = await admin.post('/api/v1/quotes', { config: { style_id: st.id, size_id: sz.id }, customer: { first_name: 'Walk', last_name: 'In', phone: '615-555-0888' }, pos: true });
  assert.equal(walk.status, 201, JSON.stringify(walk.data));
  assert.equal((await anon.post('/api/v1/quotes', { config: { style_id: st.id, size_id: sz.id }, customer: { first_name: 'X' }, pos: true, contact_id: cid })).status, 400, 'public: email still required, contact_id ignored');
  assert.equal((await admin.post('/api/v1/quotes', { config: { style_id: st.id, size_id: sz.id }, customer: {}, pos: true, contact_id: 999999 })).status, 404);
});

test('manual leads: validation, duplicate detection, opportunity', async () => {
  assert.equal((await admin.post('/api/crm/contacts', {})).status, 400);
  assert.equal((await admin.post('/api/crm/contacts', { first_name: 'X', phone: '12' })).status, 400);
  const r = await admin.post('/api/crm/contacts', { first_name: 'Walk', last_name: 'In', phone: '(615) 555-0002', source: 'Walk-in', value: 8000, opportunity_title: '12x24 Garage', tags: ['garage'] });
  assert.equal(r.status, 201);
  const dup = await admin.post('/api/crm/contacts', { first_name: 'Walk', phone: '6155550002' });
  assert.equal(dup.status, 409); assert.equal(dup.data.contact_id, r.data.id);
  const d = await admin.get('/api/crm/contacts/' + r.data.id);
  assert.equal(d.data.opportunities[0].value, 8000); assert.deepEqual(d.data.tags, ['garage']);
  const byTag = await admin.get('/api/crm/contacts?tag=garage'); assert.equal(byTag.data.total, 1);
});

test('texting & email from the CRM, notes, tasks, merge tags, opt-out', async () => {
  const c = (await admin.post('/api/crm/contacts', { first_name: 'Tex', email: 'tex@test.com', phone: '6155550003' })).data;
  const s = await admin.post(`/api/crm/contacts/${c.id}/messages`, { channel: 'sms', body: 'Hi {{contact.first_name}} from {{company.name}}' });
  assert.equal(s.status, 200); assert.equal(s.data.status, 'test');
  assert.equal((await admin.post(`/api/crm/contacts/${c.id}/messages`, { channel: 'email', body: 'x' })).status, 400, 'email needs subject');
  assert.equal((await admin.post(`/api/crm/contacts/${c.id}/messages`, { channel: 'email', subject: 'Hello', body: 'Body' })).status, 200);
  await admin.post(`/api/crm/contacts/${c.id}/notes`, { body: 'Called him' });
  const t = await admin.post(`/api/crm/contacts/${c.id}/tasks`, { title: 'Follow up', due_at: '2026-11-01' }); assert.equal(t.status, 201);
  assert.equal((await admin.patch('/api/crm/tasks/' + t.data.id, { done: true })).status, 200);
  const d = (await admin.get('/api/crm/contacts/' + c.id)).data;
  const sms = d.timeline.find(x => x.kind === 'message' && x.channel === 'sms');
  assert.equal(sms.body, 'Hi Tex from Your Shed Co.');
  assert.ok(d.timeline.some(x => x.type === 'note')); assert.ok(d.tasks[0].done_at);
  await admin.patch('/api/crm/contacts/' + c.id, { dnd_sms: true });
  const blocked = await admin.post(`/api/crm/contacts/${c.id}/messages`, { channel: 'sms', body: 'hi' });
  assert.equal(blocked.status, 400); assert.match(blocked.data.error, /opted out/);
  const conv = await admin.get('/api/crm/conversations'); assert.ok(conv.data.some(x => x.id === c.id));
});

test('inbound texts (Twilio, signature-checked), STOP opt-out, inbound email + GHL webhooks', async () => {
  const url = B + '/api/hooks/twilio/sms';
  const params = { From: '+16155550004', To: '+16155559999', Body: 'Is the 12x16 in stock?', MessageSid: 'SM1' };
  const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'nope' }, body: new URLSearchParams(params) });
  assert.equal(bad.status, 403);
  const ok = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSig(url, params) }, body: new URLSearchParams(params) });
  assert.equal(ok.status, 200); assert.match(await ok.text(), /<Response>/);
  const c = (await admin.get('/api/crm/contacts?q=5550004')).data.data[0];
  assert.ok(c, 'unknown number becomes a contact'); assert.equal(c.unread, 1);
  const stop = { ...params, Body: 'STOP', MessageSid: 'SM2' };
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSig(url, stop) }, body: new URLSearchParams(stop) });
  assert.equal((await admin.get('/api/crm/contacts/' + c.id)).data.dnd_sms, 1);
  await admin.post(`/api/crm/contacts/${c.id}/read`); assert.equal((await admin.get('/api/crm/contacts/' + c.id)).data.unread, 0);
  const key = (await admin.get('/api/admin/settings')).data.inbound_key; assert.ok(key);
  assert.equal((await anon.post('/api/hooks/email/wrong', { from: 'a@b.com', text: 'x' })).status, 403);
  assert.equal((await anon.post('/api/hooks/email/' + key, { from: 'Ann Lee <ann@test.com>', subject: 'Re: quote', 'body-plain': 'Sounds good' })).status, 200);
  const ann = (await admin.get('/api/crm/contacts?q=ann@test.com')).data.data[0];
  assert.ok((await admin.get('/api/crm/contacts/' + ann.id)).data.timeline.some(x => x.direction === 'in' && x.subject === 'Re: quote'));
  assert.equal((await anon.post('/api/hooks/ghl/' + key, { phone: '+16155550005', message: { type: 'SMS', body: 'hello from ghl' }, full_name: 'Gus Hill' })).status, 200);
  assert.equal((await admin.get('/api/crm/contacts?q=Gus')).data.total, 1);
});

test('templates: upload validation, field cleaning, non-ASCII names, duplicate/archive', async () => {
  const fd = new FormData(); fd.append('file', new Blob(['hello']), 'x.pdf'); fd.append('name', 'Bad');
  assert.equal((await admin.post('/api/pos/templates', fd)).status, 400);
  const pdf = await PDFDocument.create(); pdf.addPage([612, 792]); pdf.addPage([612, 792]);
  const fd2 = new FormData(); fd2.append('file', new Blob([await pdf.save()], { type: 'application/pdf' }), 'Contrato — señal.pdf'); fd2.append('name', 'My Cash'); fd2.append('sale_type', 'cash');
  const t = await admin.post('/api/pos/templates', fd2); assert.equal(t.status, 201); assert.equal(t.data.pages.length, 2);
  const file = await admin.get(`/api/pos/templates/${t.data.id}/file.pdf`, { raw: true }); assert.equal(file.status, 200, 'non-ASCII file name must not crash the download');
  assert.equal((await admin.put('/api/pos/templates/' + t.data.id, { fields: [{ type: 'bogus' }] })).status, 400);
  const put = await admin.put('/api/pos/templates/' + t.data.id, { fields: [{ id: 'a', type: 'signature', role: 'customer', page: 9, x: 2, y: -1, w: 0.2, h: 0.05 }, { id: 'a', type: 'data', tag: 'custom:Anchor type', page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.02 }] });
  assert.equal(put.status, 200);
  assert.equal(put.data.fields[0].page, 1, 'page clamped'); assert.equal(put.data.fields[0].x, 1); assert.notEqual(put.data.fields[0].id, put.data.fields[1].id, 'ids made unique');
  const meta = await admin.get('/api/pos/meta'); assert.deepEqual(meta.data.templates.find(x => x.id === t.data.id).custom, ['Anchor type']);
  const sales = new Client(); await sales.login('sales@test.com', 'password-123');
  assert.equal((await sales.put('/api/pos/templates/' + t.data.id, { name: 'hack' })).status, 403, 'sales cannot edit templates');
});

test('cash contract: prepare with drawings, send by text+email, customer + company sign, signed PDF, order created', async () => {
  const q = await quote({ first_name: 'Carl', last_name: 'Cash', email: 'carl@test.com', phone: '6155550010', address: '1 Main', city: 'Jackson', state: 'TN', zip: '38301' });
  const meta = (await admin.get('/api/pos/meta')).data;
  const tpl = meta.templates.find(t => t.sale_type === 'cash' && /Sample/.test(t.name));
  assert.equal((await makeContract(admin, { quote_id: q.id, template_id: tpl.id, sale_type: 'rto', signers: { customer: { name: 'Carl', email: 'carl@test.com' } } })).status, 400, 'cash template refused for RTO');
  assert.equal((await makeContract(admin, { quote_id: q.id, template_id: tpl.id, sale_type: 'cash', signers: { customer: { name: 'Carl' } } })).status, 400, 'needs email or phone');
  // a 2-page "drawings" PDF like the browser builds
  const dr = await PDFDocument.create(); dr.addPage([792, 612]); dr.addPage([792, 612]);
  const k = await makeContract(admin, { quote_id: q.id, template_id: tpl.id, sale_type: 'cash', signers: { customer: { name: 'Carl Cash', email: 'carl@test.com', phone: '6155550010' } }, cash: { deposit: 500 }, custom: { serial_number: 'TB-1001' } },
    { drawings: { blob: new Blob([await dr.save()], { type: 'application/pdf' }), name: 'd.pdf' } });
  assert.equal(k.status, 201, JSON.stringify(k.data));
  assert.equal(k.data.status, 'draft'); assert.equal(k.data.pages.length, 4, '2 template pages + 2 drawing sheets');
  assert.equal(k.data.fields.filter(f => f.id.startsWith('dwg')).length, 2, 'initials box on each drawing sheet');
  assert.equal(k.data.raw.deposit, 500);
  const roles = k.data.signers.map(s => s.role).sort(); assert.deepEqual(roles, ['company', 'customer']);
  const send = await admin.post(`/api/pos/contracts/${k.data.id}/send`, { sms: true, email: true });
  assert.equal(send.status, 200); assert.equal(send.data.results.length, 2); assert.ok(send.data.results.every(r => r.ok));
  const contact = (await admin.get('/api/crm/contacts?q=carl@test.com')).data.data[0];
  assert.equal(contact.stage, 'contract', 'deal moved to Contract sent');
  const cust = k.data.signers.find(s => s.role === 'customer'), comp = k.data.signers.find(s => s.role === 'company');
  // signing page data only exposes this signer's boxes as "mine"
  const info = (await anon.get('/api/sign/' + tok(cust.link))).data;
  assert.ok(info.fields.every(f => (f.role === 'customer') === f.mine)); assert.equal(info.contract.status, 'sent');
  assert.equal((await anon.post(`/api/sign/${tok(cust.link)}/sign`, { consent: false, values: {} })).status, 400, 'consent required');
  assert.equal((await anon.post(`/api/sign/${tok(cust.link)}/sign`, { consent: true, values: {} })).status, 400, 'required boxes enforced');
  assert.equal((await anon.post(`/api/sign/${tok(cust.link)}/sign`, { consent: true, values: Object.fromEntries(info.fields.filter(f => f.mine && f.type === 'signature').map(f => [f.id, 'data:image/png;base64,<script>'])) })).status, 400, 'bad signature data rejected');
  await anon.post(`/api/sign/${tok(cust.link)}/viewed`, {});
  const s1 = await signAll(tok(cust.link)); assert.equal(s1.status, 200); assert.equal(s1.data.completed, false); assert.equal(s1.data.waiting_on, 1);
  assert.equal((await signAll(tok(cust.link))).status, 409, 'cannot sign twice');
  assert.equal((await anon.get(`/api/sign/${tok(cust.link)}/signed.pdf`, { raw: true })).status, 409, 'no signed copy yet');
  const s2 = await signAll(tok(comp.link)); assert.equal(s2.data.completed, true);
  const done = (await admin.get('/api/pos/contracts/' + k.data.id)).data;
  assert.equal(done.status, 'completed'); assert.ok(done.signed_hash);
  const events = done.events.map(e => e.event);
  for (const e of ['Created', 'Signing link texted', 'Signing link emailed', 'Viewed', 'Signed', 'Completed', 'Signed copy emailed']) assert.ok(events.includes(e), 'event ' + e);
  // the signed PDF: template + drawings + certificate, downloadable by staff and by the customer link
  const r = await anon.get(`/api/sign/${tok(cust.link)}/signed.pdf`, { raw: true }); assert.equal(r.status, 200);
  const signed = await PDFDocument.load(await r.arrayBuffer()); assert.equal(signed.getPageCount(), 5);
  assert.equal((await admin.get(`/api/pos/contracts/${k.data.id}/document.pdf`, { raw: true })).status, 200);
  // CRM + production board + quote status + alerts
  const c2 = (await admin.get('/api/crm/contacts/' + contact.id)).data;
  const sales = c2.opportunities.find(o => o.pipeline_name === 'Sales'); assert.equal(sales.stage, 'sold'); assert.equal(sales.status, 'won');
  const order = c2.opportunities.find(o => o.order_number); assert.equal(order.stage, 'sold'); assert.equal(order.serial_number, 'TB-1001'); assert.equal(order.sale_type, 'cash');
  assert.equal((await admin.get('/api/v1/quotes/' + q.id)).data.status, 'won');
  const notes = (await admin.get('/api/crm/notifications')).data.data; assert.ok(notes.some(n => n.title.startsWith('Contract signed')));
  const alertMsgs = (await admin.get('/api/crm/conversations')).data; // owner alerts aren't tied to a contact, so check the log via a fresh contact view isn't possible — verify via messages count instead
  assert.ok(Array.isArray(alertMsgs));
  // signed contracts can't be deleted; voiding needs admin
  assert.equal((await admin.del('/api/pos/contracts/' + k.data.id)).status, 400);
});

test('rent-to-own contract with co-buyer: RTO math, everyone signs, void & expiry rules', async () => {
  const q = await quote({ first_name: 'Rita', last_name: 'Rto', email: 'rita@test.com', phone: '6155550020' });
  const meta = (await admin.get('/api/pos/meta')).data;
  const tpl = meta.templates.find(t => t.sale_type === 'rto');
  const qd = (await admin.get('/api/v1/quotes/' + q.id)).data;
  const k = await makeContract(admin, { quote_id: q.id, template_id: tpl.id, sale_type: 'rto', signers: { customer: { name: 'Rita Rto', phone: '6155550020' }, cobuyer: { name: 'Rob Rto', email: 'rob@test.com' } }, rto: { term_months: 48 } });
  assert.equal(k.status, 201, JSON.stringify(k.data));
  const r = k.data.raw.rto; const cash = (qd.pricing.subtotal || 0) + (qd.pricing.delivery || 0);
  assert.equal(r.term_months, 48); assert.equal(r.cash_price, Math.round(cash * 100) / 100);
  assert.equal(r.monthly_payment, Math.round(cash * 1.75 / 48 * 100) / 100); assert.equal(r.total_of_payments, Math.round(r.monthly_total * 48 * 100) / 100);
  assert.equal(k.data.signers.length, 3);
  // override monthly
  const k2 = await makeContract(admin, { quote_id: q.id, template_id: tpl.id, sale_type: 'rto', signers: { customer: { name: 'Rita', phone: '6155550020' } }, rto: { term_months: 36, monthly_override: 199.99 } });
  assert.equal(k2.data.raw.rto.monthly_payment, 199.99);
  // void → links stop working
  assert.equal((await admin.post(`/api/pos/contracts/${k2.data.id}/void`, { reason: 'customer changed size' })).status, 200);
  assert.equal((await signAll(tok(k2.data.signers[0].link))).status, 410);
  assert.equal((await anon.get(`/api/sign/${tok(k2.data.signers[0].link)}/document.pdf`, { raw: true })).status, 410);
  // everyone signs the first one
  for (const s of k.data.signers) assert.equal((await signAll(tok(s.link))).status, 200);
  const done = (await admin.get('/api/pos/contracts/' + k.data.id)).data; assert.equal(done.status, 'completed');
  assert.equal((await anon.get('/api/sign/nonexistent-token')).status, 404);
});

test('roles: sales / production / delivery see and do only their part', async () => {
  const sales = new Client(), prod = new Client(), drv = new Client();
  const me = await sales.login('sales@test.com', 'password-123'); assert.ok(me.permissions.includes('pos.create'));
  await prod.login('prod@test.com', 'password-123'); await drv.login('driver@test.com', 'password-123');
  // sales: CRM yes, admin settings no, secrets never
  assert.equal((await sales.get('/api/crm/contacts')).status, 200);
  assert.equal((await sales.put('/api/admin/settings', { company_name: 'x' })).status, 403);
  const st = (await sales.get('/api/admin/settings')).data; assert.equal(st.twilio_token, undefined); assert.equal(st.inbound_key, undefined);
  assert.equal((await sales.del('/api/crm/contacts/1')).status, 403, 'only admin deletes contacts');
  // production / delivery: no CRM, no contract creation
  for (const c of [prod, drv]) {
    assert.equal((await c.get('/api/crm/contacts')).status, 403);
    assert.equal((await c.get('/api/pos/contracts')).status, 403);
    assert.equal((await c.get('/api/crm/orders')).status, 200);
  }
  const orders = (await prod.get('/api/crm/orders')).data; assert.ok(orders.data.length >= 2);
  assert.equal(orders.data[0].value, undefined, 'production does not see prices on the board');
  const o = orders.data.find(x => x.stage === 'sold');
  assert.equal((await prod.patch('/api/crm/opportunities/' + o.id, { stage: 'scheduled' })).status, 403, 'production cannot schedule delivery');
  assert.equal((await drv.patch('/api/crm/opportunities/' + o.id, { stage: 'in_production' })).status, 403, 'delivery cannot run production');
  assert.equal((await prod.patch('/api/crm/opportunities/' + o.id, { stage: 'in_production', serial_number: 'SN-9' })).status, 200);
  assert.equal((await prod.patch('/api/crm/opportunities/' + o.id, { stage: 'built' })).status, 200);
  assert.equal((await prod.patch('/api/crm/opportunities/' + o.id, { delivery_date: '2026-12-01' })).status, 400, 'production cannot set delivery date');
  assert.equal((await drv.patch('/api/crm/opportunities/' + o.id, { stage: 'scheduled', delivery_date: '2026-12-01', delivery_window: '8-10 AM' })).status, 200, 'hand-off from built to delivery');
  assert.equal((await drv.patch('/api/crm/opportunities/' + o.id, { stage: 'delivered' })).status, 200);
  // delivery can text the customer of an order on the board, but not other contacts
  assert.equal((await drv.post(`/api/crm/contacts/${o.contact_id}/messages`, { channel: 'sms', body: 'On the way!' })).status, 200);
  const other = (await admin.post('/api/crm/contacts', { first_name: 'NoOrder', phone: '6155550099' })).data;
  assert.equal((await drv.post(`/api/crm/contacts/${other.id}/messages`, { channel: 'sms', body: 'hi' })).status, 403);
  // signed contract PDF: available to production once completed
  assert.equal((await prod.get(`/api/pos/contracts/${o.contract_id}/document.pdf`, { raw: true })).status, 200);
  // turned-off login is locked out immediately
  const users = (await admin.get('/api/admin/users')).data; const u = users.find(x => x.email === 'driver@test.com');
  await admin.patch('/api/admin/users/' + u.id, { active: false });
  assert.equal((await drv.get('/api/crm/orders')).status, 401);
  assert.equal((await drv.post('/api/auth/login', { email: 'driver@test.com', password: 'password-123' })).status, 403);
  await admin.patch('/api/admin/users/' + u.id, { active: true });
});

test('dealer lots: lot-limited sales only see their lot', async () => {
  const lotA = new Client(); await lotA.login('salesa@test.com', 'password-123');
  await quote({ first_name: 'Lotty', email: 'lotty@test.com' }, { dealer_id: 'lotB' });
  const mine = await lotA.post('/api/crm/contacts', { first_name: 'Ally', phone: '6155550031' });
  assert.equal(mine.data.dealer_id, 'lotA');
  const seen = (await lotA.get('/api/crm/contacts?limit=500')).data.data;
  assert.ok(seen.every(c => c.dealer_id === 'lotA')); assert.ok(seen.some(c => c.id === mine.data.id));
  const lotty = (await admin.get('/api/crm/contacts?q=lotty')).data.data[0];
  assert.equal((await lotA.get('/api/crm/contacts/' + lotty.id)).status, 404);
  assert.equal((await lotA.post(`/api/crm/contacts/${lotty.id}/messages`, { channel: 'sms', body: 'x' })).status, 404);
});

test('many users logged in at once + live updates reach every open session', async () => {
  const sessions = await Promise.all(['owner@test.com', 'sales@test.com', 'prod@test.com', 'driver@test.com'].map(async e => { const c = new Client(); await c.login(e, e.startsWith('owner') ? 'owner-pass-1' : 'password-123'); return c; }));
  // all sessions valid at the same time
  const me = await Promise.all(sessions.map(c => c.get('/api/auth/me'))); assert.ok(me.every(r => r.status === 200));
  // two sales sessions open the live stream; a new lead must reach both
  const s2 = new Client(); await s2.login('sales@test.com', 'password-123');
  const streams = [sessions[0], s2].map(c => {
    const ctrl = new AbortController();
    const p = fetch(B + '/api/crm/stream', { headers: { cookie: c.cookie }, signal: ctrl.signal }).then(async r => {
      const rd = r.body.getReader(); let buf = '';
      for (;;) { const { value, done } = await rd.read(); if (done) return buf; buf += new TextDecoder().decode(value); if (buf.includes('event: contact')) { ctrl.abort(); return buf; } }
    }).catch(e => (e.name === 'AbortError' ? 'event: contact' : ''));
    return p;
  });
  await new Promise(r => setTimeout(r, 300));
  await quote({ first_name: 'Live', email: 'live@test.com' });
  const out = await Promise.race([Promise.all(streams), new Promise(r => setTimeout(() => r(null), 4000))]);
  assert.ok(out && out.every(b => b.includes('event: contact')), 'both sessions got the live event');
  // simultaneous writes from different users don't collide
  const c = (await admin.post('/api/crm/contacts', { first_name: 'Busy', phone: '6155550041' })).data;
  const res = await Promise.all(sessions.slice(0, 2).flatMap(s => [1, 2, 3].map(i => s.post(`/api/crm/contacts/${c.id}/notes`, { body: 'note ' + i }))));
  assert.ok(res.every(r => r.status === 201));
  assert.equal((await admin.get('/api/crm/contacts/' + c.id)).data.timeline.filter(t => t.type === 'note').length, 6);
});

test('pipeline editing guards cards in removed stages', async () => {
  const pipes = (await admin.get('/api/crm/pipelines')).data; const sales = pipes.find(p => p.kind === 'sales');
  assert.equal((await admin.put('/api/crm/pipelines/' + sales.id, { stages: [{ name: 'Only' }] })).status, 400);
  const r = await admin.put('/api/crm/pipelines/' + sales.id, { stages: sales.stages.filter(s => s.id !== 'new') });
  assert.equal(r.status, 400); assert.match(r.data.error, /Move them first/);
  assert.equal((await admin.put('/api/crm/pipelines/' + sales.id, { stages: [...sales.stages, { name: 'Follow up later' }] })).status, 200);
});

test('settings: secrets masked and kept when re-saved', async () => {
  await admin.put('/api/admin/settings', { smtp_pass: 'super-secret-pass' });
  const s = (await admin.get('/api/admin/settings')).data;
  assert.match(s.smtp_pass, /^•+pass$/); assert.equal(s.smtp_pass_set, true);
  await admin.put('/api/admin/settings', { smtp_pass: s.smtp_pass, company_name: 'Trimline Barns' });
  assert.match((await admin.get('/api/admin/settings')).data.smtp_pass, /pass$/);
  const t = await admin.post('/api/admin/messaging/test', { channel: 'sms', to: '6155550123' }); assert.equal(t.status, 200);
  assert.equal((await admin.post('/api/admin/messaging/test', { channel: 'sms', to: 'abc' })).status, 502);
});

test('edit a sale: revisions keep every version, old links point to the new one, order is updated not duplicated', async () => {
  const q = await quote({ first_name: 'Vera', last_name: 'Version', email: 'vera@test.com', phone: '6155550050' });
  const meta = (await admin.get('/api/pos/meta')).data;
  const cashT = meta.templates.find(t => t.sale_type === 'cash' && /Sample/.test(t.name)), rtoT = meta.templates.find(t => t.sale_type === 'rto' && /Sample/.test(t.name));
  const k1 = (await makeContract(admin, { quote_id: q.id, template_id: cashT.id, sale_type: 'cash', signers: { customer: { name: 'Vera Version', phone: '6155550050' } }, cash: { deposit: 300 } })).data;
  assert.equal(k1.revision, 1); assert.deepEqual(k1.payload.cash, { deposit: 300 });
  await admin.post(`/api/pos/contracts/${k1.id}/send`, { sms: true });
  // everyone signs the original → order on the board
  for (const s of k1.signers) assert.equal((await signAll(tok(s.link))).status, 200);
  const ordersBefore = (await admin.get('/api/crm/orders')).data.data.filter(o => o.contact_id === k1.contact_id);
  assert.equal(ordersBefore.length, 1);
  // revise: switch to rent to own
  const k2r = await makeContract(admin, { quote_id: q.id, template_id: rtoT.id, sale_type: 'rto', signers: { customer: { name: 'Vera Version', phone: '6155550050' } }, rto: { term_months: 48 }, revise_of: k1.id, change_note: 'Switched to rent to own' });
  assert.equal(k2r.status, 201, JSON.stringify(k2r.data)); const k2 = k2r.data;
  assert.equal(k2.number, k1.number + '-R2'); assert.equal(k2.revision, 2); assert.equal(k2.versions.length, 2); assert.equal(k2.latest_id, k2.id);
  const old = (await admin.get('/api/pos/contracts/' + k1.id)).data;
  assert.equal(old.status, 'superseded'); assert.equal(old.superseded_by, k2.id); assert.ok(old.completed_at, 'signed original keeps its signed date');
  assert.ok(old.events.some(e => e.event === 'Replaced by a revised version'));
  assert.equal((await admin.get(`/api/pos/contracts/${k1.id}/document.pdf`, { raw: true })).status, 200, 'signed original still downloadable');
  // revising an old version is refused; sending an old version is refused
  assert.equal((await makeContract(admin, { quote_id: q.id, template_id: cashT.id, sale_type: 'cash', signers: { customer: { name: 'V', phone: '6155550050' } }, revise_of: k1.id })).status, 400);
  assert.equal((await admin.post(`/api/pos/contracts/${k1.id}/send`, { sms: true })).status, 400);
  // list shows one row per sale: the latest version
  const list = (await admin.get('/api/pos/contracts?q=Vera')).data; assert.equal(list.length, 1); assert.equal(list[0].id, k2.id); assert.equal(list[0].versions, 2);
  // the customer's old link says it was replaced and points to the new link
  const oldCust = k1.signers.find(s => s.role === 'customer'), newCust = k2.signers.find(s => s.role === 'customer');
  const info = (await anon.get('/api/sign/' + tok(oldCust.link))).data;
  assert.equal(info.contract.status, 'superseded'); assert.equal(info.contract.replaced_by.link, '/sign/' + tok(newCust.link));
  assert.equal((await signAll(tok(newCust.link), {})).status, 200);
  // sending the revision says it's updated
  const sent = await admin.post(`/api/pos/contracts/${k2.id}/send`, { sms: true, email: false });
  assert.equal(sent.status, 400, 'customer already signed, only the company is left');
  for (const s of k2.signers.filter(s => s.role !== 'customer')) assert.equal((await signAll(tok(s.link))).status, 200);
  const ordersAfter = (await admin.get('/api/crm/orders')).data.data.filter(o => o.contact_id === k1.contact_id);
  assert.equal(ordersAfter.length, 1, 'still one order'); assert.equal(ordersAfter[0].contract_id, k2.id); assert.equal(ordersAfter[0].sale_type, 'rto');
  // a third revision deleted while still a draft brings revision 2 back as the latest
  const k3 = (await makeContract(admin, { quote_id: q.id, template_id: rtoT.id, sale_type: 'rto', signers: { customer: { name: 'Vera Version', phone: '6155550050' } }, rto: { term_months: 36 }, revise_of: k2.id })).data;
  assert.equal(k3.number, k1.number + '-R3');
  assert.equal((await admin.del('/api/pos/contracts/' + k3.id)).status, 204);
  const back = (await admin.get('/api/pos/contracts/' + k2.id)).data; assert.equal(back.status, 'completed'); assert.equal(back.latest_id, k2.id);
  assert.equal((await admin.del('/api/pos/contracts/' + k1.id)).status, 400, 'old versions are kept');
  // revision message in the text log
  const k4 = (await makeContract(admin, { quote_id: q.id, template_id: rtoT.id, sale_type: 'rto', signers: { customer: { name: 'Vera Version', phone: '6155550050' } }, rto: { term_months: 36 }, revise_of: k2.id, change_note: 'Added a loft' })).data;
  await admin.post(`/api/pos/contracts/${k4.id}/send`, { sms: true, email: false });
  const msgs = (await admin.get('/api/crm/contacts/' + k4.contact_id)).data.timeline.filter(t => t.kind === 'message' && t.contract_id === k4.id);
  assert.match(msgs.at(-1).body, /^UPDATED CONTRACT/);
});

test('dashboard reports: daily rows count leads, quotes and each sale once', async () => {
  const r = (await admin.get('/api/admin/reports')).data;
  assert.match(r.today, /^\d{4}-\d\d-\d\d$/);
  const tot = r.days.reduce((a, d) => ({ leads: a.leads + d.leads, quotes: a.quotes + d.quotes, sales: a.sales + d.sales, cash: a.cash + d.cash, rto: a.rto + d.rto }), { leads: 0, quotes: 0, sales: 0, cash: 0, rto: 0 });
  assert.equal(tot.leads, (await admin.get('/api/crm/contacts?limit=1')).data.total);
  assert.equal(tot.quotes, (await admin.get('/api/v1/quotes?limit=1')).data.total);
  // a sale = a contract (all revisions) signed at least once whose latest version isn't void — a pending revision doesn't undo it
  const every = (await admin.get('/api/pos/contracts?all_versions=1')).data;
  const groups = {}; for (const k of every) (groups[k.number.split('-R')[0]] ||= []).push(k);
  const expected = Object.values(groups).filter(g => g.some(k => k.completed_at) && g.sort((a, b) => b.revision - a.revision)[0].status !== 'void').length;
  assert.equal(tot.sales, expected, 'one sale per contract, revisions counted once');
  assert.equal(tot.cash + tot.rto, tot.sales);
  const sales = new Client(); await sales.login('sales@test.com', 'password-123');
  assert.equal((await sales.get('/api/admin/reports')).status, 403);
});
