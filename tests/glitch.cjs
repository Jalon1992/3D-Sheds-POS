// Glitch test (npm run test:glitch): every style x every size, every option on every style, random builds (add / move / resize),
// checking for page errors, the 3D scene throwing, the builder's price disagreeing with the server, and drawings with NaN.
const { spawn } = require('node:child_process'); const { chromium } = require('playwright'); const { join } = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs'); const { tmpdir } = require('node:os');
const ROOT = join(__dirname, '..'), S = mkdtempSync(join(tmpdir(), 'glitch-')), PORT = 4700 + Math.floor(Math.random() * 80), B = 'http://127.0.0.1:' + PORT;
(async () => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, DB_PATH: join(S, 'db.sqlite'), BACKUP_DISABLED: '1' } });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/favicon|404|ERR_TUNNEL|ERR_NAME|ERR_INTERNET|fonts\./.test(m.text())) errs.push('console: ' + m.text()); });
  await p.goto(B + '/?debug=1'); await p.waitForFunction(() => window.__shed && document.querySelector('#loading')?.classList.contains('gone'), null, { timeout: 240000 });
  const r = await p.evaluate(async () => {
    const H = window.__shed, st = H.state, out = { checks: 0, problems: [], skipped: 0 };
    const elev = await import('/js/shared/elevations.js'), plan = await import('/js/shared/floorplan.js');
    const serverPrice = async () => (await (await fetch('/api/v1/price', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(st.config) })).json());
    const check = async label => {
      out.checks++;
      const c = H.pricing(), s = await serverPrice();
      if (!c) out.problems.push(label + ': builder could not price');
      else if (s.total !== c.total) out.problems.push(`${label}: builder $${c.total} vs server $${s.total}`);
      for (const w of ['front', 'back', 'left', 'right']) { try { const svg = elev.elevationSVG(st.catalog, st.config, w).svg; if (/NaN|undefined/.test(svg)) out.problems.push(`${label}: ${w} drawing has NaN/undefined`); } catch (e) { out.problems.push(`${label}: ${w} drawing threw ${e.message}`); } }
      try { const fp = (plan.floorPlanSVG || plan.default)?.(st.catalog, st.config); if (typeof fp === 'string' && /NaN|undefined/.test(fp)) out.problems.push(label + ': floor plan NaN'); } catch (e) { out.problems.push(label + ': floor plan threw ' + e.message); }
    };
    const pickStyle = id => document.querySelector(`[data-style="${id}"]`).click();
    const pickSize = id => { const el = document.querySelector(`[data-size="${id}"]`); if (el) el.click(); else st.config.size_id = id; };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    for (const style of st.catalog.styles) {
      pickStyle(style.id); await wait(250);
      for (const z of style.sizes) { pickSize(z.id); await wait(120); await check(`${style.name} ${z.width}x${z.depth}`); }
      pickSize(style.sizes[Math.floor(style.sizes.length / 2)].id); await wait(150);
      for (const o of st.catalog.options.filter(o => o.active !== 0)) {
        const before = st.config.items.length;
        try { H.addOption(o); } catch (e) { out.skipped++; continue; }
        await wait(60);
        if (st.config.items.length > before || o.placement === 'none') await check(`${style.name} + ${o.name}`);
        const added = st.config.items.filter(i => i.option_id === o.id && !i.standard_of && !i.package_of);
        for (const it of added) try { H.removeItem(it.uid); } catch {}
      }
      // random builds: add 6 random options, move a few, change size, check
      for (let round = 0; round < 3; round++) {
        const opts = st.catalog.options.filter(o => o.active !== 0 && o.placement !== 'none');
        for (let k = 0; k < 6; k++) { try { H.addOption(opts[Math.floor(Math.random() * opts.length)]); } catch {} }
        for (const it of st.config.items.slice(-3)) { try { H.moveToWall(it.uid, ['front', 'back', 'left', 'right'][Math.floor(Math.random() * 4)]); } catch {} }
        pickSize(style.sizes[Math.floor(Math.random() * style.sizes.length)].id); await wait(200);
        await check(`${style.name} random build ${round}`);
      }
    }
    return out;
  });
  console.log(`checks ${r.checks}, options not offered/no room ${r.skipped}, problems ${r.problems.length}`); r.problems.slice(0, 30).forEach(x => console.log('  ' + x));
  console.log('page errors', errs.length); errs.slice(0, 10).forEach(x => console.log('  ' + x));
  await b.close(); srv.kill(); rmSync(S, { recursive: true, force: true });
  const bad = r.problems.length + errs.length;
  console.log(bad ? `\n✘ ${bad} problem(s)` : '\n✔ no glitches'); process.exit(bad ? 1 : 0);
})();
