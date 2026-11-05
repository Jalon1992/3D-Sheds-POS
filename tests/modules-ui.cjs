// Browser checks for add-on modules: a configurator-only admin sees no CRM / Point of sale / order menus,
// the dashboard drops sales + lead figures, the developer's Modules page switches modules and every open
// admin page picks the change up live. Run: npm run test:browser
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('playwright');

const ROOT = join(__dirname, '..');
const PORT = 4900 + Math.floor(Math.random() * 80), B = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_OUT || mkdtempSync(join(tmpdir(), 'modules-shots-'));
const results = [], errors = [];
const step = async (name, fn) => { const t = Date.now(); try { await fn(); results.push(['✔', name, Date.now() - t]); } catch (e) { results.push(['✖', name, Date.now() - t, e.message.split('\n')[0]]); throw e; } };
const assert = (c, m) => { if (!c) throw new Error('Assertion failed: ' + m); };
const watch = (page, who) => {
  page.on('pageerror', e => errors.push(`${who}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_NAME|fonts\.g|Failed to load resource/.test(m.text())) errors.push(`${who}: ${m.text()}`); });
};

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modui-'));
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT, DB_PATH: join(dir, 'db.sqlite'), UPLOAD_DIR: join(dir, 'up'), MESSAGING_TEST_MODE: '1', ADMIN_EMAIL: 'owner@test.com', ADMIN_PASSWORD: 'owner-pass-1', MODULES: 'none', DEVOPS_EMAIL: 'dev@builder.test', DEVOPS_PASSWORD: 'dev-secret-123' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* */ } await new Promise(r => setTimeout(r, 200)); }
  const browser = await chromium.launch();
  let exit = 0;
  const login = async (email, pw, who) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }); const p = await ctx.newPage(); watch(p, who);
    await p.goto(B + '/admin/'); await p.fill('input[name=email]', email); await p.fill('input[name=password]', pw); await p.click('button:has-text("Log in")'); await p.waitForSelector('#nav'); return p;
  };
  const navItems = p => p.$$eval('#nav a', as => as.filter(a => !a.hidden).map(a => a.dataset.r));
  try {
    // a little history so the dashboard has numbers
    const ownerApi = async (p, m, u, b) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, [m, u, b]);
    const owner = await login('owner@test.com', 'owner-pass-1', 'owner');
    const cat = (await ownerApi(owner, 'GET', '/api/v1/catalog')).data;
    for (let i = 0; i < 3; i++) await ownerApi(owner, 'POST', '/api/v1/quotes', { config: { style_id: cat.styles[0].id, size_id: cat.styles[0].sizes[0].id }, customer: { first_name: 'Q' + i, email: `q${i}@test.com`, phone: '615555010' + i } });

    await step('configurator only: no CRM, Point of sale, order board, messaging or Modules menus for the owner', async () => {
      await owner.reload(); await owner.waitForSelector('#nav');
      const items = await navItems(owner);
      for (const gone of ['crm', 'conversations', 'pipeline', 'tasks', 'pos', 'templates', 'orders', 'messaging', 'pos-settings', 'modules']) assert(!items.includes(gone), gone + ' hidden: ' + items);
      for (const kept of ['dashboard', 'quotes', 'styles', 'colors', 'pricing', 'options', 'configurator-settings', 'settings', 'integrations', 'account']) assert(items.includes(kept), kept + ' shown');
      const heads = await owner.$$eval('#nav .nav-h', hs => hs.filter(h => !h.hidden).map(h => h.textContent));
      assert(!heads.some(h => /CRM|Point of sale|Operations/.test(h)) && heads.includes('Sales'), 'empty section headings hidden, "Sales & CRM" becomes "Sales": ' + heads);
      // typing an address of a missing module lands on the dashboard
      for (const h of ['#/crm', '#/pos/new', '#/orders', '#/templates', '#/messaging', '#/modules']) { await owner.goto(B + '/admin/' + h); await owner.waitForSelector('#main h1'); assert(await owner.innerText('#main h1') === 'Dashboard', h + ' → dashboard'); }
    });

    await step('configurator-only dashboard: quotes reports only, no sales or lead figures, no setup step for texting', async () => {
      await owner.goto(B + '/admin/#/dashboard'); await owner.waitForSelector('.kpis');
      const tiles = await owner.$$eval('.kpi .lbl', l => l.map(x => x.textContent));
      assert(tiles.join() === 'Quotes', 'only the quotes tile: ' + tiles);
      const metrics = await owner.$$eval('[data-metric]', b => b.map(x => x.dataset.metric)); assert(metrics.every(m => m.startsWith('quote')), 'metrics ' + metrics);
      const ths = await owner.$$eval('#reports th', t => t.map(x => x.textContent.trim())); assert(!ths.some(t => /^(Sales|Leads|Cash|RTO|Close rate)/.test(t)), 'columns ' + ths);
      assert(!/Sales mix|Where leads came from|Connect texting/.test(await owner.innerText('#main')), 'no sales / lead cards');
      await owner.screenshot({ path: join(OUT, 'm1-configurator-only-dashboard.png'), fullPage: true });
      await owner.goto(B + '/admin/#/account'); await owner.waitForSelector('#uf');
      const roles = await owner.$$eval('#uf [name=role] option', o => o.map(x => x.value)); assert(!roles.includes('production') && !roles.includes('delivery'), 'shop roles not offered: ' + roles);
      assert(!/dev@builder\.test/.test(await owner.innerText('#main')), 'developer login not listed');
      await owner.goto(B + '/admin/#/quotes'); await owner.waitForSelector('tr[data-id]'); await owner.click('tr[data-id]');
      await owner.waitForSelector('#modal[open]'); assert(!/Start contract|Open in CRM/.test(await owner.innerText('#modal')), 'no contract / CRM buttons on a quote');
    });

    const dev = await login('dev@builder.test', 'dev-secret-123', 'developer');
    await step('the developer sees the Modules page and turns on Point of sale; the owner\'s open page reloads with it', async () => {
      assert((await navItems(dev)).includes('modules'), 'Modules menu for the developer');
      await dev.goto(B + '/admin/#/modules'); await dev.waitForSelector('[data-mod=pos]', { state: 'attached' });
      await dev.screenshot({ path: join(OUT, 'm2-modules-page.png'), fullPage: true });
      await owner.goto(B + '/admin/#/dashboard'); await owner.waitForSelector('.kpis');
      const ownerReload = owner.waitForEvent('load', { timeout: 15000 });
      await dev.click('label.switch:has([data-mod=pos])');
      await ownerReload; await owner.waitForSelector('#nav');
      const items = await navItems(owner);
      assert(items.includes('pos') && items.includes('templates') && items.includes('pos-settings') && items.includes('messaging'), 'POS menus appear live: ' + items);
      assert(!items.includes('crm') && !items.includes('orders'), 'still no CRM / orders');
      assert(/Texts & email/.test(await owner.innerText('#nav')), 'messaging menu named for what it does without the CRM');
      await owner.goto(B + '/admin/#/messaging'); await owner.waitForSelector('#main h1', { timeout: 8000 }).catch(async () => { throw new Error('messaging page: ' + (await owner.innerText('#main')).slice(0, 300)); });
      const m = await owner.innerText('#main'); assert(!/Instant reply|Saved replies/.test(m) && /contract is fully signed/.test(m), 'messaging page without CRM-only parts');
      await owner.goto(B + '/admin/#/dashboard'); await owner.waitForSelector('.kpis');
      const tiles = await owner.$$eval('.kpi .lbl', l => l.map(x => x.textContent)); assert(tiles.includes('Sales') && !tiles.includes('Leads'), 'sales tiles back, leads still off: ' + tiles);
      await owner.goto(B + '/admin/#/pos/new'); await owner.waitForSelector('#wGo');
      await owner.screenshot({ path: join(OUT, 'm3-pos-without-crm.png'), fullPage: true });
    });

    await step('every page the owner can reach loads cleanly with Point of sale + Production & delivery, no CRM', async () => {
      await ownerApi(dev, 'PUT', '/api/admin/modules', { orders: true });
      await owner.waitForEvent('load', { timeout: 15000 }); await owner.waitForSelector('#nav');
      for (const r of await navItems(owner)) { await owner.goto(B + '/admin/#/' + r); await owner.waitForFunction(() => !document.querySelector('#main .empty')?.textContent?.startsWith('Loading'), null, { timeout: 15000 }); await owner.waitForTimeout(150); }
      const err = await owner.$('#main .card.err'); assert(!err, 'no page error card');
    });
  } catch (e) { exit = 1; console.error(e.message.split('\n').slice(0, 3).join('\n')); }
  finally {
    for (const [ok, name, ms, err] of results) console.log(`${ok} ${name} (${ms} ms)${err ? '\n    ' + err : ''}`);
    if (errors.length) { console.log('\nPage errors:\n  ' + [...new Set(errors)].join('\n  ')); exit = 1; }
    console.log('\nScreenshots: ' + OUT);
    await browser.close(); srv.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    process.exit(exit);
  }
})();
