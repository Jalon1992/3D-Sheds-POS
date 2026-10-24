// Browser end-to-end test: admin + sales + production + delivery logged in at the same time,
// a customer signing on a phone, live updates, the template designer and drag-and-drop boards.
// Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).
// Run: npm run test:e2e   (starts its own server on a temp database in messaging test mode)
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch { console.error('Playwright is not installed: npm i -D playwright && npx playwright install chromium'); process.exit(1); }

const ROOT = join(__dirname, '..');
const PORT = 4100 + Math.floor(Math.random() * 80), B = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_OUT || mkdtempSync(join(tmpdir(), 'e2e-shots-'));
const results = []; const errors = [];
const step = async (name, fn) => { const t = Date.now(); try { await fn(); results.push(['✔', name, Date.now() - t]); } catch (e) { results.push(['✖', name, Date.now() - t, e.message.split('\n')[0]]); throw e; } };
const assert = (c, m) => { if (!c) throw new Error('Assertion failed: ' + m); };
const watch = (page, who) => {
  page.on('pageerror', e => errors.push(`${who}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_NAME|fonts\.g|401 \(Unauthorized\)|Failed to load resource/.test(m.text())) errors.push(`${who}: ${m.text()}`); });
};

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT, DB_PATH: join(dir, 'db.sqlite'), UPLOAD_DIR: join(dir, 'up'), MESSAGING_TEST_MODE: '1', ADMIN_EMAIL: 'owner@test.com', ADMIN_PASSWORD: 'owner-pass-1' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* */ } await new Promise(r => setTimeout(r, 200)); }
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const ctxOf = (opts = {}) => browser.newContext({ viewport: { width: 1440, height: 950 }, ...opts });
  const login = async (ctx, email, pw, who) => {
    const p = await ctx.newPage(); watch(p, who);
    await p.goto(B + '/admin/'); await p.fill('input[name=email]', email); await p.fill('input[name=password]', pw);
    await p.click('button:has-text("Log in")'); await p.waitForSelector('#nav'); return p;
  };
  let exit = 0;
  try {
    const adminCtx = await ctxOf(); const admin = await login(adminCtx, 'owner@test.com', 'owner-pass-1', 'admin');
    await step('admin creates sales, production and delivery logins in the UI', async () => {
      await admin.goto(B + '/admin/#/account'); await admin.waitForSelector('#uf');
      for (const [name, email, role] of [['Sam Sales', 'sam@test.com', 'sales'], ['Pat Prod', 'pat@test.com', 'production'], ['Dee Driver', 'dee@test.com', 'delivery']]) {
        await admin.fill('#uf [name=name]', name); await admin.fill('#uf [name=email]', email); await admin.selectOption('#uf [name=role]', role); await admin.fill('#uf [name=password]', 'password-123');
        await admin.click('#uadd'); await admin.waitForFunction(e => document.body.innerText.includes(e), email);
      }
    });
    const salesCtx = await ctxOf(), prodCtx = await ctxOf(), drvCtx = await ctxOf();
    const sales = await login(salesCtx, 'sam@test.com', 'password-123', 'sales');
    const prod = await login(prodCtx, 'pat@test.com', 'password-123', 'production');
    const drv = await login(drvCtx, 'dee@test.com', 'password-123', 'delivery');

    await step('each role sees only its own menu', async () => {
      const nav = async p => p.$$eval('#nav a:not([hidden])', a => a.map(x => x.dataset.r));
      const s = await nav(sales), pr = await nav(prod), d = await nav(drv);
      assert(s.includes('crm') && s.includes('pos') && !s.includes('styles') && !s.includes('messaging'), 'sales nav ' + s);
      assert(pr.includes('orders') && !pr.includes('crm') && !pr.includes('pos'), 'production nav ' + pr);
      assert(d.join() === 'orders,account', 'delivery nav ' + d);
    });

    await step('customer builds a shed in the 3D configurator (page loads, 3D renders)', async () => {
      const ctx = await ctxOf(); const p = await ctx.newPage(); watch(p, 'configurator');
      await p.goto(B + '/'); await p.waitForSelector('canvas', { timeout: 20000 }); await p.waitForTimeout(1500);
      await p.screenshot({ path: join(OUT, '01-configurator.png') }); await ctx.close();
    });

    await step('new 3D lead shows up live for sales without refreshing', async () => {
      await sales.goto(B + '/admin/#/crm'); await sales.waitForSelector('#ctable');
      const cat = await (await fetch(B + '/api/v1/catalog')).json(); const st = cat.styles[1];
      const r = await fetch(B + '/api/v1/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { style_id: st.id, size_id: st.sizes[1].id }, customer: { first_name: 'Mark', last_name: 'Miller', email: 'mark@example.com', phone: '(615) 555-0177', address: '22 Oak Ln', city: 'Franklin', state: 'TN', zip: '37064', sms_consent: true } }) });
      assert(r.status === 201, 'quote ' + r.status);
      await sales.waitForSelector('tr[data-id]:has-text("Mark Miller")', { timeout: 8000 });
      await sales.waitForFunction(() => !document.querySelector('#bellCount').hidden, null, { timeout: 8000 });
    });

    await step('sales adds a walk-in lead, texts them, logs a note and a task', async () => {
      await sales.click('#cAdd'); await sales.fill('#lf [name=first_name]', 'Wanda'); await sales.fill('#lf [name=last_name]', 'Walker'); await sales.fill('#lf [name=phone]', '615-555-0144');
      await sales.selectOption('#lf [name=source]', 'Walk-in'); await sales.fill('#lf [name=opportunity_title]', '10x12 Garden Shed'); await sales.fill('#lf [name=value]', '4200');
      await sales.click('#lsave'); await sales.waitForSelector('#thread');
      await sales.fill('#mbody', 'Hi {{contact.first_name}}, great meeting you today!'); await sales.click('#msend');
      await sales.waitForSelector('.bub.out:has-text("Hi Wanda")');
      await sales.click('button[data-ch=note]'); await sales.fill('#mbody', 'Wants a ramp'); await sales.click('#msend'); await sales.waitForSelector('.evt.note:has-text("Wants a ramp")');
      await sales.fill('#tf [name=title]', 'Call back Friday'); await sales.click('#tf button'); await sales.waitForSelector('.task-row:has-text("Call back Friday")');
      await sales.screenshot({ path: join(OUT, '02-contact.png') });
    });

    await step('customer texts back → appears live in Conversations', async () => {
      await sales.goto(B + '/admin/#/conversations'); await sales.waitForSelector('#ilist .inbox-item');
      await sales.click('#ilist .inbox-item:has-text("Wanda")'); await sales.waitForSelector('#thread');
      await fetch(B + '/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: (await adminCtx.cookies()).map(c => `${c.name}=${c.value}`).join('; ') }, body: JSON.stringify({ twilio_skip_signature: true }) });
      await fetch(B + '/api/hooks/twilio/sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: '+16155550144', To: '+16155559999', Body: 'Does it come with a ramp?', MessageSid: 'SMx' }) });
      await sales.waitForSelector('.bub.in:has-text("ramp?")', { timeout: 8000 });
    });

    await step('pipeline: drag a deal to "Contacted"', async () => {
      await sales.goto(B + '/admin/#/pipeline'); await sales.waitForSelector('.kcard');
      const card = sales.locator('.kcard:has-text("Wanda")'); const col = sales.locator('.kcol[data-stage=contacted] .kcol-body');
      await card.dragTo(col); await sales.waitForSelector('.kcol[data-stage=contacted] .kcard:has-text("Wanda")', { timeout: 5000 });
    });

    await step('admin uploads a contract template and places fields in the designer', async () => {
      const { PDFDocument, StandardFonts } = await import('pdf-lib');
      const pdf = await PDFDocument.create(); const f = await pdf.embedFont(StandardFonts.Helvetica);
      const pg = pdf.addPage([612, 792]); pg.drawText('MY CASH SALE CONTRACT', { x: 60, y: 720, size: 18, font: f }); pg.drawText('Buyer signature: ____________________', { x: 60, y: 200, size: 12, font: f });
      const file = join(dir, 'My Cash Contract.pdf'); writeFileSync(file, await pdf.save());
      await admin.goto(B + '/admin/#/pos/templates'); await admin.click('#tUp');
      await admin.fill('#uf [name=name]', 'My Cash Contract'); await admin.setInputFiles('#uf [name=file]', file); await admin.click('#ugo');
      await admin.waitForSelector('.dz-layer', { timeout: 20000 }); await admin.waitForTimeout(500);
      const layer = admin.locator('.dz-layer').first(); const bb = await layer.boundingBox();
      await admin.click('[data-tool=signature]'); await admin.mouse.click(bb.x + bb.width * 0.45, bb.y + bb.height * 0.73);
      await admin.click('[data-tool=data]'); await admin.mouse.click(bb.x + bb.width * 0.3, bb.y + bb.height * 0.15);
      await admin.selectOption('[data-k=tag]', 'customer.full_name');
      await admin.click('[data-tool=date_signed]'); await admin.mouse.click(bb.x + bb.width * 0.75, bb.y + bb.height * 0.73);
      // drag the date box a little
      const box = admin.locator('.dz-f.sel'); const b2 = await box.boundingBox();
      await admin.mouse.move(b2.x + 5, b2.y + 5); await admin.mouse.down(); await admin.mouse.move(b2.x + 40, b2.y + 25, { steps: 5 }); await admin.mouse.up();
      await admin.click('#dSave'); await admin.waitForFunction(() => document.querySelector('#dState').textContent === '');
      await admin.screenshot({ path: join(OUT, '03-designer.png') });
      const id = await admin.evaluate(() => location.hash.split('/').pop());
      const t = await admin.evaluate(async id => (await fetch('/api/pos/templates/' + id)).json(), id);
      assert(t.fields.length === 3 && t.fields.some(x => x.type === 'signature' && x.role === 'customer'), 'fields saved ' + JSON.stringify(t.fields.map(x => x.type)));
    });

    let contractId;
    await step('sales writes up a Rent-to-Own contract from the 3D design (drawings rendered in the browser)', async () => {
      await sales.goto(B + '/admin/#/crm'); await sales.click('tr[data-id]:has-text("Mark Miller")'); await sales.waitForSelector('#thread');
      await sales.click('a:has-text("New contract")'); await sales.waitForSelector('#wGo');
      await sales.click('label:has-text("Rent to own")'); await sales.selectOption('#rTerm', '48');
      await sales.click('#cobOn'); await sales.fill('#cName', 'Mary Miller'); await sales.fill('#cEmail', 'mary@example.com');
      await sales.screenshot({ path: join(OUT, '04-wizard.png'), fullPage: true });
      await sales.click('#wGo'); await sales.waitForFunction(() => /#\/pos\/contracts\/\d+/.test(location.hash), null, { timeout: 90000 });
      contractId = await sales.evaluate(() => Number(location.hash.match(/contracts\/(\d+)/)[1]));
      await sales.waitForSelector('#kPdf canvas', { timeout: 30000 });
      const k = await sales.evaluate(async id => (await fetch('/api/pos/contracts/' + id)).json(), contractId);
      assert(k.pages.length === 6, 'contract pages ' + k.pages.length); assert(k.signers.length === 3, 'signers'); assert(k.summary.rto.term_months === '48', 'term');
    });

    let links;
    await step('sales sends signing links by text + email', async () => {
      await sales.click('#sendAll'); await sales.waitForSelector('.pill.sent, .signer-row', { timeout: 8000 });
      await sales.waitForFunction(() => document.body.innerText.includes('Signing link texted') || document.body.innerText.includes('Signing link emailed'), null, { timeout: 8000 });
      links = await sales.$$eval('[data-copy]', els => els.map(e => e.dataset.copy));
      await sales.screenshot({ path: join(OUT, '05-contract.png') });
    });

    const signOn = async (p, typed) => {
      await p.waitForSelector('.fld.mine', { timeout: 30000 }); await p.waitForTimeout(800);
      for (let i = 0; i < 40 && !(await p.isVisible('#finish')); i++) {
        await p.click('#next'); await p.waitForTimeout(600);
        if (await p.isVisible('.modal input.typed') && !(await p.isVisible('[data-mode]'))) { await p.fill('.modal input.typed', 'Back gate'); await p.click('.modal [data-ok]'); await p.waitForTimeout(300); continue; }
        if (await p.isVisible('.modal')) {
          if (typed) { await p.click('[data-mode=type]'); }
          else { const c = await (await p.$('.modal canvas')).boundingBox(); await p.mouse.move(c.x + 20, c.y + c.height * 0.6); await p.mouse.down(); for (let k = 0; k < 14; k++) await p.mouse.move(c.x + 30 + k * 16, c.y + c.height * (0.45 + 0.2 * Math.sin(k))); await p.mouse.up(); }
          await p.click('.modal [data-ok]'); await p.waitForTimeout(400); continue;
        }
        const cb = await p.$('.fld.mine[data-c]:not(.done)'); if (cb) await cb.click();
      }
      await p.check('#consent'); await p.click('#finish'); await p.waitForSelector('h1:has-text("Signed")', { timeout: 20000 });
    };
    await step('customer signs on an iPhone (draws signature + initials on every drawing sheet)', async () => {
      const ctx = await browser.newContext({ ...devices['iPhone 13'] }); const p = await ctx.newPage(); watch(p, 'customer phone');
      await p.goto(links[0]); await signOn(p, false); await p.screenshot({ path: join(OUT, '06-customer-signed.png') }); await ctx.close();
    });
    await step('co-buyer signs on an Android phone (typed signature)', async () => {
      const ctx = await browser.newContext({ ...devices['Pixel 7'] }); const p = await ctx.newPage(); watch(p, 'cobuyer phone');
      await p.goto(links[1]); await signOn(p, true); await ctx.close();
    });
    await step('rep signs for the company on the lot tablet → contract completes, owner alerted live', async () => {
      await admin.goto(B + '/admin/#/dashboard');
      await sales.reload(); await sales.waitForSelector('[data-inperson]');
      const [p] = await Promise.all([salesCtx.waitForEvent('page'), sales.click('button:has-text("Sign as company")')]); watch(p, 'company');
      await signOn(p, true);
      await sales.waitForFunction(() => document.body.innerText.includes('Signed by everyone'), null, { timeout: 15000 });
      await admin.waitForSelector('.toast:has-text("Contract signed")', { timeout: 10000 });
      const pdf = await sales.evaluate(async id => { const b = await (await fetch(`/api/pos/contracts/${id}/document.pdf`)).arrayBuffer(); return Array.from(new Uint8Array(b)); }, contractId);
      writeFileSync(join(OUT, 'signed-contract.pdf'), Buffer.from(pdf));
      const { PDFDocument } = await import('pdf-lib'); const doc = await PDFDocument.load(Buffer.from(pdf));
      assert(doc.getPageCount() >= 7, 'signed pdf pages ' + doc.getPageCount()); // 6 contract+drawing pages + certificate (1–2 pages)
      await sales.screenshot({ path: join(OUT, '07-signed.png') });
    });

    await step('production sees the new order live and moves it through the shop', async () => {
      await prod.goto(B + '/admin/#/orders'); await prod.waitForSelector('.kcard:has-text("Mark Miller")', { timeout: 8000 });
      await prod.locator('.kcard:has-text("Mark Miller")').dragTo(prod.locator('.kcol[data-stage=in_production] .kcol-body'));
      await prod.waitForSelector('.kcol[data-stage=in_production] .kcard:has-text("Mark Miller")');
      await prod.locator('.kcol[data-stage=in_production] .kcard select').selectOption('built');
      await prod.waitForSelector('.kcol[data-stage=built] .kcard:has-text("Mark Miller")');
      await prod.screenshot({ path: join(OUT, '08-production.png') });
    });

    await step('delivery schedules it, texts the customer and marks it delivered', async () => {
      await drv.goto(B + '/admin/#/orders?view=schedule'); await drv.waitForSelector('tr[data-id]:has-text("Mark Miller")', { timeout: 8000 });
      await drv.click('tr[data-id]:has-text("Mark Miller")'); await drv.waitForSelector('#of');
      await drv.selectOption('#of [name=stage]', 'scheduled'); await drv.fill('#of [name=delivery_date]', '2026-11-05'); await drv.fill('#of [name=delivery_window]', '8–10 AM');
      await drv.click('#of button[type=submit]'); await drv.waitForSelector('td:has-text("2026-11-05")');
      await drv.click('tr[data-id]:has-text("Mark Miller")'); await drv.click('[data-quick]:has-text("On the way")'); await drv.click('#oSend');
      await drv.waitForSelector('.toast:has-text("Text sent")');
      await drv.selectOption('#of [name=stage]', 'delivered'); await drv.click('#of button[type=submit]');
      await drv.waitForSelector('td .pill:has-text("Delivered")');
      await drv.screenshot({ path: join(OUT, '09-delivery.png') });
    });

    await step('phone-size admin works for a rep on the lot', async () => {
      const ctx = await browser.newContext({ ...devices['iPhone 13'] }); const p = await ctx.newPage(); watch(p, 'mobile admin');
      await p.goto(B + '/admin/'); await p.fill('input[name=email]', 'sam@test.com'); await p.fill('input[name=password]', 'password-123'); await p.click('button:has-text("Log in")');
      await p.waitForSelector('#ctable tr[data-id]'); await p.click('tr[data-id]:has-text("Mark Miller")'); await p.waitForSelector('#thread');
      await p.screenshot({ path: join(OUT, '10-mobile-contact.png'), fullPage: false });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert(overflow <= 2, 'horizontal overflow ' + overflow);
      await ctx.close();
    });

    assert(!errors.length, 'browser errors:\n' + errors.join('\n'));
  } catch (e) { exit = 1; console.error(e.message); }
  finally {
    for (const [ok, name, ms, err] of results) console.log(`${ok} ${name} (${ms} ms)${err ? '\n    ' + err : ''}`);
    if (errors.length) console.log('Browser errors:\n  ' + errors.join('\n  '));
    console.log(`\nScreenshots + signed PDF: ${OUT}`);
    await browser.close(); srv.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    process.exit(exit);
  }
})();
