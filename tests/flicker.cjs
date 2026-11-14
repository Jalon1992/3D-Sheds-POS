// Flicker test (z-fighting): every style, from six sides and four corner close-ups. Each view is rendered four
// times with tiny camera moves; pixels that jump to another colour and back are suspects. Each suspect is then
// checked in the 3D scene: it counts as z-fighting only when two front-facing, parallel surfaces lie within 1/8"
// of each other there (an edge stepping against the sky or a glint is not z-fighting). Fails when any view has more than
// a few z-fighting pixels.
// Run: npm run test:flicker   (slow: a few minutes per style in software rendering)
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('playwright');
const ROOT = join(__dirname, '..');
const PORT = 4600 + Math.floor(Math.random() * 80), B = `http://127.0.0.1:${PORT}`;
const LIMIT = Number(process.env.FLICKER_LIMIT) || 3;    // z-fighting pixels allowed per view
const dir = mkdtempSync(join(tmpdir(), 'flicker-'));

(async () => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, DB_PATH: join(dir, 'db.sqlite'), UPLOAD_DIR: join(dir, 'up'), BACKUP_DISABLED: '1' } });
  let failed = 0;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 150)); }
    const cat = await (await fetch(B + '/api/v1/catalog')).json();
    const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
    const page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(B + '/?debug=1');
    await page.waitForFunction(() => window.__shed && document.querySelector('#loading')?.classList.contains('gone'), null, { timeout: 240000 });
    await page.addStyleTag({ content: '.view-tabs,.viewbar,.vp-tools,#selbar,.hint{display:none!important}' });
    const views = [];
    for (let a = 0; a < 6; a++) views.push({ a: a * Math.PI / 3 + 0.3, el: 0.25, r: 1 });
    for (let a = 0; a < 4; a++) views.push({ a: a * Math.PI / 2 + Math.PI / 4, el: 0.12, r: 0.55, corner: true });
    // close-ups of the front door (where people zoom in): straight on and from either side, near and middle distance
    for (const R of [7, 13]) for (const a of [-0.6, 0, 0.6]) views.push({ door: true, a, R });
    if (process.env.FLICKER_VIEWS === 'door') views.splice(0, 10);
    for (const st of cat.styles.filter(s => !process.env.FLICKER_STYLE || s.name === process.env.FLICKER_STYLE)) {
      // FLICKER_TRIM_FRAME=1: every door drawn with its frame boards in the trim color
      if (process.env.FLICKER_TRIM_FRAME) await page.evaluate(() => window.__shed.state.catalog.options.forEach(o => { if (String(o.kind).startsWith('door')) o.trim_frame = 1; }));
      await page.evaluate(id => document.querySelector(`[data-style="${id}"]`).click(), st.id); await page.waitForTimeout(1200);
      let worst = { n: 0 };
      for (const [vi, v] of views.entries()) {
        const frames = [];
        for (let k = 0; k < 4; k++) {
          await page.evaluate(({ v, k }) => {
            const s = window.__shed.scene, g = s.geo, R = Math.max(g.W, g.D) * 1.9 * v.r + 6, ty = (g.floorY || 0.75) + g.H * 0.5;
            if (v.door) {   // front wall faces +z
              const fy = (g.floorY || 0.75) + 3.4;
              s.controls.target.set(0, fy, g.D / 2);
              s.camera.position.set(Math.sin(v.a) * v.R + k * 0.011, fy + 0.6 + k * 0.007, g.D / 2 + Math.cos(v.a) * v.R - k * 0.009);
              s.controls.update(); return;
            }
            const cx = v.corner ? Math.sign(Math.cos(v.a)) * g.W / 2 : 0, cz = v.corner ? Math.sign(Math.sin(v.a)) * g.D / 2 : 0, y = v.corner ? 1.2 : ty;
            s.controls.target.set(cx * 0.9, y, cz * 0.9);
            s.camera.position.set(cx + Math.cos(v.a) * R + k * 0.011, y + Math.sin(v.el) * R + k * 0.007, cz + Math.sin(v.a) * R - k * 0.009);
            s.controls.update();
          }, { v, k });
          await page.waitForTimeout(220);
          // read the pixels back from the WebGL canvas (summed RGB per pixel)
          frames.push(await page.evaluate(() => {
            const c = document.querySelector('#viewport canvas'), w = c.width, h = c.height;
            const t = document.createElement('canvas'); t.width = w; t.height = h; const g = t.getContext('2d'); g.drawImage(c, 0, 0);
            const d = g.getImageData(0, 0, w, h).data, out = new Array(w * h);
            for (let i = 0; i < w * h; i++) out[i] = d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2];
            return out;
          }));
        }
        const W = await page.evaluate(() => document.querySelector('#viewport canvas').width), suspects = [];
        for (let i = 0; i < frames[0].length; i++) {
          const d1 = frames[1][i] - frames[0][i], d2 = frames[2][i] - frames[1][i], d3 = frames[3][i] - frames[2][i];
          if ((d1 * d2 < 0 && Math.abs(d1) > 120 && Math.abs(d2) > 120) || (d2 * d3 < 0 && Math.abs(d2) > 120 && Math.abs(d3) > 120)) suspects.push([i % W, Math.floor(i / W)]);
        }
        // in the scene: two front-facing surfaces within 1/8" of each other under the pixel = z-fighting
        const n = await page.evaluate(async pts => {
          const THREE = await import('three'); const s = window.__shed.scene, el = s.renderer.domElement, rc = new THREE.Raycaster(); let n = 0; const what = {};
          const label = h => { const m = Array.isArray(h.object.material) ? h.object.material[h.face.materialIndex] : h.object.material; const nm = Object.entries(s.M || {}).find(([, v]) => v === m)?.[0] || m.type; const p = h.object.geometry.parameters || {}; return nm + ' ' + h.object.geometry.type.replace('Geometry', '') + (p.width ? `(${[p.width, p.height, p.depth].map(v => +(+v).toFixed(3)).join('x')})` : ''); };
          const nm = new THREE.Vector3();
          for (const [x, y] of pts.slice(0, 600)) {
            rc.setFromCamera(new THREE.Vector2((x + 0.5) / el.width * 2 - 1, -((y + 0.5) / el.height) * 2 + 1), s.camera);
            const front = rc.intersectObjects(s.root.children, true).filter(h => {
              if (!h.object.visible || !h.face) return false;
              const m = Array.isArray(h.object.material) ? h.object.material[h.face.materialIndex] : h.object.material;
              nm.copy(h.face.normal).transformDirection(h.object.matrixWorld);
              return m.side === THREE.DoubleSide || nm.dot(rc.ray.direction) < 0;
            });
            if (front.length < 2) continue;
            nm.copy(front[0].face.normal).transformDirection(front[0].object.matrixWorld);
            const n2 = front[1].face.normal.clone().transformDirection(front[1].object.matrixWorld);
            const gap = (front[1].distance - front[0].distance) * Math.abs(nm.dot(rc.ray.direction));
            if (gap < 0.0104 && Math.abs(nm.dot(n2)) > 0.9) { n++; const k = label(front[0]) + '  vs  ' + label(front[1]) + `  (${(gap * 12).toFixed(3)}" apart)`; what[k] = (what[k] || 0) + 1; }   // parallel surfaces within 1/8"
          }
          return { n, what };
        }, suspects);
        const { n: zn, what } = n; if (zn > worst.n) worst = { n: zn, vi, corner: !!v.corner, door: !!v.door, what };
        if (zn > LIMIT) writeFileSync(join(dir, `${st.name.replace(/\W+/g, '-')}-view${vi}.png`), await page.locator('#viewport').screenshot());
      }
      const ok = worst.n <= LIMIT;
      if (!ok) failed++;
      console.log(`${ok ? '✔' : '✘'} ${st.name}: worst view ${worst.n} flickering pixels${worst.n ? ` (view ${worst.vi}${worst.corner ? ', corner' : worst.door ? ', door close-up' : ''})` : ''}`);
      if (!ok) for (const [k, c] of Object.entries(worst.what).sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`    ${c} px: ${k}`);
    }
    if (errs.length) { failed++; console.log('✘ page errors: ' + errs.slice(0, 3).join(' | ')); }
    await browser.close();
  } finally { srv.kill(); }
  console.log(failed ? `\n${failed} problem(s). Screenshots: ${dir}` : '\nNo flicker.');
  if (!failed) rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
