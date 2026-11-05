// Add-on modules: configurator-only installs, turning CRM / Point of sale / Production & delivery on one at a time,
// the developer login (only it can switch modules), data kept when a module is off and back on.
// Run: node --test tests/modules.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function server(env) {
  const port = 4500 + Math.floor(Math.random() * 400), dir = mkdtempSync(join(tmpdir(), 'shedmod-'));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: port, DB_PATH: join(dir, 'db.sqlite'), UPLOAD_DIR: join(dir, 'uploads'), MESSAGING_TEST_MODE: '1', ADMIN_EMAIL: 'owner@test.com', ADMIN_PASSWORD: 'owner-pass-1', DEVOPS_EMAIL: '', DEVOPS_PASSWORD: '', MODULES: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', d => (log += d)); proc.stderr.on('data', d => (log += d));
  const B = `http://127.0.0.1:${port}`;
  return { B, proc, dir, log: () => log, ready: async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) return; } catch { /* */ } await sleep(200); } throw new Error('server did not start\n' + log); }, stop: () => { proc.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}
class Client {
  constructor(B) { this.B = B; this.cookie = ''; }
  async req(method, url, body) {
    const isForm = body instanceof FormData;
    const r = await fetch(this.B + url, { method, headers: { ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) }, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  }
  get(u) { return this.req('GET', u); } post(u, b) { return this.req('POST', u, b); } put(u, b) { return this.req('PUT', u, b); } patch(u, b) { return this.req('PATCH', u, b); } del(u) { return this.req('DELETE', u); }
  async login(email, password) { const r = await this.post('/api/auth/login', { email, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
}

let S, owner, dev, anon, cat;
before(async () => {
  S = server({ MODULES: 'none', DEVOPS_EMAIL: 'dev@builder.test', DEVOPS_PASSWORD: 'dev-secret-123' });
  await S.ready();
  owner = new Client(S.B); dev = new Client(S.B); anon = new Client(S.B);
  await owner.login('owner@test.com', 'owner-pass-1');
  await dev.login('dev@builder.test', 'dev-secret-123');
  cat = (await anon.get('/api/v1/catalog')).data;
  await owner.put('/api/admin/settings', { public_url: S.B, require_phone: false, auto_reply_email_body: 'Hi {{contact.first_name}}', auto_reply_email_subject: 'Thanks', notify_on_new_lead: true });
});
after(() => S?.stop());

const quote = (c = owner, customer = { first_name: 'Ann', last_name: 'Lee', email: 'ann@test.com', phone: '6155550001', sms_consent: true }) =>
  c.post('/api/v1/quotes', { config: { style_id: cat.styles[0].id, size_id: cat.styles[0].sizes[0].id }, customer });
const setMods = m => dev.put('/api/admin/modules', m);

test('configurator only (MODULES=none): quotes work, CRM / Point of sale / orders are absent', async () => {
  const me = (await owner.get('/api/auth/me')).data;
  assert.deepEqual(me.modules, { crm: false, pos: false, orders: false });
  assert.equal(me.can_manage_modules, false, 'a developer login exists, so the owner admin cannot switch modules');
  assert.ok(!me.permissions.some(p => /^(crm|pos|orders|contracts)\./.test(p)), 'no add-on permissions: ' + me.permissions);
  const q = await anon.post('/api/v1/quotes', { config: { style_id: cat.styles[0].id, size_id: cat.styles[0].sizes[0].id }, customer: { first_name: 'Cal', email: 'cal@test.com', phone: '6155550002', sms_consent: true } });
  assert.equal(q.status, 201, 'customers can still quote');
  assert.equal((await owner.get('/api/v1/quotes/' + q.data.id)).status, 200);
  for (const u of ['/api/crm/contacts', '/api/crm/conversations', '/api/crm/tasks', '/api/pos/meta', '/api/pos/contracts', '/api/crm/orders']) {
    const r = await owner.get(u); assert.equal(r.status, 404, u); assert.equal(r.data.module_off, true, u);
  }
  // the lead alert points at the 3D quote, and no CRM auto-reply goes out
  await sleep(300);
  const n = (await owner.get('/api/crm/notifications')).data.data.find(x => x.title.includes('Cal'));
  assert.ok(n, 'lead alert shown'); assert.equal(n.link, '#/quotes/' + q.data.id);
  const st = (await owner.get('/api/admin/messaging/status')).data;
  assert.ok(!st.recent.some(m => m.to_addr === 'cal@test.com'), 'no auto-reply email without the CRM');
  // the dealer configurator knows Point of sale is off (no "Write it up" button / design-for-contract mode)
  assert.equal((await owner.get('/api/v1/catalog')).data.viewer.modules.pos, false);
  const posSave = await owner.post('/api/v1/quotes', { config: { style_id: cat.styles[0].id, size_id: cat.styles[0].sizes[0].id }, customer: { first_name: 'Walk' }, pos: true });
  assert.equal(posSave.status, 400, 'POS design mode needs Point of sale');
  // production / delivery logins need Production & delivery; sales logins still work (dealer configurator)
  assert.equal((await owner.post('/api/admin/users', { email: 'p@test.com', password: 'password-123', role: 'production' })).status, 400);
  assert.equal((await owner.post('/api/admin/users', { email: 'rep@test.com', password: 'password-123', role: 'sales' })).status, 200);
  const rep = new Client(S.B); const rme = await rep.login('rep@test.com', 'password-123');
  assert.deepEqual(rme.permissions, ['quotes.view']);
  assert.equal((await rep.get('/api/v1/catalog')).data.viewer.dealer_mode, true, 'rep uses the dealer configurator');
});

test('only the developer login switches modules; the customer admin cannot see, edit or remove it', async () => {
  assert.equal((await owner.put('/api/admin/modules', { crm: true })).status, 403);
  await owner.put('/api/admin/settings', { modules: { crm: true, pos: true, orders: true } });
  assert.deepEqual((await owner.get('/api/auth/me')).data.modules, { crm: false, pos: false, orders: false }, 'settings can\'t sneak modules on');
  const users = (await owner.get('/api/admin/users')).data;
  assert.ok(!users.some(u => u.email === 'dev@builder.test'), 'developer login hidden from the customer');
  const devId = (await dev.get('/api/auth/me')).data.id;
  assert.equal((await owner.patch('/api/admin/users/' + devId, { active: false })).status, 404);
  assert.equal((await owner.patch('/api/admin/users/' + devId, { password: 'hijacked-123' })).status, 404);
  assert.equal((await owner.del('/api/admin/users/' + devId)).status, 404);
  assert.ok(!(await owner.get('/api/crm/users')).data.some(u => u.email === 'dev@builder.test'), 'not in team pickers either');
  const dme = (await dev.get('/api/auth/me')).data;
  assert.equal(dme.devops, true); assert.equal(dme.can_manage_modules, true); assert.equal(dme.role, 'admin', 'developer works as an admin everywhere');
  assert.ok((await dev.get('/api/admin/users')).data.some(u => u.email === 'dev@builder.test' && u.devops === 1), 'developer sees itself');
  const info = (await dev.get('/api/admin/modules')).data;
  assert.equal(info.list.length, 4); assert.equal(info.developer_login, true);
  assert.equal((await owner.get('/api/admin/modules')).data.can_manage, false);
});

let contract;
test('Point of sale on its own (no CRM): write up, send, sign; customer records kept silently', async () => {
  assert.deepEqual((await setMods({ pos: true })).data.modules, { crm: false, pos: true, orders: false });
  const me = (await owner.get('/api/auth/me')).data;
  assert.ok(me.permissions.includes('pos.create') && !me.permissions.includes('crm.view'));
  const q = await quote(); assert.equal(q.status, 201);
  const meta = (await owner.get('/api/pos/meta')).data; const tpl = meta.templates.find(t => t.sale_type === 'cash' && t.roles.includes('customer'));
  const fd = new FormData(); fd.append('payload', JSON.stringify({ quote_id: q.data.id, template_id: tpl.id, sale_type: 'cash', signers: { customer: { name: 'Ann Lee', email: 'ann@test.com', phone: '6155550001' } } }));
  const k = await owner.post('/api/pos/contracts', fd); assert.equal(k.status, 201, JSON.stringify(k.data));
  assert.equal((await owner.post(`/api/pos/contracts/${k.data.id}/send`, { sms: true, email: true })).status, 200);
  contract = k.data;
  // POS design-for-contract mode works now
  const qd = (await owner.get('/api/v1/quotes/' + q.data.id)).data;
  assert.equal((await owner.post('/api/v1/quotes', { config: { style_id: cat.styles[0].id, size_id: cat.styles[0].sizes[1].id }, customer: {}, pos: true, contact_id: qd.contact_id })).status, 201);
  for (const s of k.data.signers) {
    const t = s.link.split('/sign/')[1], info = (await anon.get('/api/sign/' + t)).data;
    const values = {}; for (const f of info.fields.filter(f => f.mine)) values[f.id] = f.type === 'checkbox' ? true : f.type === 'text' ? 'x' : ['signature', 'initials'].includes(f.type) ? PNG : undefined;
    assert.equal((await anon.post(`/api/sign/${t}/sign`, { consent: true, values })).status, 200);
  }
  const done = (await owner.get('/api/pos/contracts/' + k.data.id)).data; assert.equal(done.status, 'completed');
  assert.equal((await owner.get(`/api/pos/contracts/${k.data.id}/document.pdf`)).status, 200, 'signed PDF downloads');
  assert.equal((await owner.get('/api/crm/contacts')).status, 404, 'still no CRM');
  assert.equal((await owner.get('/api/crm/orders')).status, 404, 'still no order board');
  const n = (await owner.get('/api/crm/notifications')).data.data; assert.ok(n.some(x => x.title.startsWith('Contract signed')), 'signed alert');
});

test('Production & delivery turned on later: the earlier order is already on the board; shop roles work', async () => {
  await setMods({ orders: true });
  const board = (await owner.get('/api/crm/orders')).data;
  const order = board.data.find(o => o.contract_number === contract.number);
  assert.ok(order, 'order from the contract signed while the board was off');
  assert.equal((await owner.post('/api/admin/users', { email: 'p@test.com', password: 'password-123', role: 'production' })).status, 200);
  const shop = new Client(S.B); await shop.login('p@test.com', 'password-123');
  const st = board.pipeline.stages.find(s => (s.group || 'production') === 'production' && s.id !== order.stage);
  assert.equal((await shop.patch('/api/crm/opportunities/' + order.id, { stage: st.id })).status, 200, 'production moves the card');
  assert.equal(order.value, 1 * order.value, 'admin sees money on the board');
  assert.equal((await shop.get('/api/crm/orders')).data.data.find(o => o.id === order.id).value, undefined, 'the shop does not see prices');
  assert.equal((await shop.get(`/api/pos/contracts/${contract.id}/document.pdf`)).status, 200, 'shop can open the signed contract');
});

test('CRM turned on last: every customer, quote and contract made while it was off is there', async () => {
  await setMods({ crm: true });
  const list = (await owner.get('/api/crm/contacts?q=ann@test.com')).data; assert.equal(list.total, 1);
  const c = (await owner.get('/api/crm/contacts/' + list.data[0].id)).data;
  assert.ok(c.quotes.length >= 2 && c.contracts.length === 1, 'history kept');
  assert.equal(c.opportunities.find(o => o.pipeline_name === 'Sales').stage, 'sold');
  // and new leads now get the CRM treatment (contact link + auto-reply)
  const q = await anon.post('/api/v1/quotes', { config: { style_id: cat.styles[0].id, size_id: cat.styles[0].sizes[0].id }, customer: { first_name: 'Dee', email: 'dee@test.com', phone: '6155550003' } });
  await sleep(400);
  const n = (await owner.get('/api/crm/notifications')).data.data.find(x => x.title.includes('Dee')); assert.match(n.link, /^#\/crm\/contacts\/\d+$/);
  const d = (await owner.get('/api/crm/contacts/' + (await owner.get('/api/v1/quotes/' + q.data.id)).data.contact_id)).data;
  assert.ok(d.timeline.some(m => m.kind === 'message' && m.channel === 'email' && m.body === 'Hi Dee'), 'auto-reply sent with the CRM on');
});

test('turning Point of sale off again hides it but keeps data, and links customers already have still work', async () => {
  const q = await quote(owner, { first_name: 'Eli', email: 'eli@test.com', phone: '6155550004' });
  const meta = (await owner.get('/api/pos/meta')).data; const tpl = meta.templates.find(t => t.sale_type === 'cash' && t.roles.includes('customer'));
  const fd = new FormData(); fd.append('payload', JSON.stringify({ quote_id: q.data.id, template_id: tpl.id, sale_type: 'cash', signers: { customer: { name: 'Eli', email: 'eli@test.com' } } }));
  const k = (await owner.post('/api/pos/contracts', fd)).data; await owner.post(`/api/pos/contracts/${k.id}/send`, { email: true });
  await setMods({ pos: false });
  assert.equal((await owner.get('/api/pos/contracts')).status, 404);
  assert.equal((await anon.get('/api/sign/' + k.signers[0].link.split('/sign/')[1])).status, 200, 'sent signing link still opens');
  const c = (await owner.get('/api/crm/contacts?q=eli@test.com')).data.data[0];
  assert.ok(!(await owner.get('/api/auth/me')).data.permissions.includes('pos.view'));
  await setMods({ pos: true });
  assert.ok((await owner.get('/api/pos/contracts')).data.some(x => x.id === k.id), 'contract back when turned on');
  void c;
});

test('no developer login configured: the admin manages modules; MODULES picks the first-run set', async () => {
  const s2 = server({ MODULES: 'crm,orders' }); await s2.ready();
  try {
    const a = new Client(s2.B); const me = await a.login('owner@test.com', 'owner-pass-1');
    assert.deepEqual(me.modules, { crm: true, pos: false, orders: true });
    assert.equal(me.can_manage_modules, true);
    assert.equal((await a.put('/api/admin/modules', { pos: true })).status, 200);
    assert.equal((await a.get('/api/auth/me')).data.modules.pos, true);
  } finally { s2.stop(); }
  // a too-short developer password is refused with a warning instead of creating a weak login
  const s3 = server({ DEVOPS_EMAIL: 'dev@x.test', DEVOPS_PASSWORD: 'short' }); await s3.ready();
  try {
    assert.match(s3.log(), /Developer login not set up/);
    assert.equal((await new Client(s3.B).post('/api/auth/login', { email: 'dev@x.test', password: 'short' })).status, 401);
    assert.deepEqual((await new Client(s3.B).login('owner@test.com', 'owner-pass-1')).modules, { crm: true, pos: true, orders: true }, 'default: everything on (existing installs unchanged)');
  } finally { s3.stop(); }
});
