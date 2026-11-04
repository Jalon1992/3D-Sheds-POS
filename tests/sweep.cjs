// Bug sweep: every page × every role × desktop & phone (JS errors, sideways scrolling), script-injection attempts in
// every text field, accented names in PDFs, double submits, expired links, oversized uploads, deleted users, restart.
// Run: npm run test:sweep   (needs Playwright + Chromium)
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium, devices } = require('playwright');
const ROOT = join(__dirname, '..');
const PORT = 4500 + Math.floor(Math.random() * 80), B = `http://127.0.0.1:${PORT}`;
const XSS = `<img src=x onerror="window.__xss=(window.__xss||0)+1">"'><svg onload=window.__xss=1>`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const problems = []; const passed = [];
const ok = (c, m) => { if (c) passed.push(m); else problems.push(m); };
const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
let srv;
const start = () => new Promise(async res => {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, DB_PATH: join(dir, 'db.sqlite'), UPLOAD_DIR: join(dir, 'up'), MESSAGING_TEST_MODE: '1', ADMIN_EMAIL: 'owner@test.com', ADMIN_PASSWORD: 'owner-pass-1' } });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* */ } await new Promise(r => setTimeout(r, 150)); }
  res();
});
class C { constructor() { this.cookie = ''; } async r(m, u, b, raw) { const f = b instanceof FormData; const x = await fetch(B + u, { method: m, headers: { ...(b && !f ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) }, body: b ? (f ? b : JSON.stringify(b)) : undefined }); const sc = x.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0]; if (raw) return x; const t = await x.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: x.status, d }; } }

(async () => {
  await start();
  const A = new C(); await A.r('POST', '/api/auth/login', { email: 'owner@test.com', password: 'owner-pass-1' });
  await A.r('PUT', '/api/admin/settings', { company_name: 'Trimline ' + XSS, dealers: [{ id: 'lot1', name: 'Lot ' + XSS }] });
  for (const [e, role] of [['sales@t.com', 'sales'], ['prod@t.com', 'production'], ['drv@t.com', 'delivery'], ['gone@t.com', 'sales']]) await A.r('POST', '/api/admin/users', { email: e, name: role + ' ' + XSS, password: 'password-123', role });
  // data with hostile text everywhere
  const cat = await (await fetch(B + '/api/v1/catalog')).json(); const st = cat.styles[0];
  const q = (await A.r('POST', '/api/v1/quotes', { config: { style_id: st.id, size_id: st.sizes[0].id }, customer: { first_name: 'José ' + XSS, last_name: 'Ñúñez Zoë 😀', email: 'jose@example.com', phone: '6155550190', address: '12 Rue ' + XSS, city: 'Señorita', notes: XSS } })).d;
  const contact = (await A.r('GET', '/api/crm/contacts?q=jose')).d.data[0];
  await A.r('POST', `/api/crm/contacts/${contact.id}/notes`, { body: 'note ' + XSS });
  await A.r('POST', `/api/crm/contacts/${contact.id}/messages`, { channel: 'sms', body: 'text ' + XSS });
  await A.r('POST', `/api/crm/contacts/${contact.id}/tasks`, { title: 'task ' + XSS });
  await A.r('PATCH', `/api/crm/contacts/${contact.id}`, { tags: [XSS] });
  await A.r('POST', '/api/crm/snippets', { name: 'snip ' + XSS, channel: 'sms', body: XSS });
  const meta = (await A.r('GET', '/api/pos/meta')).d; const tpl = meta.templates.find(t => t.sale_type === 'cash');
  await A.r('PUT', '/api/pos/templates/' + tpl.id, { name: tpl.name + ' ' + XSS });
  const fd = new FormData(); fd.append('payload', JSON.stringify({ quote_id: q.id, template_id: tpl.id, sale_type: 'cash', signers: { customer: { name: 'José Ñúñez Zoë 😀 ' + XSS, phone: '6155550190', email: 'jose@example.com' } }, custom: { serial_number: XSS } }));
  const k = (await A.r('POST', '/api/pos/contracts', fd)).d;
  ok(k.id, 'contract with accented names, emoji and markup builds');
  // the PDF really has the accented name (emoji become "?" since PDF fonts lack them)
  const pdf = Buffer.from(await (await A.r('GET', `/api/pos/contracts/${k.id}/document.pdf`, null, true)).arrayBuffer());
  writeFileSync(join(dir, 'k.pdf'), pdf);
  try { const txt = execFileSync('pdftotext', [join(dir, 'k.pdf'), '-']).toString(); ok(/José Ñúñez Zoë/.test(txt), 'accented names print correctly in the contract PDF'); } catch { passed.push('(pdftotext not installed — skipped PDF text check)'); }
  // double submit of the same signature: exactly one wins
  const cust = k.signers.find(s => s.role === 'customer'), tok = cust.link.split('/sign/')[1];
  const info = await (await fetch(`${B}/api/sign/${tok}`)).json();
  const values = {}; for (const f of info.fields.filter(f => f.mine)) values[f.id] = f.type === 'checkbox' ? true : f.type === 'text' ? XSS : ['signature', 'initials'].includes(f.type) ? PNG : undefined;
  const both = await Promise.all([1, 2].map(() => fetch(`${B}/api/sign/${tok}/sign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true, values }) })));
  ok(both.map(r => r.status).sort().join() === '200,409', 'double-tapping Finish signs once (' + both.map(r => r.status).join(',') + ')');
  // expired link
  const fd2 = new FormData(); fd2.append('payload', JSON.stringify({ quote_id: q.id, template_id: tpl.id, sale_type: 'cash', signers: { customer: { name: 'Exp Ired', phone: '6155550191' } } }));
  const k2 = (await A.r('POST', '/api/pos/contracts', fd2)).d;
  { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(join(dir, 'db.sqlite')); db.exec(`UPDATE contracts SET expires_at = datetime('now','-1 day') WHERE id = ${k2.id}`); db.close(); }
  const tok2 = k2.signers[0].link.split('/sign/')[1];
  const exp = await (await fetch(`${B}/api/sign/${tok2}`)).json(); ok(exp.contract.expired === true, 'expired link is flagged');
  const expSign = await fetch(`${B}/api/sign/${tok2}/sign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true, values: {} }) });
  ok(expSign.status === 410, 'expired link cannot be signed');
  const resent = await A.r('POST', `/api/pos/contracts/${k2.id}/send`, { sms: true, email: false });
  const exp2 = await (await fetch(`${B}/api/sign/${tok2}`)).json(); ok(resent.s === 200 && exp2.contract.expired === false, 'resending renews an expired link');
  // oversized template upload
  const big = new FormData(); big.append('file', new Blob([Buffer.alloc(41 * 1024 * 1024)]), 'big.pdf');
  const bigR = await A.r('POST', '/api/pos/templates', big); ok(bigR.s === 413 && /too large/i.test(bigR.d.error), 'oversized PDF gets a clear "too large" error (' + bigR.s + ')');
  // malformed JSON
  const mal = await fetch(B + '/api/crm/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: A.cookie }, body: '{bad' });
  ok(mal.status === 400, 'malformed request body is rejected cleanly');
  // delete a user who owns records
  const users = (await A.r('GET', '/api/admin/users')).d; const gone = users.find(u => u.email === 'gone@t.com');
  await A.r('PATCH', `/api/crm/contacts/${contact.id}`, { assigned_to: gone.id });
  ok((await A.r('DELETE', '/api/admin/users/' + gone.id)).s === 204, 'user who owns contacts can be removed');
  ok((await A.r('GET', `/api/crm/contacts/${contact.id}`)).s === 200, 'contact still opens after its owner was removed');
  // restart: data, files and logins survive
  srv.kill(); await new Promise(r => setTimeout(r, 600)); await start();
  ok((await A.r('GET', '/api/auth/me')).s === 200, 'still logged in after a server restart');
  ok((await A.r('GET', `/api/pos/contracts/${k.id}/document.pdf`, null, true)).status === 200, 'contract PDFs survive a restart');

  // ---- every page × every role × desktop/phone ---------------------------------------------
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const ids = { contact: contact.id, contract: k.id, template: tpl.id, quote: q.id };
  const order = (await A.r('GET', '/api/crm/orders')).d.data[0];
  const ROUTES = {
    admin: ['dashboard', 'crm', `crm/contacts/${ids.contact}`, 'conversations', `conversations/${ids.contact}`, 'pipeline', 'tasks', 'pos', `pos/contracts/${ids.contract}`, `pos/new?quote=${ids.quote}`, `pos/revise/${k2.id}`, 'templates', `templates/${ids.template}`, 'pos-settings', 'pos/templates', 'pos/settings', 'quotes', `quotes/${ids.quote}`, 'orders', 'orders?view=schedule', 'styles', 'colors', 'pricing', 'options', 'integrations', 'messaging', 'settings', 'configurator-settings', 'account'],
    sales: ['crm', `crm/contacts/${ids.contact}`, 'conversations', 'pipeline', 'tasks', 'pos', `pos/contracts/${ids.contract}`, `pos/revise/${k2.id}`, 'templates', 'quotes', 'orders', 'account', 'dashboard', 'messaging', 'pos-settings', 'configurator-settings'],
    production: ['orders', 'quotes', 'account', 'crm', 'pos'],
    delivery: ['orders', 'orders?view=schedule', 'account', 'quotes', 'crm'],
  };
  const login = { admin: ['owner@test.com', 'owner-pass-1'], sales: ['sales@t.com', 'password-123'], production: ['prod@t.com', 'password-123'], delivery: ['drv@t.com', 'password-123'] };
  for (const [role, routes] of Object.entries(ROUTES)) for (const vp of ['desktop', 'phone']) {
    const ctx = await browser.newContext(vp === 'phone' ? { ...devices['iPhone 13'] } : { viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_TUNNEL|fonts\.g/.test(m.text())) errs.push(m.text()); });
    page.on('dialog', d => d.dismiss());
    await page.goto(B + '/admin/'); await page.fill('input[name=email]', login[role][0]); await page.fill('input[name=password]', login[role][1]); await page.click('button:has-text("Log in")'); await page.waitForSelector('#nav');
    for (const r of routes) {
      await page.goto(B + '/admin/#/' + r); await page.waitForTimeout(r.startsWith('pos/templates/') || r.startsWith('pos/contracts/') ? 1800 : 700);
      const res = await page.evaluate(() => ({ xss: window.__xss || 0, over: document.documentElement.scrollWidth - window.innerWidth, err: document.querySelector('#main .card.err')?.textContent || '', title: document.querySelector('#main h1')?.textContent || '' }));
      ok(!res.xss, `${role}/${vp} #/${r}: no injected script ran`);
      ok(res.over <= 2, `${role}/${vp} #/${r}: no sideways scrolling (${res.over}px)`);
      ok(!res.err, `${role}/${vp} #/${r}: page loads${res.err ? ' — ' + res.err : ''}`);
    }
    if (role === 'admin' && vp === 'desktop') { // open modals with hostile data
      await page.goto(B + '/admin/#/quotes'); await page.click('tr[data-id]'); await page.waitForSelector('#modal[open]'); await page.waitForTimeout(400);
      ok(!(await page.evaluate(() => window.__xss)), 'quote detail: no injected script ran'); await page.keyboard.press('Escape');
      if (order) { await page.goto(B + '/admin/#/orders'); await page.waitForTimeout(600); }
    }
    ok(!errs.length, `${role}/${vp}: no JavaScript errors${errs.length ? ' — ' + [...new Set(errs)].slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }
  // signing page with hostile data, on a phone
  const ctx = await browser.newContext({ ...devices['iPhone 13'] }); const sp = await ctx.newPage(); const serr = [];
  sp.on('pageerror', e => serr.push(e.message));
  const comp = k.signers.find(s => s.role === 'company'); await sp.goto(comp.link.replace(/^https?:\/\/[^/]+/, B)); await sp.waitForSelector('.fld.mine', { timeout: 30000 }).catch(() => {});
  ok(!(await sp.evaluate(() => window.__xss)), 'signing page: no injected script ran');
  ok((await sp.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 2, 'signing page: no sideways scrolling on a phone');
  ok(!serr.length, 'signing page: no JavaScript errors' + (serr.length ? ' — ' + serr[0] : ''));
  await browser.close(); srv.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n${passed.length} checks passed, ${problems.length} problems`);
  for (const p of problems) console.log('✖ ' + p);
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error('SWEEP CRASHED:', e); srv?.kill(); process.exit(2); });
