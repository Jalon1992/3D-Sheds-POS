// Shimmer test (npm run test:shimmer): every style from 7 angles, each rendered 4 times with tiny camera moves.
// Counts pixels that flip back and forth (flicker, shimmer, sparkle of any kind) and lists the parts under them, worst
// first, so new flicker is easy to trace. Fails when a style shimmers clearly more than the budget below (today's
// level plus 25%), so a change that brings flicker back is caught.
const { spawn } = require('node:child_process'); const { chromium } = require('playwright'); const { join } = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs'); const { tmpdir } = require('node:os');
const S = mkdtempSync(join(tmpdir(), 'shimmer-')), only = process.env.SHIMMER_STYLE, PORT = 4800 + Math.floor(Math.random() * 80), B = 'http://127.0.0.1:' + PORT;
const BUDGET = { 'Classic Gable': 324, 'Lofted Barn': 293, 'Modern Lean-To': 967, 'Garage': 408, 'Chicken Coop': 908 };
(async () => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: join(__dirname, '..'), stdio: 'ignore', env: { ...process.env, PORT, DB_PATH: join(S, 'db.sqlite'), BACKUP_DISABLED: '1' } });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
  const cat = await (await fetch(B + '/api/v1/catalog')).json();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 900, height: 700 } })).newPage();
  await p.goto(B + '/?debug=1'); await p.waitForFunction(() => window.__shed && document.querySelector('#loading')?.classList.contains('gone'), null, { timeout: 240000 });
  await p.addStyleTag({ content: '.view-tabs,.viewbar,.vp-tools,#selbar,.hint{display:none!important}' });
  const tally = {}; let total = 0, failed = 0;
  for (const st of cat.styles.filter(s => !only || s.name === only)) {
    await p.evaluate(id => document.querySelector(`[data-style="${id}"]`).click(), st.id); await p.waitForTimeout(1500);
    const views = [[0.6, 0.3, 1], [2.2, 0.2, 1], [3.8, 0.35, 0.8], [5.2, 0.15, 0.8], [0.15, 0.12, 0.5], [1.7, 0.1, 0.45], [4.4, 0.25, 0.5]];
    let stTot = 0;
    for (const [a, el, r] of views) {
      const frames = [];
      for (let k = 0; k < 4; k++) {
        await p.evaluate(({ a, el, r, k }) => { const s = window.__shed.scene, g = s.geo, R = (Math.max(g.W, g.D) * 1.9 + 6) * r, ty = (g.floorY || 0.75) + g.H * 0.5;
          s.controls.target.set(0, ty, 0); s.camera.position.set(Math.cos(a) * R + k * 0.011, ty + Math.sin(el) * R + k * 0.007, Math.sin(a) * R - k * 0.009); s.controls.update(); }, { a, el, r, k });
        await p.waitForTimeout(240);
        frames.push(await p.evaluate(() => { const c = document.querySelector('#viewport canvas'), w = c.width, h = c.height; const t = document.createElement('canvas'); t.width = w; t.height = h; const g = t.getContext('2d'); g.drawImage(c, 0, 0); const d = g.getImageData(0, 0, w, h).data, o = new Array(w * h); for (let i = 0; i < w * h; i++) o[i] = d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]; return o; }));
      }
      const W = await p.evaluate(() => document.querySelector('#viewport canvas').width), mk = [];
      for (let i = 0; i < frames[0].length; i++) { const d1 = frames[1][i] - frames[0][i], d2 = frames[2][i] - frames[1][i], d3 = frames[3][i] - frames[2][i]; if ((d1 * d2 < 0 && Math.abs(d1) > 60 && Math.abs(d2) > 60) || (d2 * d3 < 0 && Math.abs(d2) > 60 && Math.abs(d3) > 60)) mk.push(i); }
      stTot += mk.length;
      const info = await p.evaluate(async ({ mk, W, style }) => { const THREE = await import('three'); const s = window.__shed.scene, el = s.renderer.domElement, rc = new THREE.Raycaster(), out = {};
        const nm = m => Object.entries(s.M || {}).find(([, v]) => v === m)?.[0] || m.type.replace('Mesh', '').replace('Material', '') + '#' + m.color?.getHexString();
        const lab = h => { const m = [].concat(h.object.material)[h.face?.materialIndex || 0] || [].concat(h.object.material)[0]; const p = h.object.geometry.parameters || {}; return nm(m) + ' ' + h.object.geometry.type.replace('Geometry', '') + (p.width ? '(' + [p.width, p.height, p.depth].map(v => +(+v).toFixed(2)).join('x') + ')' : ''); };
        for (const i of mk) { const x = i % W, y = Math.floor(i / W); rc.setFromCamera(new THREE.Vector2((x + 0.5) / el.width * 2 - 1, -((y + 0.5) / el.height) * 2 + 1), s.camera);
          const hs = rc.intersectObjects(s.root.children, true); const k = style + ': ' + (hs.length ? hs.slice(0, 2).map(lab).join(' | ') + (hs[1] ? ` (${(hs[1].distance - hs[0].distance).toFixed(2)} ft)` : '') : 'sky/ground edge'); out[k] = (out[k] || 0) + 1; }
        return out; }, { mk, W, style: st.name });
      for (const [k, c] of Object.entries(info)) tally[k.replace(/\(\d\.\d\d ft\)/, m => '(' + (Math.round(parseFloat(m.slice(1)) * 10) / 10) + ' ft)')] = (tally[k] || 0) + c;
    }
    total += stTot; const cap = BUDGET[st.name] ? Math.round(BUDGET[st.name] * 1.25) : null, ok = !cap || stTot <= cap; if (!ok) failed++;
    console.log(`${ok ? '✔' : '✘'} ${st.name}: ${stTot} shimmering pixels over ${views.length} views${cap ? ` (budget ${cap})` : ''}`);
  }
  console.log('\nTop sources:'); Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, c]) => console.log(String(c).padStart(5), k));
  await b.close(); srv.kill(); rmSync(S, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
