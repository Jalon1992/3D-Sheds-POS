// Browser checks for the 3D configurator: uploaded .glb models really render, a broken model falls back
// to the built-in shape, the price the customer sees matches the server to the cent, and configurator
// settings (hide prices, currency, required phone) show up on the page. Settings pages don't wipe each other.
// Run: npm run test:browser
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('playwright');

const ROOT = join(__dirname, '..');
const PORT = 4400 + Math.floor(Math.random() * 80), B = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_OUT || mkdtempSync(join(tmpdir(), 'browser-shots-'));
const results = [], errors = [];
const step = async (name, fn) => { const t = Date.now(); try { await fn(); results.push(['✔', name, Date.now() - t]); } catch (e) { results.push(['✖', name, Date.now() - t, e.message.split('\n')[0]]); throw e; } };
const assert = (c, m) => { if (!c) throw new Error('Assertion failed: ' + m); };
const watch = (page, who) => {
  page.on('pageerror', e => errors.push(`${who}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_NAME|fonts\.g|Failed to load resource/.test(m.text())) errors.push(`${who}: ${m.text()}`); });
};
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

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brw-'));
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT, DB_PATH: join(dir, 'db.sqlite'), UPLOAD_DIR: join(dir, 'up'), MESSAGING_TEST_MODE: '1', ADMIN_EMAIL: 'owner@test.com', ADMIN_PASSWORD: 'owner-pass-1' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* */ } await new Promise(r => setTimeout(r, 200)); }
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  let exit = 0;
  try {
    const actx = await browser.newContext({ viewport: { width: 1440, height: 950 } }); const admin = await actx.newPage(); watch(admin, 'admin');
    await admin.goto(B + '/admin/'); await admin.fill('input[name=email]', 'owner@test.com'); await admin.fill('input[name=password]', 'owner-pass-1'); await admin.click('button:has-text("Log in")'); await admin.waitForSelector('#nav');
    const api = (m, u, b) => admin.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, [m, u, b]);
    const cat = (await api('GET', '/api/admin/catalog')).data;
    const flower = cat.options.find(o => o.name === 'Flower Box'), cupola = cat.options.find(o => o.name === 'Cupola');
    const glb = join(dir, 'flower-box.glb'); writeFileSync(glb, makeGLB());
    const fake = join(dir, 'broken.glb'); writeFileSync(fake, 'not a model at all');

    await step('admin uploads a .glb on the Options page; a broken file is refused with a clear message', async () => {
      await admin.goto(B + '/admin/#/options'); await admin.waitForSelector(`input[data-glb="${flower.id}"]`, { state: 'attached' });
      await admin.setInputFiles(`input[data-glb="${flower.id}"]`, fake);
      await admin.waitForFunction(() => /valid 3D model/.test(document.body.innerText), null, { timeout: 8000 });
      await admin.setInputFiles(`input[data-glb="${flower.id}"]`, glb);
      await admin.waitForFunction(() => /3D model updated/.test(document.body.innerText), null, { timeout: 8000 });
      const o = (await api('GET', '/api/v1/options/' + flower.id)).data; assert(/\.glb$/.test(o.model_url || ''), 'model saved on the option');
      await api('PATCH', '/api/v1/options/' + cupola.id, { model_url: '/uploads/missing-model.glb' });
    });

    const cctx = await browser.newContext({ viewport: { width: 1440, height: 950 } }); const cust = await cctx.newPage(); watch(cust, 'customer');
    const warns = []; cust.on('console', m => { if (m.type() === 'warning') warns.push(m.text()); });
    const openBuilder = async (page, q = '') => { await page.goto(B + '/?debug=1' + q); await page.waitForFunction(() => window.__shed && document.querySelector('#loading')?.classList.contains('gone'), null, { timeout: 90000 }); };

    await step('customer adds the option: the uploaded model is drawn in 3D (not the built-in box)', async () => {
      await openBuilder(cust);
      // Classic Gable allows both options; pick it explicitly
      await cust.evaluate(() => { const s = window.__shed.state; const st = s.catalog.styles.find(x => x.name === 'Classic Gable'); s.config.style_id = st.id; s.config.size_id = st.sizes[0].id; });
      await cust.evaluate(id => { const { optById, addOption } = window.__shed; addOption(optById[id]); }, flower.id);
      const ok = await cust.waitForFunction(id => {
        const { scene, state } = window.__shed; const it = state.config.items.find(i => i.option_id === id); if (!it) return false;
        const holder = scene.items.get(it.uid); let tri = false;
        holder?.traverse(m => { if (m.isMesh && m.geometry?.attributes?.position?.count === 3) tri = true; });
        return tri;
      }, flower.id, { timeout: 15000 }).then(() => true).catch(() => false);
      assert(ok, 'the GLB triangle mesh is in the scene');
      await cust.screenshot({ path: join(OUT, 'b1-glb-model.png') });
    });

    await step('a model file that is missing falls back to the built-in shape, nothing breaks', async () => {
      await cust.evaluate(id => { const { optById, addOption } = window.__shed; addOption(optById[id]); }, cupola.id);
      await cust.waitForTimeout(1500);
      const r = await cust.evaluate(id => { const { scene, state } = window.__shed; const it = state.config.items.find(i => i.option_id === id); const h = it && scene.items.get(it.uid); let meshes = 0; h?.traverse(m => { if (m.isMesh) meshes++; }); return { placed: !!it, meshes }; }, cupola.id);
      assert(r.placed && r.meshes > 0, 'cupola still drawn: ' + JSON.stringify(r));
      assert(warns.some(w => /Model failed to load/.test(w)), 'failure logged as a warning, not an error');
    });

    await step('new 3D parts draw in 3D: carriage + panel doors, double shelves at a picked length, a window raised; price = server', async () => {
      await openBuilder(cust);
      const r = await cust.evaluate(async () => {
        const { state, optById, addOption, setLength, setElev, scene, pricing } = window.__shed;
        const st = state.catalog.styles.find(x => x.name === 'Garage') || state.catalog.styles[0];
        const z = [...st.sizes].sort((a, b) => b.width * b.depth - a.width * a.depth)[0];
        state.config.style_id = st.id; state.config.size_id = z.id; state.config.items = [];
        const byKind = k => Object.values(optById).find(o => o.kind === k);
        const want = ['door_carriage_double', 'door_carriage_right', 'door_panel', 'shelf_double'].map(byKind).filter(Boolean);
        for (const o of want) addOption(o);
        const shelf = state.config.items.find(i => optById[i.option_id].kind === 'shelf_double'); if (shelf) setLength(shelf.uid, 8);
        const win = Object.values(optById).find(o => o.placement === 'opening' && String(o.kind).startsWith('window')); addOption(win);
        const wi = state.config.items.find(i => i.option_id === win.id); setElev(wi.uid, 1); setElev(wi.uid, 1);
        await new Promise(res => setTimeout(res, 800));
        const drawn = state.config.items.map(i => { let m = 0; scene.items.get(i.uid)?.traverse(x => { if (x.isMesh) m++; }); return [optById[i.option_id].kind, m]; });
        const server = await (await fetch('/api/v1/price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.config) })).json();
        return { kinds: want.map(o => o.kind), drawn, shelfW: shelf?.w, winElev: wi.elev, client: Math.round(pricing().total * 100), server: Math.round(server.total * 100) };
      });
      assert(r.kinds.length === 4, 'new parts in the catalog: ' + r.kinds);
      assert(r.drawn.every(([, m]) => m > 0), 'every part has a 3D model: ' + JSON.stringify(r.drawn));
      assert(r.shelfW === 8, 'shelf length picked: ' + r.shelfW);
      assert(r.winElev > 0, 'window raised: ' + r.winElev);
      assert(r.client === r.server, `price matches the server (${r.client} vs ${r.server})`);
      await cust.screenshot({ path: join(OUT, 'b0-new-3d-parts.png') });
    });

    await step('the price the customer sees matches the server, across every style and several options', async () => {
      const res = await cust.evaluate(async () => {
        const { state, optById, addOption, pricing } = window.__shed; const out = [];
        const fmtNum = n => Math.round(n * 100) / 100;
        for (const st of state.catalog.styles) for (const z of st.sizes.slice(0, 2)) {
          state.config.style_id = st.id; state.config.size_id = z.id; state.config.items = []; state.config.roof_material = st.roof_material;
          for (const o of Object.values(optById).filter(o => o.placement === 'none' || o.name.includes('Window') || o.name.includes('Shelf')).slice(0, 5)) try { addOption(o); } catch { /* not offered */ }
          const client = pricing();
          const server = await (await fetch('/api/v1/price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.config) })).json();
          out.push({ style: st.name, size: z.width + 'x' + z.depth, client: fmtNum(client.total), server: fmtNum(server.total), cl: client.lines.length, sl: server.lines.length });
        }
        return out;
      });
      const bad = res.filter(r => r.client !== r.server);
      assert(res.length >= 4 && !bad.length, 'mismatch: ' + JSON.stringify(bad.length ? bad : res));
    });

    await step('configurator settings show on the page: hidden prices, currency symbol, required phone', async () => {
      await api('PUT', '/api/admin/settings', { show_prices: false, require_phone: true });
      await openBuilder(cust);
      assert(await cust.textContent('#totalLabel') === 'Price on request', 'price on request: ' + await cust.textContent('#totalLabel'));
      assert(!/\$\d/.test(await cust.innerText('#panel')), 'no prices in the option list');
      // the dealer configurator (signed-in admin) still shows prices
      const dealer = await actx.newPage(); watch(dealer, 'dealer');
      await dealer.goto(B + '/?debug=1'); await dealer.waitForFunction(() => window.__shed && document.querySelector('#loading')?.classList.contains('gone'), null, { timeout: 90000 });
      assert(/\$/.test(await dealer.innerText('#total')), 'dealer sees the price'); await dealer.close();
      await api('PUT', '/api/admin/settings', { show_prices: true, currency_symbol: 'CA$' });
      await openBuilder(cust);
      assert((await cust.innerText('#total')).startsWith('CA$'), 'currency symbol: ' + await cust.innerText('#total'));
      // quote step: phone marked required and enforced
      await cust.evaluate(() => window.__shed.go(window.__shed.state.maxStep = 3));
      await cust.waitForSelector('#qform');
      assert(/Phone \*/.test(await cust.innerText('#qform')), 'phone marked required');
      await cust.fill('#qform [name=first_name]', 'Nia'); await cust.fill('#qform [name=email]', 'nia@test.com');
      await cust.click('#next'); await cust.waitForSelector('#qerr:not([hidden])');
      await cust.fill('#qform [name=phone]', '615-555-0144'); await cust.click('#next');
      await cust.waitForSelector('.done', { timeout: 15000 });
      await cust.screenshot({ path: join(OUT, 'b2-quote-sent.png') });
      await api('PUT', '/api/admin/settings', { currency_symbol: '$', require_phone: false });
    });

    await step('saving one settings page never wipes another (Company vs Configurator vs Point of sale)', async () => {
      await api('PUT', '/api/admin/settings', { tax_rate: 6.5, delivery_fee: 125, rto: { company: 'Keep Me RTO', terms: [{ months: 36, factor: 1.6 }] } });
      await admin.goto(B + '/admin/#/settings'); await admin.waitForSelector('#setf');
      await admin.fill('#setf [name=company_name]', 'Trimline Barns'); await admin.click('#ssave'); await admin.waitForFunction(() => /Saved/.test(document.body.innerText));
      await admin.goto(B + '/admin/#/configurator-settings'); await admin.waitForSelector('#setf');
      assert(await admin.inputValue('#setf [name=tax_rate]') === '6.5', 'tax kept');
      await admin.fill('#setf [name=delivery_fee]', '175'); await admin.click('#ssave'); await admin.waitForFunction(() => /Saved/.test(document.body.innerText));
      const s = (await api('GET', '/api/admin/settings')).data;
      assert(s.company_name === 'Trimline Barns' && Number(s.tax_rate) === 6.5 && Number(s.delivery_fee) === 175 && s.rto?.company === 'Keep Me RTO', 'all kept: ' + JSON.stringify({ c: s.company_name, t: s.tax_rate, d: s.delivery_fee, r: s.rto?.company }));
      assert(await admin.innerText('#sideName') === 'Trimline Barns', 'sidebar name updated');
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
