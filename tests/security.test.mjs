// Security tests: attacks run against a real server (production mode, no test shortcuts).
// Sessions + cookies, cross-site requests, clickjacking headers, uploaded SVG scripts, SSRF via webhooks,
// broken signatures, brute force + spam limits, privilege escalation across roles / lots / the developer login,
// path traversal, secrets and error leaks. Run: node --test tests/security.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5000 + Math.floor(Math.random() * 400), B = `http://127.0.0.1:${PORT}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(headers = {}) { this.cookie = ''; this.headers = headers; this.lastCookieHeader = ''; }
  async req(method, url, body, { raw = false, headers = {} } = {}) {
    const isForm = body instanceof FormData;
    const r = await fetch(B + url, { method, redirect: 'manual', headers: { ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...this.headers, ...headers }, body: body === undefined ? undefined : (isForm ? body : typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = r.headers.get('set-cookie'); if (sc) { this.lastCookieHeader = sc; const v = sc.split(';')[0]; this.cookie = /=$/.test(v) ? '' : v; }
    if (raw) return r;
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data, headers: r.headers };
  }
  get(u, o) { return this.req('GET', u, undefined, o); } post(u, b, o) { return this.req('POST', u, b, o); }
  put(u, b, o) { return this.req('PUT', u, b, o); } patch(u, b, o) { return this.req('PATCH', u, b, o); } del(u, o) { return this.req('DELETE', u, undefined, o); }
  async login(email, password) { const r = await this.post('/api/auth/login', { email, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
}
const anon = new Client(), admin = new Client();
let srv, dir, cat;
const mkUser = (email, role, dealer_id = null) => admin.post('/api/admin/users', { email, name: email.split('@')[0], password: 'password-123', role, dealer_id });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shedsec-'));
  // production mode, real webhook rules (no ALLOW_PRIVATE_WEBHOOKS), messages logged instead of sent
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'production', ALLOW_PRIVATE_WEBHOOKS: '', PORT, DB_PATH: join(dir, 'db.sqlite'), UPLOAD_DIR: join(dir, 'uploads'), MESSAGING_TEST_MODE: '1', ADMIN_EMAIL: 'owner@test.com', ADMIN_PASSWORD: 'owner-pass-1', DEVOPS_EMAIL: 'dev@builder.test', DEVOPS_PASSWORD: 'dev-secret-123', MODULES: 'all' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => (log += d)); srv.stderr.on('data', d => (log += d));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* */ } await sleep(200); }
  await admin.login('owner@test.com', 'owner-pass-1');
  cat = (await anon.get('/api/v1/catalog')).data;
  await admin.put('/api/admin/settings', { public_url: B, require_phone: false, dealers: [{ id: 'lotA', name: 'Lot A' }, { id: 'lotB', name: 'Lot B' }] });
  for (const [e, r, d] of [['sales@t.com', 'sales', null], ['lota@t.com', 'sales', 'lotA'], ['prod@t.com', 'production', null], ['drv@t.com', 'delivery', null]]) assert.equal((await mkUser(e, r, d)).status, 200);
});
after(() => { srv?.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

test('headers: admin, signing page and API cannot be framed (clickjacking); the configurator stays embeddable; no sniffing, no server banner', async () => {
  for (const u of ['/admin/', '/api/auth/me', '/sign/abc', '/docs']) {
    const r = await anon.get(u, { raw: true });
    assert.equal(r.headers.get('x-frame-options'), 'DENY', u); assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, u);
  }
  const cfg = await anon.get('/', { raw: true }); assert.equal(cfg.headers.get('x-frame-options'), null, 'configurator can be embedded on a website');
  const any = await anon.get('/api/v1/catalog', { raw: true });
  assert.equal(any.headers.get('x-content-type-options'), 'nosniff'); assert.equal(any.headers.get('x-powered-by'), null, 'no "Express" banner');
  assert.equal((await anon.get('/sign/abc', { raw: true })).headers.get('referrer-policy'), 'no-referrer', 'signing token never sent to other sites');
});

test('sessions: HttpOnly + SameSite cookie (Secure over https); tampering, password changes, turned-off logins and role changes end old sessions', async () => {
  const a = new Client(); await a.login('sales@t.com', 'password-123');
  assert.match(a.lastCookieHeader, /HttpOnly/); assert.match(a.lastCookieHeader, /SameSite=Lax/);
  const https = new Client({ 'X-Forwarded-Proto': 'https' }); await https.login('sales@t.com', 'password-123');
  assert.match(https.lastCookieHeader, /; Secure/, 'Secure cookie when the site is on https');
  // a forged cookie for another user id is refused
  const [name, val] = a.cookie.split('='), parts = val.split('.');
  const forged = new Client(); forged.cookie = `${name}=1.${parts.slice(1).join('.')}`;
  assert.equal((await forged.get('/api/auth/me')).status, 401, 'changing the user id breaks the signature');
  const stale = new Client(); stale.cookie = `${name}=${parts[0]}.${Date.now() - 1000}.${parts.slice(2).join('.')}`;
  assert.equal((await stale.get('/api/auth/me')).status, 401, 'changed expiry refused');
  // the same person on a second device
  const phone = new Client(); await phone.login('sales@t.com', 'password-123');
  assert.equal((await phone.get('/api/auth/me')).status, 200);
  assert.equal((await a.post('/api/admin/account', { current_password: 'password-123', new_password: 'password-456' })).status, 200);
  assert.equal((await phone.get('/api/auth/me')).status, 401, 'other device signed out by the password change');
  assert.equal((await https.get('/api/auth/me')).status, 401);
  assert.equal((await a.get('/api/auth/me')).status, 200, 'the device that changed it stays signed in');
  // "sign out other devices"
  const tab = new Client(); await tab.login('sales@t.com', 'password-456');
  assert.equal((await a.post('/api/admin/account/sign-out-others')).status, 200);
  assert.equal((await tab.get('/api/auth/me')).status, 401); assert.equal((await a.get('/api/auth/me')).status, 200);
  // admin turns the login off / changes the role → sessions end immediately
  const id = (await a.get('/api/auth/me')).data.id;
  await admin.patch('/api/admin/users/' + id, { role: 'delivery' });
  assert.equal((await a.get('/api/auth/me')).status, 401, 'role change ends the old session');
  await a.login('sales@t.com', 'password-456'); await admin.patch('/api/admin/users/' + id, { active: false });
  assert.equal((await a.get('/api/crm/contacts')).status, 401, 'turned off = out now');
  assert.equal((await a.post('/api/auth/login', { email: 'sales@t.com', password: 'password-456' })).status, 403);
  await admin.patch('/api/admin/users/' + id, { active: true, role: 'sales', password: 'password-123' });
  // the admin resetting their own password stays signed in
  assert.equal((await admin.patch('/api/admin/users/' + (await admin.get('/api/auth/me')).data.id, { password: 'owner-pass-1' })).status, 200);
  assert.equal((await admin.get('/api/auth/me')).status, 200);
});

test('cross-site requests: a signed-in browser request from another website is refused (settings, uploads, contracts)', async () => {
  const evil = { headers: { Origin: 'https://evil.example' } };
  assert.equal((await admin.put('/api/admin/settings', { company_name: 'Hacked' }, evil)).status, 403);
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from(PNG.split(',')[1], 'base64')]), 'x.png');
  assert.equal((await admin.post('/api/admin/upload', fd, evil)).status, 403, 'multipart form from another site');
  assert.equal((await admin.post('/api/admin/users', { email: 'x@evil.example', password: 'password-123', role: 'admin' }, evil)).status, 403);
  assert.equal((await admin.put('/api/admin/settings', { company_name: 'Ok' }, { headers: { Origin: 'null' } })).status, 403, 'sandboxed / file:// origin');
  assert.equal((await admin.put('/api/admin/settings', { company_name: 'Trimline' }, { headers: { Origin: B } })).status, 200, 'same site is fine');
  assert.equal((await admin.put('/api/admin/settings', { company_name: 'Trimline' })).status, 200, 'non-browser clients (no Origin) are fine');
  assert.notEqual((await admin.get('/api/admin/settings')).data.company_name, 'Hacked');
  // API keys from other sites keep working (that's what they're for)
  const key = (await admin.post('/api/admin/api-keys', { name: 'site' })).data.key;
  assert.equal((await new Client({ 'X-API-Key': key, Origin: 'https://mysite.example' }).post('/api/v1/quotes', { config: { style_id: cat.styles[0].id, size_id: cat.styles[0].sizes[0].id }, customer: { first_name: 'Web', email: 'web@test.com' } })).status, 201);
});

test('uploads: an SVG with a script is served sandboxed (no script runs on this site); traversal and dotfiles blocked', async () => {
  const fd = new FormData(); fd.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/admin/settings")</script><rect width="5" height="5"/></svg>']), 'logo.svg');
  const up = await admin.post('/api/admin/upload', fd); assert.equal(up.status, 200);
  const r = await anon.get(up.data.url, { raw: true });
  assert.match(r.headers.get('content-security-policy') || '', /sandbox/); assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
  for (const u of ['/uploads/..%2fserver.js', '/uploads/%2e%2e/%2e%2e/etc/passwd', '/uploads/../package.json', '/uploads/.gitkeep']) {
    const x = await anon.get(u, { raw: true }); const t = await x.text();
    assert.ok(x.status >= 400 || !/import express|"dependencies"|root:/.test(t), u + ' → ' + x.status);
  }
  assert.equal((await admin.del('/api/admin/upload?url=/uploads/..%2F..%2Fserver.js')).status, 400);
});

test('SSRF: webhooks and the GHL webhook can\'t be pointed at this server\'s own network', async () => {
  const bad = ['http://127.0.0.1:' + PORT + '/api/admin/settings', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://[::1]/', 'http://db.railway.internal/', 'http://0.0.0.0/', 'ftp://example.com/', 'http://user:pass@example.com/', 'http://2130706433/'];
  for (const url of bad) {
    const r = await admin.post('/api/v1/webhooks', { name: 'x', url, events: ['*'] });
    assert.equal(r.status, 400, `${url} → ${r.status} ${JSON.stringify(r.data)}`);
  }
  assert.equal((await admin.put('/api/admin/settings', { ghl_inbound_webhook_url: 'http://169.254.169.254/' })).status, 400);
  // an existing hook edited to point inside is refused too
  const ok = await admin.post('/api/v1/webhooks', { name: 'zap', url: 'https://hooks.zapier.com/hooks/catch/1/abc', events: ['quote.created'] });
  if (ok.status === 201) assert.equal((await admin.patch('/api/v1/webhooks/' + ok.data.id, { url: 'http://127.0.0.1/' })).status, 400);
  else assert.match(JSON.stringify(ok.data), /can't be found/, 'no DNS here: refused as unknown, never called'); // sandboxed network
});

test('signing: a corrupted signature image is refused before anything is saved, so the contract can still be finished', async () => {
  const q = await admin.post('/api/v1/quotes', { config: { style_id: cat.styles[0].id, size_id: cat.styles[0].sizes[0].id }, customer: { first_name: 'Sig', email: 'sig@test.com', phone: '6155550300' } });
  const meta = (await admin.get('/api/pos/meta')).data; const tpl = meta.templates.find(t => t.sale_type === 'cash' && t.roles.includes('customer'));
  const fd = new FormData(); fd.append('payload', JSON.stringify({ quote_id: q.data.id, template_id: tpl.id, sale_type: 'cash', signers: { customer: { name: 'Sig', email: 'sig@test.com' } } }));
  const k = (await admin.post('/api/pos/contracts', fd)).data;
  const cust = k.signers.find(s => s.role === 'customer'), t = cust.link.split('/sign/')[1];
  const info = (await anon.get('/api/sign/' + t)).data;
  const fill = img => { const v = {}; for (const f of info.fields.filter(f => f.mine)) v[f.id] = f.type === 'checkbox' ? true : f.type === 'text' ? 'x' : ['signature', 'initials'].includes(f.type) ? img : undefined; return v; };
  for (const junk of ['data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4', 'data:image/png;base64,PHN2Zz48L3N2Zz4=']) {
    const r = await anon.post(`/api/sign/${t}/sign`, { consent: true, values: fill(junk) });
    assert.equal(r.status, 400, 'junk image refused: ' + JSON.stringify(r.data));
  }
  assert.equal((await anon.post(`/api/sign/${t}/sign`, { consent: true, values: ['x'] })).status, 400);
  assert.equal((await anon.get('/api/sign/' + t)).data.me?.status === 'signed', false, 'still unsigned');
  for (const s of k.signers) {
    const tt = s.link.split('/sign/')[1], inf = (await anon.get('/api/sign/' + tt)).data;
    const v = {}; for (const f of inf.fields.filter(f => f.mine)) v[f.id] = f.type === 'checkbox' ? true : f.type === 'text' ? 'x' : ['signature', 'initials'].includes(f.type) ? PNG : undefined;
    assert.equal((await anon.post(`/api/sign/${tt}/sign`, { consent: true, values: v })).status, 200);
  }
  assert.equal((await admin.get('/api/pos/contracts/' + k.id)).data.status, 'completed', 'contract completes normally');
  // signing links can't be guessed or used to reach other contracts' files
  assert.equal((await anon.get('/api/sign/' + t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'))).status, 404);
  assert.equal((await anon.get(`/api/pos/contracts/${k.id}/document.pdf`)).status, 401);
});

test('brute force + spam: login attempts, public quote spam and bad inbound keys are limited', async () => {
  const c = new Client(); let last;
  for (let i = 0; i < 12; i++) last = await c.post('/api/auth/login', { email: 'owner@test.com', password: 'wrong-' + i });
  assert.equal(last.status, 429, 'login locked after 10 wrong tries a minute');
  assert.equal((await c.post('/api/auth/login', { email: 'owner@test.com', password: 'owner-pass-1' })).status, 429, 'even the right password waits');
  const unknown = Date.now(); await new Client().post('/api/auth/login', { email: 'nobody@nowhere.test', password: 'x' }); const tUnknown = Date.now() - unknown;
  const known = Date.now(); await new Client().post('/api/auth/login', { email: 'prod@t.com', password: 'wrong' }); const tKnown = Date.now() - known;
  assert.ok(tUnknown > tKnown / 4, `unknown emails take a similar time (${tUnknown} vs ${tKnown} ms), so logins can't be discovered by timing`);
  let spam;
  for (let i = 0; i < 10; i++) spam = await anon.post('/api/v1/quotes', { config: { style_id: cat.styles[0].id, size_id: cat.styles[0].sizes[0].id }, customer: { first_name: 'Spam', email: `s${i}@spam.test` } });
  assert.equal(spam.status, 429, 'public quote form rate-limited');
  assert.equal((await anon.post('/api/hooks/email/wrong-key', { from: 'a@b.c', text: 'hi' })).status, 403);
  assert.equal((await anon.post('/api/hooks/ghl/' + 'x'.repeat(24), { phone: '+16155550000', message: { body: 'hi' } })).status, 403);
});

test('privilege escalation: roles, dealer lots, the developer login and hidden settings', async () => {
  const sales = new Client(); await sales.login('sales@t.com', 'password-123');
  const lota = new Client(); await lota.login('lota@t.com', 'password-123');
  const prod = new Client(); await prod.login('prod@t.com', 'password-123');
  const drv = new Client(); await drv.login('drv@t.com', 'password-123');
  // nobody but an admin touches settings, users, API keys, webhooks, catalog or modules
  for (const c of [sales, lota, prod, drv]) {
    assert.equal((await c.put('/api/admin/settings', { company_name: 'x' })).status, 403);
    assert.equal((await c.post('/api/admin/users', { email: 'evil@t.com', password: 'password-123', role: 'admin' })).status, 403);
    assert.equal((await c.get('/api/admin/users')).status, 403);
    assert.equal((await c.post('/api/admin/api-keys', { name: 'mine' })).status, 403);
    assert.equal((await c.get('/api/v1/webhooks')).status, 403);
    assert.equal((await c.post('/api/v1/options', { name: 'x', price: 1 })).status, 403);
    assert.equal((await c.put('/api/admin/modules', { crm: false })).status, 403);
    const st = (await c.get('/api/admin/settings')).data;
    for (const k of ['twilio_token', 'smtp_pass', 'ghl_token', 'inbound_key', '_session_secret', 'twilio_sid']) assert.ok(!st[k] || /^•+/.test(st[k]), k + ' hidden from ' + c.cookie.slice(0, 5));
  }
  // you can't make yourself an admin through your own account
  await sales.post('/api/admin/account', { role: 'admin', current_password: 'password-123', is_devops: 1 });
  const me = (await sales.get('/api/auth/me')).data; assert.equal(me.role, 'sales'); assert.ok(!me.devops);
  // an admin can't create or become the developer login
  assert.equal((await admin.post('/api/admin/users', { email: 'dev2@t.com', password: 'password-123', role: 'admin', is_devops: 1, devops: true })).status, 200);
  const d2 = new Client(); assert.ok(!(await d2.login('dev2@t.com', 'password-123')).devops);
  assert.equal((await admin.put('/api/admin/modules', { crm: false })).status, 403, 'only the developer switches modules');
  assert.equal((await admin.post('/api/admin/users', { email: 'dev@builder.test', password: 'password-123', role: 'admin' })).status, 400, 'can\'t take over the developer email');
  assert.equal((await admin.post('/api/admin/account', { email: 'dev@builder.test', current_password: 'owner-pass-1' })).status, 400, 'can\'t rename yourself to it either');
  // hidden settings keys can't be written
  await admin.put('/api/admin/settings', { _session_secret: 'known', __proto__: { show_prices: false }, inbound_key: 'mine' });
  assert.equal((await admin.get('/api/auth/me')).status, 200, 'session secret unchanged (still signed in)');
  assert.notEqual((await admin.get('/api/admin/settings')).data.show_prices, false);
  // lot A's rep can't reach lot B's customer, quote or contract by guessing ids
  const qb = await admin.post('/api/v1/quotes', { config: { style_id: cat.styles[0].id, size_id: cat.styles[0].sizes[0].id, dealer_id: 'lotB' }, customer: { first_name: 'Bee', email: 'bee@test.com', phone: '6155550400' } });
  const qd = (await admin.get('/api/v1/quotes/' + qb.data.id)).data;
  await admin.patch('/api/crm/contacts/' + qd.contact_id, { first_name: 'Bee' });
  assert.equal((await lota.get('/api/v1/quotes/' + qb.data.id)).status, 404);
  assert.equal((await lota.get('/api/crm/contacts/' + qd.contact_id)).status, 404);
  assert.equal((await lota.post(`/api/crm/contacts/${qd.contact_id}/messages`, { channel: 'sms', body: 'hi' })).status, 404);
  assert.equal((await lota.post('/api/pos/contracts', (() => { const f = new FormData(); f.append('payload', JSON.stringify({ quote_id: qb.data.id, template_id: 1, sale_type: 'cash', signers: { customer: { name: 'x', email: 'x@t.com' } } })); return f; })())).status, 404);
  // the shop and drivers can't read the CRM or change contracts
  for (const c of [prod, drv]) {
    assert.equal((await c.get('/api/crm/contacts/' + qd.contact_id)).status, 403);
    assert.equal((await c.post('/api/pos/contracts/1/void', { reason: 'x' })).status, 403);
    assert.equal((await c.patch('/api/v1/quotes/' + qb.data.id, { status: 'lost' })).status, 403);
  }
  assert.equal((await drv.post(`/api/crm/contacts/${qd.contact_id}/messages`, { channel: 'sms', body: 'hi' })).status, 403, 'drivers only text customers with an order');
});

test('errors and data exposure: no internal details in production errors; public endpoints show nothing private', async () => {
  const bad = await admin.post('/api/v1/quotes', '{"config":', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400); assert.doesNotMatch(JSON.stringify(bad.data), /SyntaxError|at JSON|node_modules|\/home\//);
  const big = await anon.post('/api/v1/price', JSON.stringify({ pad: 'x'.repeat(3_000_000) }), { headers: { 'Content-Type': 'application/json' } });
  assert.equal(big.status, 413, 'oversized bodies refused');
  assert.equal((await anon.get('/api/v1/shared/' + 'f'.repeat(32))).status, 404);
  const pub = (await anon.get('/api/v1/catalog')).data; const s = JSON.stringify(pub.settings);
  for (const k of ['smtp', 'twilio', 'ghl_token', 'inbound', 'notify_', 'session', 'modules', 'auto_reply']) assert.ok(!s.includes(`"${k}`), 'public catalog leaks ' + k);
  assert.equal((await anon.get('/api/crm/stream', { raw: true })).status, 401, 'live updates need a login');
  assert.equal((await anon.get('/api/admin/webhook-log')).status, 401);
  const doc = await anon.get('/api/openapi.json'); assert.doesNotMatch(JSON.stringify(doc.data), /sb_live_[A-Za-z0-9]{10}/, 'no real keys in the docs');
});
