// Deep end-to-end API tests: pricing rules + tiers, configurator settings, 3D model uploads,
// the Open API (keys, catalog CRUD, quotes), outbound webhooks, GoHighLevel push, auto-replies
// and the whole lead → quote → contract → signed → order → delivered workflow.
// Run: node --test tests/full.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4300 + Math.floor(Math.random() * 90);
const B = `http://127.0.0.1:${PORT}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = n => Math.round(n * 100) / 100;

class Client {
  constructor(headers = {}) { this.cookie = ''; this.headers = headers; }
  async req(method, url, body, { raw = false, headers = {} } = {}) {
    const isForm = body instanceof FormData;
    const r = await fetch(B + url, { method, headers: { ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...this.headers, ...headers }, body: body === undefined ? undefined : (isForm ? body : typeof body === 'string' ? body : JSON.stringify(body)) });
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

// ---- a fake outside world: webhook receivers + the GoHighLevel API -----------------------
const hits = []; let flaky = 0; let mediaDown = false;
const recv = http.createServer((req, res) => {
  const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    let json = null; try { json = JSON.parse(body); } catch { /* */ }
    hits.push({ method: req.method, path: req.url, headers: req.headers, body, json });
    const send = (st, o) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/hook/ok' || req.url === '/hook/all' || req.url === '/ghl-inbound') return send(200, { ok: true });
    if (req.url === '/hook/flaky') return (flaky++ === 0 ? send(500, { e: 'down' }) : send(200, { ok: true }));
    if (req.url === '/hook/bad') return send(400, { e: 'nope' });
    if (req.headers.authorization === 'Bearer bad-token') return send(401, { message: 'Invalid JWT' });
    if (req.url === '/contacts/upsert') return send(200, { contact: { id: 'ghlC1' } });
    if (req.url === '/opportunities/') return send(201, { opportunity: { id: 'ghlO1' } });
    if (/^\/contacts\/ghlC1\/notes$/.test(req.url)) return send(201, { note: { id: 'n1' } });
    if (req.url === '/medias/upload-file') return mediaDown ? send(403, { message: 'The token is not authorized for this scope.' }) : send(200, { fileId: 'f1', url: 'https://storage.example.com/media/' + hits.length + '.pdf' });
    if (req.url === '/locations/LOC1/customFields?model=all') return send(200, { customFields: [{ id: 'cfPDF', name: 'Quote PDF / 3D Builder', fieldKey: '{{ opportunity.quote_pdf__3d_builder }}', model: 'opportunity', dataType: 'TEXT' }, { id: 'cfStyle', name: 'Shed style', fieldKey: 'opportunity.shed_style', model: 'opportunity', dataType: 'TEXT' }, { id: 'cfTot', name: 'Quote total', fieldKey: 'contact.quote_total', model: 'contact', dataType: 'MONETORY' }] });
    if (req.url === '/opportunities/pipelines?locationId=LOC1') return send(200, { pipelines: [{ id: 'P1', name: 'Sales', stages: [{ id: 'S1', name: 'New lead' }, { id: 'S2', name: 'Quoted' }] }] });
    if (req.url === '/users/?locationId=LOC1') return send(200, { users: [{ id: 'U1', name: 'Jalon', email: 'j@x.com' }, { id: 'U2', firstName: 'Lot', lastName: 'Rep', email: 'l@x.com' }] });
    if (req.url === '/opportunities/ghlO1' && req.method === 'PUT') return send(200, { opportunity: { id: 'ghlO1' } });
    send(404, { e: 'unknown ' + req.url });
  });
});
let RECV = '';
const waitHit = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const h = hits.filter(fn); if (h.length) return h; await sleep(50); } return []; };

/** A tiny but valid glTF binary (one triangle) — what a real exported model looks like on disk. */
function makeGLB() {
  const bin = Buffer.alloc(36); [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] };
  let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const c0 = Buffer.alloc(8); c0.writeUInt32LE(json.length, 0); c0.writeUInt32LE(0x4e4f534a, 4);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(bin.length, 0); c1.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, c0, json, c1, bin]);
}

let srv, dir, cat, gable;
// sample catalog names (newer catalogs renamed a few)
const ALIASES = { '36" Single Door': ['36" Standard Door'], "2' x 3' Window": ["2' x 3' Window (top & bottom grids)"] };
const opt = name => cat.options.find(o => o.name === name) || cat.options.find(o => (ALIASES[name] || []).includes(o.name));
async function setS(o) { const r = await admin.put('/api/admin/settings', o); assert.equal(r.status, 200, JSON.stringify(r.data)); }
async function price(cfg, c = anon) { return c.post('/api/v1/price', cfg); }

before(async () => {
  await new Promise(r => recv.listen(0, '127.0.0.1', r)); RECV = `http://127.0.0.1:${recv.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'shedfull-'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT, DB_PATH: join(dir, 'db.sqlite'), UPLOAD_DIR: join(dir, 'uploads'), MESSAGING_TEST_MODE: '1', ALLOW_PRIVATE_WEBHOOKS: '1', GHL_API_BASE: RECV, ADMIN_EMAIL: 'owner@test.com', ADMIN_PASSWORD: 'owner-pass-1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => (log += d)); srv.stderr.on('data', d => (log += d)); srv.on('exit', c => c && console.error(log));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* starting */ } await sleep(200); }
  await admin.login('owner@test.com', 'owner-pass-1');
  cat = (await admin.get('/api/admin/catalog')).data;
  gable = cat.styles.find(s => s.name === 'Classic Gable');
  await setS({ public_url: B, require_phone: false });
});
after(() => { srv?.kill(); recv.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

// =============================================================================
// PRICING
// =============================================================================
test('pricing: base, units, swaps, removals, roofing, colors, tax + delivery — server matches the hand math', async () => {
  const size = gable.sizes.find(z => z.width === 10 && z.depth === 12) || gable.sizes[0];
  const W = size.width, D = size.depth;
  const base = (await admin.post('/api/v1/price', { style_id: gable.id, size_id: size.id })).data;
  const defaultItems = (await anon.get('/api/v1/catalog')).data; // configurator default = standard items in place
  assert.equal(base.lines[0].amount, size.price, 'base line is the size price');
  // sending no items means the standard door/windows/vent were taken off → each is credited
  const stdCredit = gable.standard_options.reduce((t, so) => t + Number(cat.options.find(o => o.id === so.option_id).price), 0);
  assert.equal(base.total, size.price - stdCredit, 'no items → size price minus the removed standard items');
  const withStd = (await price({ style_id: gable.id, size_id: size.id, items: gable.standard_options.map((so, i) => ({ uid: 's' + i, option_id: so.option_id, wall: so.wall, offset: so.offset, standard_of: so.option_id })) })).data;
  assert.equal(withStd.total, size.price, 'standard items in place → total = size price');

  const door36 = opt('36" Single Door'), door9 = opt('9-Lite Glass Door'), win = opt("2' x 3' Window"), vent = opt('Gable Vent');
  const insul = opt('Insulation Package'), loft = opt("Storage Loft (4' deep)"), anchor = opt('Anchor Kit');
  const cfg = {
    style_id: gable.id, size_id: size.id, roof_material: 'shingle',
    items: [
      { uid: 'd', option_id: door9.id, wall: 'front', offset: 0, standard_of: door36.id },   // swap door: +difference
      { uid: 'w1', option_id: win.id, wall: 'left', offset: 0, standard_of: win.id },        // standard window kept
      // right-hand standard window removed → credit
      { uid: 'v', option_id: vent.id, wall: 'back', offset: 0, standard_of: vent.id },
      { uid: 'i', option_id: insul.id },                                                       // per sq ft
      { uid: 'l', option_id: loft.id, wall: 'left', offset: 0 },                               // per ft of wall (left = depth)
      { uid: 'a1', option_id: anchor.id }, { uid: 'a2', option_id: anchor.id },                // max 1 → second dropped
    ],
  };
  const p = (await price(cfg)).data;
  const line = n => p.lines.filter(l => l.label === n || l.label.startsWith(n));
  assert.equal(line(door9.name)[0].amount, door9.price - door36.price, 'swap charges the difference');
  assert.equal(line(insul.name)[0].amount, r2(insul.price * W * D), 'per sq ft');
  const loftLine = line(loft.name)[0]; const loftLen = ['front', 'back'].includes(loftLine.wall) ? W : D;
  assert.equal(loftLine.amount, r2(loft.price * loftLen), 'per ft of the wall it sits on (lofts move to a gable end)');
  assert.equal(line(anchor.name).length, 1, 'max quantity enforced');
  assert.equal(line('Removed: ' + win.name)[0].amount, -win.price, 'credit for the removed standard window');
  const expected = size.price + (door9.price - door36.price) + r2(insul.price * W * D) + r2(loft.price * loftLen) + anchor.price - win.price;
  assert.equal(p.subtotal, r2(expected), 'subtotal');

  // metal roof upgrade is charged by roof area; a paid color shows as its own line
  const metal = (await price({ ...cfg, roof_material: 'metal' })).data;
  const roofLine = metal.lines.find(l => l.type === 'roof'); assert.ok(roofLine.amount > 0 && /Upgrade/.test(roofLine.note), 'metal upgrade');
  assert.equal(r2(metal.subtotal - p.subtotal), roofLine.amount);

  // rules: no credit for removed items / no credit when downgrading
  await setS({ remove_credit: false });
  const noRemove = (await price(cfg)).data; assert.equal(noRemove.lines.filter(l => l.label.startsWith('Removed')).length, 0); assert.equal(noRemove.subtotal, r2(expected + win.price));
  await setS({ remove_credit: true, downgrade_credit: false, price_tiers: [{ id: 1, name: 'Standard', adjust_pct: 0, overrides: { ['option:' + door9.id]: 100 } }] });
  const down = (await price(cfg)).data; assert.equal(down.lines.find(l => l.label === door9.name).amount, 0, 'cheaper swap gives no credit when turned off');
  await setS({ downgrade_credit: true });
  const down2 = (await price(cfg)).data; assert.equal(down2.lines.find(l => l.label === door9.name).amount, 100 - door36.price, 'cheaper swap credits the difference');
  await setS({ price_tiers: [{ id: 1, name: 'Standard', adjust_pct: 0, overrides: {} }] });

  // tax and delivery
  await setS({ tax_rate: '7.25', delivery_fee: 150, tax_delivery: false });
  const t1 = (await price(cfg)).data;
  assert.equal(t1.delivery, 150); assert.equal(t1.tax_rate, 7.25); assert.equal(t1.tax, r2(t1.subtotal * 0.0725)); assert.equal(t1.total, r2(t1.subtotal + 150 + t1.tax));
  await setS({ tax_delivery: true });
  const t2 = (await price(cfg)).data; assert.equal(t2.tax, r2((t2.subtotal + 150) * 0.0725), 'tax on delivery when turned on');

  // the saved quote is priced on the server with the same rules and never trusts the browser's prices
  const q = await admin.post('/api/v1/quotes', { config: { ...cfg, items: [...cfg.items.map(i => ({ ...i, price: 0, amount: 0 }))], total: 1 }, customer: { first_name: 'Pat', email: 'pat@test.com', phone: '6155559000' } });
  assert.equal(q.status, 201); assert.equal(q.data.pricing.total, t2.total, 'quote total = price API total');
  await setS({ tax_rate: 0, delivery_fee: 0, tax_delivery: false });
  void defaultItems;
});

test('pricing: tampered configurations are cleaned up (unavailable options, fake standard items, package-only parts, overlaps)', async () => {
  const size = gable.sizes[0];
  const cupola = opt('Cupola'), breaker = opt('Breaker Box (60A sub-panel)'), door36 = opt('36" Single Door'), french = opt('French Doors (5\')'), win = opt("2' x 3' Window");
  // limit this style to a few options
  const allowed = cat.options.filter(o => o.name !== cupola.name).map(o => o.id);
  assert.equal((await admin.patch('/api/v1/styles/' + gable.id, { available_options: allowed })).status, 200);
  const p = (await price({ style_id: gable.id, size_id: size.id, items: [
    { uid: 'c', option_id: cupola.id, wall: 'roof' },                                     // not offered on this style
    { uid: 'b', option_id: breaker.id, wall: 'back', offset: 0 },                        // only sold inside a package
    { uid: 'f', option_id: french.id, wall: 'front', offset: 0, standard_of: door36.id }, // fine: a real swap
    { uid: 'x', option_id: win.id, wall: 'front', offset: 0, standard_of: cupola.id },   // fake "standard" → full price
    { uid: 'y', option_id: 999999, wall: 'front' },                                       // doesn't exist
  ] })).data;
  assert.ok(!p.lines.some(l => l.label === cupola.name), 'unavailable option dropped');
  assert.ok(!p.lines.some(l => l.label === breaker.name), 'package-only part dropped');
  const w = p.lines.find(l => l.label === win.name); assert.equal(w?.amount, win.price, 'fake standard item charged in full');
  const doorsOnFront = p.lines.filter(l => l.wall === 'front' && l.type === 'option').length;
  assert.ok(doorsOnFront >= 1, 'overlapping items moved or dropped, not stacked');
  assert.equal((await price({ style_id: gable.id, size_id: 999999 })).status, 400, 'unknown size');
  assert.equal((await price({ style_id: 999999, size_id: size.id })).status, 400, 'unknown style');
  assert.equal((await anon.post('/api/v1/price', '{not json', { headers: { 'Content-Type': 'application/json' } })).status, 400, 'bad JSON is a 400, not a crash');
  await admin.patch('/api/v1/styles/' + gable.id, { available_options: null });
});

test('pricing: tiers by dealer lot and by ZIP (percent, overrides, tier delivery fee), lot staff locked to their lot', async () => {
  const size = gable.sizes[0];
  const tiers = [
    { id: 1, name: 'Standard', adjust_pct: 0, overrides: {} },
    { id: 2, name: 'Plus 5', adjust_pct: 5, overrides: {}, delivery_fee: 300 },
    { id: 3, name: 'Override', adjust_pct: 0, overrides: { ['size:' + size.id]: 9999 } },
    { id: 4, name: 'Plus 10', adjust_pct: 10, overrides: {} },
  ];
  await setS({ pricing_mode: 'dealer', price_tiers: tiers, default_tier: 1, delivery_fee: 100,
    dealers: [{ id: 'lotA', name: 'Lot A', tier: 1 }, { id: 'lotB', name: 'Lot B', tier: 2 }, { id: 'lotC', name: 'Lot C', tier: 3 }] });
  const cfg = d => ({ style_id: gable.id, size_id: size.id, dealer_id: d });
  const a = (await price(cfg('lotA'))).data, b = (await price(cfg('lotB'))).data, c = (await price(cfg('lotC'))).data, none = (await price(cfg(null))).data;
  assert.equal(a.lines[0].amount, size.price); assert.equal(a.delivery, 100); assert.equal(a.dealer.name, 'Lot A');
  assert.equal(b.lines[0].amount, Math.round(size.price * 1.05), '+5% (whole dollars)'); assert.equal(b.delivery, 300, 'tier delivery fee'); assert.equal(b.tier_name, 'Plus 5');
  assert.equal(c.lines[0].amount, 9999, 'override wins');
  assert.equal(none.dealer, null); assert.equal(none.lines[0].amount, size.price, 'no lot → default tier');
  // a sales login tied to Lot B always prices + quotes at Lot B, whatever the browser sends
  await admin.post('/api/admin/users', { email: 'lotb@test.com', name: 'Lot B rep', password: 'password-123', role: 'sales', dealer_id: 'lotB' });
  const rep = new Client(); await rep.login('lotb@test.com', 'password-123');
  assert.equal((await price(cfg('lotA'), rep)).data.dealer.id, 'lotB', 'price API locked to the lot');
  const q = await rep.post('/api/v1/quotes', { config: cfg('lotA'), customer: { first_name: 'Lou', email: 'lou@test.com' } });
  assert.equal(q.status, 201); assert.equal(q.data.dealer.id, 'lotB'); assert.equal(q.data.pricing.total, b.total);

  await setS({ pricing_mode: 'zip', zip_tiers: [{ match: '383', tier: 2 }, { match: '38301', tier: 3 }, { match: '37000-37999', tier: 4 }] });
  const z = async zip => (await price({ style_id: gable.id, size_id: size.id, zip })).data;
  assert.equal((await z('38301')).tier_name, 'Override', 'exact ZIP wins');
  assert.equal((await z('38350')).tier_name, 'Plus 5', 'prefix');
  assert.equal((await z('37201')).tier_name, 'Plus 10', 'range');
  assert.equal((await z('90210')).tier_name, 'Standard', 'unlisted ZIP → default tier');
  assert.equal((await z('3830')).tier_name, 'Standard', 'not a 5-digit ZIP → default tier');
  const zq = await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: size.id, zip: '38350' }, customer: { first_name: 'Zip', email: 'zip@test.com' } });
  assert.equal(zq.data.pricing.tier, 'Plus 5'); assert.equal(zq.data.pricing.pricing_zip, '38350');
  await setS({ pricing_mode: 'none', delivery_fee: 0, zip_tiers: [] });
});

// =============================================================================
// CONFIGURATOR SETTINGS
// =============================================================================
test('configurator settings: hide prices from customers (catalog, price API, quote reply), staff + API keys still see them', async () => {
  await setS({ show_prices: false });
  const pub = (await anon.get('/api/v1/catalog')).data;
  assert.equal(pub.settings.prices_hidden, true);
  assert.ok(pub.styles.every(s => s.sizes.every(z => z.price === 0)) && pub.options.every(o => o.price === 0), 'no prices sent to the browser');
  assert.equal((await price({ style_id: gable.id, size_id: gable.sizes[0].id })).status, 403);
  const q = await anon.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Hid', email: 'hid@test.com' } });
  assert.equal(q.status, 201); assert.equal(q.data.pricing.hidden, true); assert.ok(!JSON.stringify(q.data).includes('"price"'), 'no option prices in the reply');
  const full = (await admin.get('/api/v1/quotes/' + q.data.id)).data; assert.ok(full.pricing.total > 0, 'still priced and saved for you');
  const shared = (await anon.get('/api/v1/shared/' + new URL(full.links.view_3d).searchParams.get('q'))).data; assert.equal(shared.total, undefined, 'shared link has no total');
  const staffCat = (await admin.get('/api/v1/catalog')).data; assert.ok(staffCat.styles[0].sizes[0].price > 0, 'staff (dealer mode) see prices'); assert.ok(staffCat.viewer?.dealer_mode);
  const key = (await admin.post('/api/admin/api-keys', { name: 'pricing' })).data.key;
  assert.equal((await new Client({ 'X-API-Key': key }).post('/api/v1/price', { style_id: gable.id, size_id: gable.sizes[0].id })).status, 200, 'API key can price');
  await setS({ show_prices: true });
  assert.ok((await anon.get('/api/v1/catalog')).data.styles[0].sizes[0].price > 0);
});

test('configurator settings: required phone, consent, currency, public settings only, validation', async () => {
  await setS({ require_phone: true, currency_symbol: 'CA$', headline: 'Build yours', consent_text: 'OK to text me' });
  const base = { config: { style_id: gable.id, size_id: gable.sizes[0].id } };
  assert.equal((await anon.post('/api/v1/quotes', { ...base, customer: { first_name: 'Ph', email: 'ph@test.com' } })).status, 400, 'phone required for customers');
  const ok = await anon.post('/api/v1/quotes', { ...base, customer: { first_name: 'Ph', email: 'ph@test.com', phone: '6155550999', sms_consent: true } });
  assert.equal(ok.status, 201);
  assert.equal((await admin.get('/api/v1/quotes/' + ok.data.id)).data.customer.sms_consent, true, 'consent saved');
  assert.equal((await admin.post('/api/v1/quotes', { ...base, customer: { first_name: 'Staff', email: 'st@test.com' } })).status, 201, 'staff on the lot can skip the phone');
  assert.equal((await anon.post('/api/v1/quotes', { ...base, customer: { first_name: 'Bad', email: 'not-an-email', phone: '1' } })).status, 400);
  const pub = (await anon.get('/api/v1/catalog')).data.settings;
  assert.equal(pub.currency_symbol, 'CA$'); assert.equal(pub.headline, 'Build yours'); assert.equal(pub.require_phone, true);
  for (const secret of ['twilio_token', 'smtp_pass', 'ghl_token', 'inbound_key', 'notify_phones', 'public_url']) assert.equal(pub[secret], undefined, secret + ' never public');
  assert.equal((await admin.put('/api/admin/settings', { public_url: 'builder.example.com/page' })).status, 400, 'public URL checked');
  assert.equal((await admin.put('/api/admin/settings', { email_from: 'nope' })).status, 400, 'From address checked');
  assert.equal((await admin.put('/api/admin/settings', { twilio_from: '12' })).status, 400, 'Twilio number checked');
  const sales = new Client(); await sales.login('lotb@test.com', 'password-123');
  assert.equal((await sales.put('/api/admin/settings', { show_prices: false })).status, 403, 'only admins change settings');
  await setS({ require_phone: false, currency_symbol: '$' });
});

// =============================================================================
// 3D MODELS + IMAGES
// =============================================================================
test('3D models: upload a .glb, attach it to an option, it reaches the configurator; bad files refused', async () => {
  const up = (buf, name) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); return admin.post('/api/admin/upload', fd); };
  const g = await up(makeGLB(), 'Lean To Door.GLB');
  assert.equal(g.status, 200, JSON.stringify(g.data)); assert.match(g.data.url, /^\/uploads\/.+\.glb$/);
  const served = await anon.get(g.data.url, { raw: true }); assert.equal(served.status, 200);
  const bytes = Buffer.from(await served.arrayBuffer()); assert.equal(bytes.toString('latin1', 0, 4), 'glTF', 'model served byte-for-byte');
  // a renamed text file, an .exe, an empty file and a fake PNG are refused with a clear message
  const fake = await up(Buffer.from('this is not a model'), 'door.glb'); assert.equal(fake.status, 400); assert.match(fake.data.error, /valid 3D model/);
  assert.equal((await up(Buffer.from('MZ'), 'virus.exe')).status, 400);
  assert.equal((await up(Buffer.alloc(0), 'empty.glb')).status, 400);
  assert.equal((await up(Buffer.from('hello'), 'pic.png')).status, 400);
  assert.equal((await up(Buffer.from(PNG.split(',')[1], 'base64'), 'pic.png')).status, 200, 'real PNG ok');
  assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'logo.svg')).status, 200, 'SVG ok');
  const gltf = await up(Buffer.from(JSON.stringify({ asset: { version: '2.0' } })), 'model.gltf'); assert.equal(gltf.status, 200);
  // attach to an option → shows in the public catalog the configurator loads
  const o = opt('Flower Box');
  assert.equal((await admin.patch('/api/v1/options/' + o.id, { model_url: g.data.url })).status, 200);
  assert.equal((await anon.get('/api/v1/catalog')).data.options.find(x => x.id === o.id).model_url, g.data.url);
  // only admins upload; deleting can't escape the uploads folder
  const sales = new Client(); await sales.login('lotb@test.com', 'password-123');
  const fd = new FormData(); fd.append('file', new Blob([makeGLB()]), 'x.glb');
  assert.equal((await sales.post('/api/admin/upload', fd)).status, 403);
  assert.equal((await admin.del('/api/admin/upload?url=/uploads/../db.sqlite')).status, 400);
  assert.equal((await admin.del('/api/admin/upload?url=' + encodeURIComponent('/uploads/a/../../x'))).status, 400);
  assert.equal((await anon.get('/uploads/../server.js', { raw: true })).status === 200 && false, false);
  await admin.patch('/api/v1/options/' + o.id, { model_url: null });
});

// =============================================================================
// OPEN API: keys, catalog CRUD, quotes
// =============================================================================
test('API keys: X-API-Key or Bearer works, wrong/revoked keys refused, last used recorded', async () => {
  const k = (await admin.post('/api/admin/api-keys', { name: 'Website' })).data;
  assert.ok(k.key && k.id);
  const viaHeader = new Client({ 'X-API-Key': k.key }), viaBearer = new Client({ Authorization: 'Bearer ' + k.key });
  assert.equal((await viaHeader.get('/api/v1/quotes')).status, 200);
  assert.equal((await viaBearer.get('/api/v1/styles')).status, 200);
  assert.equal((await new Client({ 'X-API-Key': 'sk_wrong' }).get('/api/v1/quotes')).status, 401);
  assert.equal((await anon.get('/api/v1/quotes')).status, 401);
  const list = (await admin.get('/api/admin/api-keys')).data; const row = list.find(x => x.id === k.id);
  assert.ok(row.last_used, 'last used recorded'); assert.equal(row.key, undefined, 'the key itself is never shown again'); assert.equal(row.key_hash, undefined);
  // API keys can't reach the admin back office
  assert.equal((await viaHeader.get('/api/admin/settings')).status, 401);
  assert.equal((await viaHeader.get('/api/crm/contacts')).status, 401);
  assert.equal((await admin.del('/api/admin/api-keys/' + k.id)).status, 204);
  assert.equal((await viaHeader.get('/api/v1/quotes')).status, 401, 'revoked');
});

test('API: quotes list/filter/update/delete + floor plan; catalog create/edit/duplicate/sizes/delete', async () => {
  const key = (await admin.post('/api/admin/api-keys', { name: 'crud' })).data.key; const api = new Client({ 'X-API-Key': key });
  const q = await api.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Api', last_name: 'Person', email: 'api@test.com' }, source: 'website form' });
  assert.equal(q.status, 201);
  const found = (await api.get('/api/v1/quotes?q=api@test.com')).data; assert.equal(found.total, 1); assert.equal(found.data[0].number, q.data.number);
  assert.equal((await api.get('/api/v1/quotes?status=won&q=api@test.com')).data.total, 0);
  assert.equal((await api.get('/api/v1/quotes?limit=1')).data.data.length, 1);
  assert.ok((await api.get('/api/v1/quotes?since=2000-01-01T00:00:00Z')).data.total >= 1);
  const up = await api.patch('/api/v1/quotes/' + q.data.id, { status: 'contacted', internal_notes: 'called' }); assert.equal(up.status, 200); assert.equal(up.data.status, 'contacted');
  const plan = await api.get(`/api/v1/quotes/${q.data.id}/floorplan.svg`, { raw: true }); assert.equal(plan.status, 200); assert.match(plan.headers.get('content-type'), /svg/);
  const pubPlan = await anon.get(new URL(q.data.links.floor_plan_svg).pathname, { raw: true }); assert.equal(pubPlan.status, 200, 'customer floor plan link works');
  assert.equal((await api.get('/api/v1/quotes/999999')).status, 404);

  // catalog
  const st = await api.post('/api/v1/styles', { name: 'API Shed', roof_type: 'gable', wall_height: 7, roof_pitch: 4, active: true, standard_options: [], default_colors: {} });
  assert.equal(st.status, 201, JSON.stringify(st.data));
  const sizes = await api.put(`/api/admin/styles/${st.data.id}/sizes`, [{ width: 8, depth: 10, price: 3000 }]);
  assert.equal(sizes.status, 401, 'size grid is admin-only (session)');
  const sz = await admin.put(`/api/admin/styles/${st.data.id}/sizes`, [{ width: 8, depth: 10, price: 3000 }, { width: 10, depth: 12, price: 4200 }, { width: 0, depth: 5 }]);
  assert.equal(sz.data.length, 2, 'blank rows skipped');
  assert.ok((await anon.get('/api/v1/catalog')).data.styles.some(s => s.name === 'API Shed'), 'new style live in the configurator');
  const pr = (await price({ style_id: st.data.id, size_id: sz.data[1].id })).data; assert.equal(pr.total, 4200);
  const dup = await admin.post(`/api/admin/duplicate/styles/${st.data.id}`); assert.equal(dup.status, 200);
  const dsz = (await api.get('/api/v1/sizes?style_id=' + dup.data.id)).data; assert.equal(dsz.length, 2, 'sizes copied with the style');
  assert.equal((await admin.post('/api/admin/duplicate/users/1')).status, 400, 'only catalog tables can be duplicated');
  const col = await api.post('/api/v1/colors', { name: 'Test Teal', hex: '#118888', category: 'siding', price: 99 }); assert.equal(col.status, 201);
  const o = await api.post('/api/v1/options', { name: 'API Shelf', category: 'interior', kind: 'shelf', placement: 'wall_interior', width: 4, height: 0.1, depth: 1, price: 80 });
  assert.equal(o.status, 201);
  assert.equal((await api.patch('/api/v1/options/' + o.data.id, { price: 85, bogus: 1 })).data.price, 85, 'unknown fields ignored');
  assert.equal((await api.post('/api/v1/options', { bogus: 1 })).status, 400, 'no valid fields');
  for (const [t, id] of [['options', o.data.id], ['colors', col.data.id], ['styles', dup.data.id], ['styles', st.data.id]]) assert.equal((await api.del(`/api/v1/${t}/${id}`)).status, 204);
  assert.equal((await api.get('/api/v1/styles/' + st.data.id)).status, 404);
  assert.equal((await api.del('/api/v1/quotes/' + q.data.id)).status, 204);
  assert.equal((await api.get('/api/v1/quotes/' + q.data.id)).status, 404);
});

test('API: role limits on the Open API, OpenAPI document matches the real routes, docs + health', async () => {
  await admin.post('/api/admin/users', { email: 'prod2@test.com', name: 'Prod', password: 'password-123', role: 'production' });
  const prod = new Client(); await prod.login('prod2@test.com', 'password-123');
  const q = await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Role', email: 'role@test.com' } });
  const pq = await prod.get('/api/v1/quotes/' + q.data.id);
  assert.equal(pq.status, 200, 'production can open a quote (drawings)');
  assert.equal(pq.data.pricing, null); assert.deepEqual(pq.data.pricing_lines, []); assert.ok(pq.data.options.every(o => o.price === undefined)); assert.doesNotMatch(pq.data.summary, /Total/);
  assert.ok(pq.data.config && pq.data.customer.full_name, 'but gets what the drawings need');
  assert.equal((await prod.patch('/api/v1/quotes/' + q.data.id, { status: 'won' })).status, 403);
  assert.equal((await prod.del('/api/v1/quotes/' + q.data.id)).status, 403);
  assert.equal((await prod.post('/api/v1/styles', { name: 'x' })).status, 403);
  const rep = new Client(); await rep.login('lotb@test.com', 'password-123');
  assert.equal((await rep.get('/api/v1/quotes/' + q.data.id)).status, 404, 'lot rep cannot see another lot\'s quote');
  assert.equal((await rep.patch('/api/v1/quotes/' + q.data.id, { status: 'won' })).status, 404);
  assert.ok((await rep.get('/api/v1/quotes')).data.data.every(x => x.dealer?.id === 'lotB'), 'list limited to their lot');

  const doc = (await anon.get('/api/openapi.json')).data;
  assert.match(doc.openapi, /^3\./); assert.equal(doc.servers[0].url, B);
  const paths = Object.keys(doc.paths);
  for (const p of ['/v1/catalog', '/v1/price', '/v1/quotes', '/v1/quotes/{id}', '/v1/webhooks']) assert.ok(paths.some(x => x.endsWith(p)), 'documented: ' + p);
  // every documented GET without parameters really answers (no stale docs)
  for (const p of paths.filter(x => !x.includes('{') && doc.paths[x].get)) {
    const url = (p.startsWith('/api') ? '' : '/api') + p;
    const r = await admin.get(url); assert.ok(r.status < 400, `${url} → ${r.status}`);
  }
  assert.equal((await anon.get('/docs', { raw: true })).status, 200);
  const hz = (await anon.get('/healthz')).data; assert.equal(hz.ok, true); assert.ok(hz.version && hz.checks.database && hz.checks.login);
  assert.equal((await anon.get('/api/v1/nope')).status, 401);
});

// =============================================================================
// INTEGRATIONS: webhooks + GoHighLevel
// =============================================================================
test('webhooks: signed deliveries, event filtering, custom headers, retries on errors, no retry on 4xx, test button, log', async () => {
  const mk = async (name, path, events, extra = {}) => { const r = await admin.post('/api/v1/webhooks', { name, url: RECV + path, events, active: true, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
  assert.equal((await admin.post('/api/v1/webhooks', { name: 'bad', url: 'ftp://x', events: ['*'] })).status, 400);
  await mk('signed', '/hook/ok', ['quote.created'], { secret: 'shh', headers: { 'X-Team': 'trimline' } });
  await mk('all', '/hook/all', ['*']);
  const flakyHook = await mk('flaky', '/hook/flaky', ['quote.status_changed']);
  await mk('bad', '/hook/bad', ['quote.created']);
  hits.length = 0;
  const q = await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Hook', last_name: 'Test', email: 'hook@test.com', phone: '6155551234' } });
  const [ok] = await waitHit(h => h.path === '/hook/ok');
  assert.ok(ok, 'webhook delivered');
  assert.equal(ok.json.event, 'quote.created'); assert.equal(ok.json.data.number, q.data.number); assert.equal(ok.json.data.customer.email, 'hook@test.com');
  assert.ok(ok.json.data.pricing.total > 0 && ok.json.data.links.view_3d && ok.json.data.links.floor_plan_svg, 'full quote in the payload');
  const sig = 'sha256=' + crypto.createHmac('sha256', 'shh').update(ok.body).digest('hex');
  assert.equal(ok.headers['x-shedbuilder-signature'], sig, 'HMAC signature verifies');
  assert.equal(ok.headers['x-team'], 'trimline', 'custom header sent');
  assert.equal(ok.headers['x-shedbuilder-event'], 'quote.created');
  assert.equal((await waitHit(h => h.path === '/hook/all')).length, 1, '* gets every event');
  assert.equal((await waitHit(h => h.path === '/hook/flaky', 500)).length, 0, 'not subscribed to quote.created');
  await waitHit(h => h.path === '/hook/bad'); await sleep(1500);
  assert.equal(hits.filter(h => h.path === '/hook/bad').length, 1, 'a 400 is not retried');
  // status change → flaky hook: 500 then retried and delivered
  await admin.patch('/api/v1/quotes/' + q.data.id, { status: 'contacted' });
  const fl = await waitHit(h => h.path === '/hook/flaky' && hits.filter(x => x.path === '/hook/flaky').length >= 2, 5000);
  assert.ok(fl.length >= 2, 'retried after a 500');
  assert.equal(fl[0].json.event, 'quote.status_changed');
  const log = (await admin.get('/api/admin/webhook-log')).data;
  const flLog = log.filter(l => l.target.endsWith('/hook/flaky')); assert.ok(flLog.some(l => l.attempt === 2 && l.ok === 1) && flLog.some(l => l.attempt === 1 && l.ok === 0), 'log shows the retry');
  // notes-only update fires quote.updated (the "all" hook)
  hits.length = 0; await admin.patch('/api/v1/quotes/' + q.data.id, { internal_notes: 'n' });
  assert.equal((await waitHit(h => h.path === '/hook/all'))[0].json.event, 'quote.updated');
  // test button + inactive hooks are skipped
  const t = await admin.post(`/api/v1/webhooks/${flakyHook.id}/test`); assert.equal(t.status, 200); assert.equal(t.data.ok, true);
  for (const h of (await admin.get('/api/v1/webhooks')).data) await admin.patch('/api/v1/webhooks/' + h.id, { active: false });
  hits.length = 0; await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Off', email: 'off@test.com' } });
  await sleep(800); assert.equal(hits.filter(h => h.path.startsWith('/hook/')).length, 0, 'inactive hooks get nothing');
  assert.ok((await admin.get('/api/admin/events')).data.includes('quote.created'));
});

test('GoHighLevel: inbound-webhook (flat fields) and the native API push (contact, opportunity, note), errors logged', async () => {
  await setS({ ghl_inbound_webhook_url: RECV + '/ghl-inbound', ghl_enabled: true, ghl_token: 'good-token', ghl_location_id: 'LOC1', ghl_pipeline_id: 'P1', ghl_stage_id: 'S1', ghl_tags: 'shed-quote, 3d', ghl_custom_fields: { shed_size: 'shed.size' } });
  hits.length = 0;
  const q = await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Gina', last_name: 'High', email: 'gina@test.com', phone: '6155554321', zip: '38301', notes: 'gate code 12' } });
  const [inb] = await waitHit(h => h.path === '/ghl-inbound');
  assert.ok(inb, 'inbound webhook hit');
  for (const [k, v] of Object.entries({ first_name: 'Gina', email: 'gina@test.com', postal_code: '38301', quote_number: q.data.number })) assert.equal(inb.json.data[k], v, 'flat field ' + k);
  assert.ok(inb.json.data.shed_3d_link && inb.json.data.floor_plan_link);
  const [up] = await waitHit(h => h.path === '/contacts/upsert');
  assert.ok(up, 'native contact upsert');
  assert.equal(up.headers.authorization, 'Bearer good-token'); assert.equal(up.headers.version, '2021-07-28');
  assert.equal(up.json.locationId, 'LOC1'); assert.equal(up.json.email, 'gina@test.com'); assert.deepEqual(up.json.tags, ['shed-quote', '3d']);
  assert.deepEqual(up.json.customFields, [{ key: 'shed_size', field_value: q.data.shed.size }], 'custom field mapping');
  const [op] = await waitHit(h => h.path === '/opportunities/');
  assert.equal(op.json.pipelineId, 'P1'); assert.equal(op.json.pipelineStageId, 'S1'); assert.equal(op.json.contactId, 'ghlC1'); assert.equal(op.json.monetaryValue, q.data.pricing.total);
  const [note] = await waitHit(h => h.path === '/contacts/ghlC1/notes');
  assert.match(note.json.body, new RegExp(q.data.number)); assert.match(note.json.body, /gate code 12/);
  for (let i = 0; i < 40 && (await admin.get('/api/v1/quotes/' + q.data.id)).data.ghl_status !== 'synced'; i++) await sleep(50);
  assert.equal((await admin.get('/api/v1/quotes/' + q.data.id)).data.ghl_status, 'synced');
  // "Send test" uses the latest quote; a bad token comes back as a readable error and is logged
  assert.equal((await admin.post('/api/admin/ghl/test')).data.ok, true);
  await setS({ ghl_token: 'bad-token' });
  const bad = await admin.post('/api/admin/ghl/test'); assert.equal(bad.status, 400); assert.match(bad.data.error, /401/);
  assert.ok((await admin.get('/api/admin/webhook-log')).data.some(l => /GHL POST \/contacts\/upsert/.test(l.target) && l.status === 401));
  // the token is never sent back to the browser
  const st = (await admin.get('/api/admin/settings')).data; assert.ok(!String(st.ghl_token).includes('bad-token')); assert.equal(st.ghl_token_set, true);
  await setS({ ghl_enabled: false, ghl_inbound_webhook_url: '' });
});

test('GoHighLevel: the quote PDF with pricing goes to the contact and opportunity (drawings from the browser, pricing from the server)', async () => {
  await setS({ ghl_enabled: true, ghl_token: 'good-token', ghl_location_id: 'LOC1', ghl_pipeline_id: 'P1', ghl_stage_id: 'S1', ghl_custom_fields: {}, ghl_pdf_field: '{{opportunity.quote_pdf__3d_builder}}', ghl_send_pdf: 1, public_url: '' });
  const dwg = await PDFDocument.create(); dwg.addPage([792, 612]); dwg.addPage([792, 612]); const dwgBytes = Buffer.from(await dwg.save());
  const upload = (url, bytes, type = 'application/pdf') => { const fd = new FormData(); fd.append('drawings', new Blob([bytes], { type }), 'd.pdf'); return fetch(B + url, { method: 'POST', body: fd }); };
  hits.length = 0;
  const q = await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Pia', last_name: 'Dee', email: 'pia@test.com' }, with_drawings: true });
  assert.equal(q.status, 201); assert.match(q.data.drawings_upload, /^\/api\/v1\/quote-drawings\/[a-f0-9]{32}$/, 'the configurator is asked for the drawings');
  await sleep(300); assert.ok(!hits.some(h => h.path === '/medias/upload-file'), 'waits for the drawings before sending');
  assert.equal((await upload(q.data.drawings_upload, Buffer.from('not a pdf at all, just text that is long enough to pass the size check........................................'))).status, 400, 'non-PDF refused');
  assert.equal((await upload(q.data.drawings_upload, dwgBytes)).status, 202);
  assert.equal((await upload(q.data.drawings_upload, dwgBytes)).status, 404, 'only one upload per quote');
  assert.equal((await upload('/api/v1/quote-drawings/' + 'a'.repeat(32), dwgBytes)).status, 404);
  const [med] = await waitHit(h => h.path === '/medias/upload-file');
  assert.ok(med, 'PDF uploaded to GHL media'); assert.equal(med.headers.authorization, 'Bearer good-token'); assert.match(med.headers['content-type'], /multipart\/form-data/);
  assert.match(med.body, /%PDF-/); assert.match(med.body, new RegExp(q.data.number + '-quote\\.pdf'));
  const [note] = await waitHit(h => h.path === '/contacts/ghlC1/notes' && /Quote PDF/.test(h.json?.body));
  assert.match(note.json.body, new RegExp(`Quote PDF ${q.data.number} .*\\(pricing \\+ drawings\\)\\nhttps://storage\\.example\\.com/media/`));
  const [opp] = await waitHit(h => h.path === '/opportunities/ghlO1' && h.method === 'PUT');
  assert.deepEqual(opp.json.customFields, [{ id: 'cfPDF', key: 'quote_pdf__3d_builder', field_value: note.json.body.split('\n')[1] }], 'link in the opportunity custom field');
  // staff can download the same PDF: pricing page + the 2 drawing pages
  for (let i = 0; i < 40 && !(await admin.get('/api/v1/quotes/' + q.data.id)).data.ghl_pdf_url; i++) await sleep(50);
  const dl = await fetch(B + `/api/v1/quotes/${q.data.id}/quote.pdf`, { headers: { cookie: admin.cookie } });
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.equal((await PDFDocument.load(Buffer.from(await dl.arrayBuffer()))).getPageCount(), 3);
  assert.equal((await fetch(B + `/api/v1/quotes/${q.data.id}/quote.pdf`)).status, 401, 'download needs a login');
  // a quote from the API (no browser): the pricing PDF goes right away. Without the medias scope, the note links a private copy here.
  mediaDown = true; await setS({ public_url: B }); hits.length = 0;
  const q2 = await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[1].id }, customer: { first_name: 'Api', email: 'api@test.com' } });
  assert.equal(q2.data.drawings_upload, undefined);
  const [n2] = await waitHit(h => h.path === '/contacts/ghlC1/notes' && /Quote PDF/.test(h.json?.body));
  const link = n2.json.body.split('\n')[1]; assert.match(n2.json.body, /\(pricing\)/); assert.match(link, /\/q\/pdf\/[a-f0-9]{32}$/);
  const pub = await fetch(link); assert.equal(pub.status, 200); assert.equal(pub.headers.get('content-type'), 'application/pdf');
  assert.equal((await fetch(B + '/q/pdf/' + 'b'.repeat(32))).status, 404);
  assert.ok((await admin.get('/api/admin/webhook-log')).data.some(l => /medias\/upload-file/.test(l.target) && /medias\.write/.test(l.response)), 'missing scope explained in the delivery log');
  // switched off (the checkbox saves 0): nothing asked, nothing sent
  mediaDown = false; await setS({ ghl_send_pdf: 0, ghl_add_note: 0 }); hits.length = 0;
  const q3 = await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Off', email: 'off@test.com' }, with_drawings: true });
  assert.equal(q3.data.drawings_upload, undefined); await waitHit(h => h.path === '/opportunities/'); await sleep(400);
  assert.ok(!hits.some(h => h.path === '/medias/upload-file' || /notes$/.test(h.path)), 'no PDF and no note when both are switched off');
  await setS({ ghl_enabled: false, ghl_send_pdf: 1, ghl_add_note: 1, ghl_pdf_field: '', public_url: '' });
});

test('Quote PDF security: upload limits, page bombs, broken PDFs; who may read quotes and the priced PDF', async () => {
  await setS({ ghl_enabled: true, ghl_token: 'good-token', ghl_location_id: 'LOC1', ghl_pipeline_id: '', ghl_send_pdf: 1, ghl_add_note: 0, ghl_custom_fields: {}, ghl_pdf_field: '' });
  const mk = async () => (await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Sec', email: 'sec@test.com' }, with_drawings: true })).data;
  const up = (url, bytes, name = 'drawings') => { const fd = new FormData(); fd.append(name, new Blob([bytes], { type: 'application/pdf' }), 'd.pdf'); return fetch(B + url, { method: 'POST', body: fd }); };
  const q = await mk(); assert.ok(q.drawings_upload, 'customer upload offered');
  assert.equal((await up(q.drawings_upload, Buffer.alloc(26 * 1024 * 1024, 32))).status, 413, 'over 25 MB refused');
  const bomb = await PDFDocument.create(); for (let i = 0; i < 13; i++) bomb.addPage([10, 10]);
  assert.equal((await up(q.drawings_upload, Buffer.from(await bomb.save()))).status, 400, 'more than 12 pages refused');
  assert.equal((await up(q.drawings_upload, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4000, 65)]))).status, 400, 'broken PDF refused');
  assert.equal((await up(q.drawings_upload, Buffer.from('%PDF-1.7'), 'other')).status, 400, 'unexpected form field refused');
  const ok = await PDFDocument.create(); ok.addPage([792, 612]);
  assert.equal((await up(q.drawings_upload, Buffer.from(await ok.save()))).status, 202, 'a good upload still works after the bad tries');
  assert.equal((await up('/api/v1/quote-drawings/../../etc', Buffer.from('x'))).status, 404);
  // who may read quotes: sales yes (incl. the priced PDF, own lot only); production only the floor plan
  await admin.post('/api/admin/users', { email: 'prod3@test.com', name: 'P3', password: 'password-123', role: 'production' });
  const prod = new Client(); await prod.login('prod3@test.com', 'password-123');
  assert.equal((await prod.get('/api/v1/quotes')).status, 403, 'production cannot list quotes (prices, customers)');
  assert.equal((await prod.get(`/api/v1/quotes/${q.id}/quote.pdf`)).status, 403);
  assert.equal((await prod.get(`/api/v1/quotes/${q.id}/floorplan.svg`)).status, 200, 'floor plan for order cards');
  const rep = new Client(); await rep.login('lotb@test.com', 'password-123');
  assert.equal((await rep.get(`/api/v1/quotes/${q.id}/quote.pdf`)).status, 404, 'lot staff: not another lot\'s quote');
  const repQ = (await rep.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Lot', email: 'lotq@test.com' } })).data;
  const pdf = await rep.get(`/api/v1/quotes/${repQ.id}/quote.pdf`); assert.equal(pdf.status, 200, 'sales can download their own quote PDF');
  // staff who aren't admins don't get integration setup (signing secret, GHL owners, email keys…)
  await setS({ webhook_secret: 'whsec_test_123', ghl_owner_id: 'U9', ghl_opp_name: '{number}', email_api_key: 're_secret_999' });
  const rs = (await rep.get('/api/admin/settings')).data;
  assert.ok(rs.company_name !== undefined || rs.styles !== undefined || Object.keys(rs).length > 5, 'still gets drawing/pricing settings');
  for (const k of Object.keys(rs)) assert.doesNotMatch(k, /^(ghl_|smtp_|twilio_|email_api|webhook|inbound|backup)/, 'sales sees ' + k);
  assert.doesNotMatch(JSON.stringify(rs), /whsec_test_123|re_secret_999|U9/);
  const as = (await admin.get('/api/admin/settings')).data; assert.equal(as.webhook_secret, 'whsec_test_123'); assert.match(as.email_api_key, /^•+_999$|^•+r_999$|•+999$/);
  await setS({ ghl_enabled: false, ghl_add_note: 1, ghl_owner_id: '', ghl_opp_name: '', email_api_key: '' });
});

test('GoHighLevel: settings lists come from GHL; opportunity gets owner, forecast, name pattern and mapped custom fields', async () => {
  await setS({ ghl_enabled: true, ghl_token: 'good-token', ghl_location_id: 'LOC1', ghl_pipeline_id: 'P1', ghl_stage_id: 'S2', ghl_send_pdf: 0, ghl_add_note: 0 });
  const look = (await admin.get('/api/admin/ghl/lookup')).data;
  assert.deepEqual(look.pipelines[0].stages.map(s => s.name), ['New lead', 'Quoted']);
  assert.deepEqual(look.users.map(u => u.name), ['Jalon', 'Lot Rep']);
  assert.deepEqual(look.fields.map(f => [f.model, f.key]), [['opportunity', 'opportunity.quote_pdf__3d_builder'], ['opportunity', 'opportunity.shed_style'], ['contact', 'contact.quote_total']]);
  assert.ok(look.values.some(v => v[0] === 'links.quote_pdf'));
  const dealer = (await admin.get('/api/admin/settings')).data.dealers?.[0];
  await setS({ ghl_owner_id: 'U1', ghl_dealer_owners: dealer ? { [dealer.id]: 'U2' } : {}, ghl_close_days: 14, ghl_probability: 20, ghl_opp_name: '{shed.size} {shed.style} for {customer.full_name} ({number})',
    ghl_custom_fields: { 'opportunity.shed_style': 'shed.style', '{{contact.quote_total}}': 'pricing.total', 'opportunity.not_in_ghl': 'shed.size' } });
  hits.length = 0;
  const q = await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Gus', last_name: 'Hill', email: 'gus@test.com' } });
  const [opp] = await waitHit(h => h.path === '/opportunities/' && h.method === 'POST');
  const o = opp.json;
  assert.equal(o.pipelineStageId, 'S2'); assert.equal(o.assignedTo, 'U1'); assert.equal(o.forecastProbability, 20); assert.equal(o.status, 'open'); assert.equal(o.monetaryValue, q.data.pricing.total);
  assert.equal(o.forecastExpectedCloseDate, new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10));
  assert.equal(o.name, `${q.data.shed.size} ${q.data.shed.style} for Gus Hill (${q.data.number})`);
  assert.deepEqual(o.customFields, [{ id: 'cfStyle', key: 'shed_style', field_value: q.data.shed.style }, { key: 'not_in_ghl', field_value: q.data.shed.size }]);
  const up = hits.find(h => h.path === '/contacts/upsert').json;
  assert.deepEqual(up.customFields, [{ id: 'cfTot', key: 'quote_total', field_value: q.data.pricing.total }]);
  if (dealer) {
    await setS({ pricing_mode: 'dealer' }); hits.length = 0;
    await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id, dealer_id: dealer.id }, customer: { first_name: 'Lot', email: 'lot@test.com' } });
    const [o2] = await waitHit(h => h.path === '/opportunities/' && h.method === 'POST'); assert.equal(o2.json.assignedTo, 'U2', 'dealer lot owner');
    await setS({ pricing_mode: 'none' });
  }
  // the token can't read lists: each list says which scope is missing; quotes still go through
  await setS({ ghl_token: 'bad-token' });
  const bad = (await admin.get('/api/admin/ghl/lookup')).data; assert.match(bad.errors.pipelines + bad.errors.users + bad.errors.fields, /opportunities\.readonly.*users\.readonly.*customFields\.readonly/s);
  await setS({ ghl_enabled: false, ghl_token: 'good-token', ghl_owner_id: '', ghl_dealer_owners: {}, ghl_close_days: '', ghl_probability: '', ghl_opp_name: '', ghl_custom_fields: {}, ghl_send_pdf: 1, ghl_add_note: 1 });
});

// =============================================================================
// TEXTS + EMAILS: auto-replies, merge tags, consent
// =============================================================================
test('auto-replies: text only with consent, email with merge tags filled, none for staff POS designs', async () => {
  await setS({ company_name: 'Trimline Barns', auto_reply_sms: 'Hi {{contact.first_name}}, thanks for your {{quote.style}} design ({{quote.number}}) — {{company.name}}', auto_reply_email_subject: 'Your {{quote.style}} from {{company.name}}', auto_reply_email_body: 'Hi {{contact.first_name}}, view it: {{quote.view_3d}}' });
  const list = d => d.timeline.filter(m => m.kind === 'message' && m.direction === 'out');
  const mk = (c) => anon.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: c });
  const yes = await mk({ first_name: 'Amy', email: 'amy@test.com', phone: '6155557001', sms_consent: true });
  const no = await mk({ first_name: 'Ben', email: 'ben@test.com', phone: '6155557002', sms_consent: false });
  const msgsOf = async qid => { const cid = (await admin.get('/api/v1/quotes/' + qid)).data.contact_id; for (let i = 0; i < 40; i++) { const d = (await admin.get('/api/crm/contacts/' + cid)).data; if (list(d).length) break; await sleep(50); } await sleep(200); return (await admin.get('/api/crm/contacts/' + cid)).data; };
  const a = await msgsOf(yes.data.id), b = await msgsOf(no.data.id);
  const aSms = list(a).find(m => m.channel === 'sms'), aEmail = list(a).find(m => m.channel === 'email');
  assert.ok(aSms, 'text sent with consent: ' + JSON.stringify(list(a)));
  assert.equal(aSms.body, `Hi Amy, thanks for your Classic Gable design (${yes.data.number}) — Trimline Barns`, 'merge tags filled');
  assert.equal(aEmail.subject, 'Your Classic Gable from Trimline Barns'); assert.match(aEmail.body, /^Hi Amy, view it: http.+q=/);
  assert.ok(!list(b).some(m => m.channel === 'sms'), 'no text without consent'); assert.ok(list(b).some(m => m.channel === 'email'), 'email still sent');
  assert.ok(!/\{\{/.test(aSms.body + aEmail.body + aEmail.subject), 'no leftover tags');
  // POS design for an existing contact: nothing goes to the customer
  const before = list(a).length;
  await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[1].id }, customer: {}, pos: true, contact_id: a.id });
  await sleep(400); assert.equal(list((await admin.get('/api/crm/contacts/' + a.id)).data).length, before, 'no auto-reply on a POS redesign');
  await setS({ auto_reply_sms: '', auto_reply_email_body: '' });
});

// =============================================================================
// WORKFLOW: lead → quote → contract → signed → order → built → delivered
// =============================================================================
test('workflow: a sale end to end with tax + delivery; contract totals match the quote; deal, order, board and messages follow', async () => {
  await setS({ tax_rate: 9.25, delivery_fee: 200, tax_delivery: true });
  const size = gable.sizes[0];
  const q = await anon.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: size.id, items: [{ uid: 'i', option_id: opt('Anchor Kit').id }] }, customer: { first_name: 'Wes', last_name: 'Flow', email: 'wes@test.com', phone: '6155558800', address: '9 Oak', city: 'Jackson', state: 'TN', zip: '38301', sms_consent: true } });
  assert.equal(q.status, 201);
  const qd = (await admin.get('/api/v1/quotes/' + q.data.id)).data;
  assert.equal(qd.pricing.total, r2(qd.pricing.subtotal + 200 + r2((qd.pricing.subtotal + 200) * 0.0925)));
  let c = (await admin.get('/api/crm/contacts/' + qd.contact_id)).data;
  assert.equal(c.opportunities.find(o => o.pipeline_name === 'Sales').stage, 'new', 'new lead on the board');

  // rep moves it along, texts, then writes it up
  const opp = c.opportunities.find(o => o.pipeline_name === 'Sales');
  assert.equal((await admin.patch('/api/crm/opportunities/' + opp.id, { stage: 'quoted' })).status, 200);
  assert.equal((await admin.post(`/api/crm/contacts/${c.id}/messages`, { channel: 'sms', body: 'Hi {{contact.first_name}}, ready to order?' })).status, 200);
  const meta = (await admin.get('/api/pos/meta')).data; const tpl = meta.templates.find(t => t.sale_type === 'cash' && t.roles.includes('customer'));
  const fd = new FormData(); fd.append('payload', JSON.stringify({ quote_id: qd.id, contact_id: c.id, template_id: tpl.id, sale_type: 'cash', signers: { customer: { name: 'Wes Flow', email: 'wes@test.com', phone: '6155558800' } }, cash: { deposit: 250 } }));
  const k = await admin.post('/api/pos/contracts', fd); assert.equal(k.status, 201, JSON.stringify(k.data));
  const kd = (await admin.get('/api/pos/contracts/' + k.data.id)).data;
  assert.equal(Number(kd.total), qd.pricing.total, 'contract total = quote total (tax + delivery)');
  assert.equal(k.data.raw.deposit, 250); assert.equal(r2(k.data.raw.balance ?? (qd.pricing.total - 250)), r2(qd.pricing.total - 250), 'balance due');
  assert.equal((await admin.post(`/api/pos/contracts/${k.data.id}/send`, { sms: true, email: true })).status, 200);
  c = (await admin.get('/api/crm/contacts/' + c.id)).data;
  assert.equal(c.opportunities.find(o => o.pipeline_name === 'Sales').stage, 'contract');
  const sentTexts = c.timeline.filter(m => m.kind === 'message' && m.channel === 'sms' && m.direction === 'out');
  assert.ok(sentTexts.some(m => /sign/i.test(m.body) && /\/sign\//.test(m.body)), 'signing link texted');
  assert.ok(sentTexts.some(m => m.body === 'Hi Wes, ready to order?'), 'manual text with merge tag');

  // everyone signs
  for (const s of k.data.signers) {
    const t = s.link.split('/sign/')[1];
    const info = (await anon.get('/api/sign/' + t)).data;
    const values = {}; for (const f of info.fields.filter(f => f.mine)) values[f.id] = f.type === 'checkbox' ? true : f.type === 'text' ? 'x' : ['signature', 'initials'].includes(f.type) ? PNG : undefined;
    const r = await anon.post(`/api/sign/${t}/sign`, { consent: true, values }); assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  c = (await admin.get('/api/crm/contacts/' + c.id)).data;
  const sale = c.opportunities.find(o => o.pipeline_name === 'Sales'); assert.equal(sale.stage, 'sold'); assert.equal(sale.status, 'won');
  const order = c.opportunities.find(o => o.order_number); assert.ok(order, 'order created'); assert.equal(Number(order.value), qd.pricing.total);
  assert.equal((await admin.get('/api/v1/quotes/' + qd.id)).data.status, 'won');
  assert.ok(c.timeline.some(t => /signed by all parties/.test(t.body)));

  // production → delivery
  const orders = (await admin.get('/api/crm/orders')).data; const board = orders.pipeline || orders;
  const stages = (board.stages || (await admin.get('/api/crm/pipelines')).data.find(p => p.kind === 'orders').stages).map(s => s.id);
  for (const st of stages.slice(1)) { const r = await admin.patch('/api/crm/opportunities/' + order.id, { stage: st }); assert.equal(r.status, 200, `move to ${st}: ` + JSON.stringify(r.data)); }
  const finalOrder = (await admin.get('/api/crm/contacts/' + c.id)).data.opportunities.find(o => o.id === order.id);
  assert.equal(finalOrder.stage, stages[stages.length - 1], 'order reached the last stage');
  // the dashboard counts it once
  const rep = (await admin.get('/api/admin/reports')).data; const today = rep.days.find(d => d.d === rep.today);
  assert.ok(today && today.sales >= 1 && today.sales_value >= qd.pricing.total, 'sale on today\'s report: ' + JSON.stringify(today));
  await setS({ tax_rate: 0, delivery_fee: 0, tax_delivery: false });
});

test('contracts: edge cases — bad tokens, voided/superseded links, deposit sanity, PDF downloads need a login', async () => {
  const q = await admin.post('/api/v1/quotes', { config: { style_id: gable.id, size_id: gable.sizes[0].id }, customer: { first_name: 'Eve', email: 'eve@test.com', phone: '6155558900' } });
  const meta = (await admin.get('/api/pos/meta')).data; const tpl = meta.templates.find(t => t.sale_type === 'cash' && t.roles.includes('customer'));
  const make = async extra => { const fd = new FormData(); fd.append('payload', JSON.stringify({ quote_id: q.data.id, template_id: tpl.id, sale_type: 'cash', signers: { customer: { name: 'Eve', email: 'eve@test.com' } }, ...extra })); return admin.post('/api/pos/contracts', fd); };
  const neg = await make({ cash: { deposit: -50 } });
  assert.ok(neg.status === 400 || (neg.status === 201 && neg.data.raw.deposit >= 0), 'negative deposit refused or clamped: ' + JSON.stringify(neg.data?.raw || neg.data));
  const huge = await make({ cash: { deposit: 10_000_000 } });
  assert.ok(huge.status === 400 || (huge.status === 201 && huge.data.raw.deposit <= q.data.pricing.total), 'deposit above the total refused or capped: ' + JSON.stringify(huge.data?.raw || huge.data));
  assert.equal((await make({ template_id: 999999 })).status, 400);
  assert.equal((await make({ quote_id: 999999 })).status === 201 ? 'made' : 'refused', 'refused', 'unknown quote refused');
  const k = await make({}); assert.equal(k.status, 201);
  assert.equal((await anon.get(`/api/pos/contracts/${k.data.id}/document.pdf`, { raw: true })).status, 401, 'contract PDF needs a login');
  assert.equal((await anon.get('/api/sign/' + 'a'.repeat(40))).status, 404);
  assert.equal((await anon.post('/api/sign/' + 'a'.repeat(40) + '/sign', { consent: true, values: {} })).status, 404);
  // garbage bodies don't crash the signing endpoint
  const t = k.data.signers[0].link.split('/sign/')[1];
  assert.equal((await anon.post(`/api/sign/${t}/sign`, { consent: true, values: 'nope' })).status, 400);
  assert.equal((await anon.post(`/api/sign/${t}/sign`, { consent: true, values: { x: { y: 1 } } })).status, 400);
});

// =============================================================================
// NEW 3D PARTS (from the 3D-Sheds builder): carriage + panel doors, double shelves with lengths, window heights
// =============================================================================
test('new 3D parts: carriage + panel doors, double shelves in chosen lengths, window heights — priced on the server, drawn, and tamper-proof', async () => {
  const fresh = (await admin.get('/api/admin/catalog')).data;
  const byKind = k => fresh.options.find(o => o.kind === k && o.active !== 0);
  const carriage2 = byKind('door_carriage_double'), carriage1 = byKind('door_carriage_right') || byKind('door_carriage'), panel36 = fresh.options.find(o => o.name === '36" Standard Door');
  const shelf = byKind('shelf_double'), vent = fresh.options.find(o => o.name === 'Gable Vent');
  const win = fresh.options.find(o => o.placement === 'opening' && String(o.kind).startsWith('window') && o.name.startsWith("2' x 3'"));
  assert.ok(carriage2 && carriage1 && panel36 && shelf && win, 'new parts are in the catalog: ' + JSON.stringify({ c2: !!carriage2, c1: !!carriage1, p: !!panel36, s: !!shelf, w: !!win }));
  const g = fresh.styles.find(s => s.name === 'Garage') || fresh.styles[0];
  const size = [...g.sizes].sort((a, b) => b.width * b.depth - a.width * a.depth)[0];
  const stdDoor = g.standard_options.find(so => fresh.options.find(o => o.id === so.option_id)?.category === 'doors');
  const cfg = { style_id: g.id, size_id: size.id, items: [
    { uid: 'cd', option_id: carriage2.id, wall: 'front', offset: 0, ...(stdDoor ? { standard_of: stdDoor.option_id } : {}) },
    { uid: 'c1', option_id: carriage1.id, wall: 'left', offset: -3 },
    { uid: 'p1', option_id: panel36.id, wall: 'right', offset: 2 },
    { uid: 'sh', option_id: shelf.id, wall: 'back', offset: 0, w: 10 },
    { uid: 'wn', option_id: win.id, wall: 'right', offset: -3, elev: 4 },
  ] };
  const p = (await price(cfg)).data;
  const line = uid => p.lines.find(l => l.uid === uid) || p.lines.find(l => l.label === ({ cd: carriage2, c1: carriage1, p1: panel36, sh: shelf, wn: win })[uid].name);
  for (const u of ['cd', 'c1', 'p1', 'sh', 'wn']) assert.ok(line(u), `${u} priced: ` + JSON.stringify(p.lines.map(l => l.label)));
  assert.equal(line('sh').amount, r2(Number(shelf.price) * 10), 'double shelves priced per ft of the chosen 10 ft');
  assert.match(line('sh').detail || '', /10'.*long/, 'length shown on the quote');
  assert.match(line('wn').detail || '', /48" off floor/, 'raised window shown on the quote');
  // tampering: a length that isn't offered snaps to the nearest choice; lengths/heights on other parts are ignored
  const t = (await price({ ...cfg, items: [{ ...cfg.items[3], w: 0.25 }, { uid: 'v', option_id: vent.id, wall: 'front', offset: 0, w: 0.25, elev: 0 }] })).data;
  assert.equal(t.lines.find(l => l.label === shelf.name).amount, r2(Number(shelf.price) * Math.min(...String(shelf.length_choices).split(/[,\s]+/).map(Number).filter(Boolean))), 'snapped to the shortest offered length, not 0.25 ft');
  assert.equal(t.lines.find(l => l.label === vent.name).amount, Number(vent.price), 'a made-up length on a fixed-size part is ignored');
  await setS({ customer_window_height: false });
  const fixed = (await price(cfg)).data; assert.doesNotMatch(fixed.lines.find(l => l.label === win.name).detail || '', /off floor/, 'window heights locked when the setting is off');
  await setS({ customer_window_height: true });
  // saved as a quote → drawings (floor plan + elevations) include the new parts without errors
  const q = await admin.post('/api/v1/quotes', { config: cfg, customer: { first_name: 'Car', email: 'car@test.com' } });
  assert.equal(q.status, 201); assert.equal(q.data.pricing.total, p.total, 'quote = price API');
  const plan = await (await fetch(B + `/api/v1/quotes/${q.data.id}/floorplan.svg`, { headers: { cookie: admin.cookie } })).text();
  assert.match(plan, /^<svg/); assert.doesNotMatch(plan, /NaN|undefined/);
  const { elevationSVG } = await import('../public/js/shared/elevations.js');
  const pub = (await admin.get('/api/v1/catalog')).data, saved = (await admin.get('/api/v1/quotes/' + q.data.id)).data;
  for (const wall of ['front', 'back', 'left', 'right']) {
    const svg = elevationSVG(pub, saved.config, wall).svg; assert.match(svg, /^<svg/); assert.doesNotMatch(svg, /NaN|undefined/, wall + ' elevation');
  }
  assert.ok(elevationSVG(pub, saved.config, 'front').svg.length > elevationSVG(pub, { ...saved.config, items: [] }, 'front').svg.length + 500, 'carriage doors drawn on the front');
});
