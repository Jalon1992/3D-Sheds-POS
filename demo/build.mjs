// Builds the static demo: the 3D builder (index) and the admin (admin.html) sharing an in-browser backend.
// Usage: npm run build:demo  →  demo/dist/
// To refresh the sample catalog, run the server with a fresh database and:
//   node demo/build.mjs --seed http://localhost:3000  (logs in as admin@example.com / changeme123)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const seedFrom = process.argv.includes('--seed') ? process.argv[process.argv.indexOf('--seed') + 1] : null;
if (seedFrom) {
  const login = await fetch(seedFrom + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'changeme123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = p => fetch(seedFrom + p, { headers: { cookie } }).then(r => r.json());
  const settings = await get('/api/admin/settings');
  for (const k of Object.keys(settings)) if (k.startsWith('ghl_') || k === 'public_url') delete settings[k];
  writeFileSync('demo/seed-admin.json', JSON.stringify({ catalog: await get('/api/admin/catalog'), settings }, null, 1));
  console.log('Wrote demo/seed-admin.json');
}

const bundle = async entry => (await build({ entryPoints: [entry], bundle: true, minify: true, format: 'esm', write: false, loader: { '.json': 'json' },
  alias: { 'node:crypto': fileURLToPath(new URL('./crypto-shim.js', import.meta.url)) } }))
  .outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
  // drop GLTFLoader's tiny embedded AVIF/WebP support-test images (embedded image files block public sharing)
  .replace(/data:image\/(avif|webp);base64,[A-Za-z0-9+/=]+/g, 'data:,');
const bannerCss = `
.demo-banner{background:#fff6e5;color:#7a3d06;font:13px/1.4 Inter,system-ui,sans-serif;text-align:center;padding:6px 12px;border-bottom:1px solid #f3dfb8}
.demo-banner a{color:#7a3d06;font-weight:700}
.demo-banner button{margin-left:10px;border:1px solid #e7c58c;background:#fff;border-radius:6px;padding:2px 8px;font:inherit;color:#7a3d06;cursor:pointer}`;
const inline = (html, cssFile, js, extraCss, title) => html
  .replace(/<script src="\/vendor\/pdf\/([^"]+)"><\/script>/g, (m, f) => `<script>${readFileSync('node_modules/' + (f.startsWith('jspdf') ? 'jspdf' : 'svg2pdf.js') + '/dist/' + f, 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`)
  .replace(/<link rel="stylesheet" href="[^"]+\.css">/, () => `<style>${cssFile ? readFileSync(cssFile, 'utf8') : ''}${extraCss}</style>`)
  .replace('</head>', cssFile ? '</head>' : `<style>${extraCss}</style></head>`)
  .replace(/<script type="importmap">[\s\S]*?<\/script>/, '')
  .replace(/<script type="module" src="[^"]+"><\/script>/, () => `<script type="module">${js}</script>`)
  .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);

mkdirSync('demo/dist', { recursive: true });
const pdfTags = '<script src="/vendor/pdf/jspdf.umd.min.js"></script><script src="/vendor/pdf/svg2pdf.umd.min.js"></script>';
const builder = inline(readFileSync('public/index.html', 'utf8').replace('<script type="module"', pdfTags + '\n<script type="module"'), 'public/css/app.css', await bundle('demo/entry.js'),
  bannerCss + `\nbody:has(.demo-banner) .layout{height:calc(100dvh - var(--top-h) - 31px)}`, 'Shed Builder Demo');
const admin = inline(readFileSync('public/admin/index.html', 'utf8'), 'public/admin/admin.css', await bundle('demo/admin-entry.js'), bannerCss, 'Shed Builder 2.0 Demo');
writeFileSync('demo/dist/shed-builder-demo.html', builder);
writeFileSync('demo/dist/admin.html', admin);
const sign = inline(readFileSync('public/sign.html', 'utf8'), null, await bundle('demo/sign-entry.js'), bannerCss, 'Review & sign (demo)');
writeFileSync('demo/dist/sign.html', sign);
writeFileSync('demo/dist/index.html', builder);
// full product demo for a claude.ai artifact: admin as the main page + builder, admin and signing pages as files
const fragment = html => html.replace(/<!doctype html>\s*/i, '').replace(/<html[^>]*>|<\/html>|<head>|<\/head>|<\/body>/gi, '').replace(/<body>/i, '')
  .replace(/<meta charset="utf-8">\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '');
writeFileSync('demo/dist/admin.artifact.html', fragment(admin));
mkdirSync('demo/dist/vendor/pdfjs', { recursive: true });
copyFileSync('node_modules/pdfjs-dist/build/pdf.min.mjs', 'demo/dist/vendor/pdfjs/pdf.min.js');
copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'demo/dist/vendor/pdfjs/pdf.worker.min.js');
// claude.ai artifact bundle: admin is the main page; the builder is builder.html (the main page is always the index)
mkdirSync('demo/dist/artifact/vendor/pdfjs', { recursive: true });
// raw control characters only appear inside JS string literals in these bundles; publish them as \xNN escapes
const noCtl = t => t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const art = h => noCtl(h.replace(/index\.html/g, 'builder.html'));
writeFileSync('demo/dist/artifact/main.html', art(fragment(admin)));
writeFileSync('demo/dist/artifact/admin.html', art(admin));
writeFileSync('demo/dist/artifact/builder.html', art(builder));
writeFileSync('demo/dist/artifact/sign.html', art(sign));
for (const f of ['pdf.min.js', 'pdf.worker.min.js']) writeFileSync('demo/dist/artifact/vendor/pdfjs/' + f, noCtl(readFileSync('demo/dist/vendor/pdfjs/' + f, 'latin1')), 'latin1');

// Artifact-friendly fragment of the builder page (no doctype/html/head/body wrappers)
writeFileSync('demo/dist/shed-builder-demo.artifact.html', builder
  .replace(/<!doctype html>\s*/i, '').replace(/<html[^>]*>|<\/html>|<head>|<\/head>|<\/body>/gi, '').replace(/<body>/i, '')
  .replace(/<meta charset="utf-8">\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, ''));
// Tester build: designer only, no admin link — safe to send to anyone
const tester = inline(readFileSync('public/index.html', 'utf8').replace('<script type="module"', pdfTags + '\n<script type="module"'), 'public/css/app.css', await bundle('demo/tester-entry.js'),
  bannerCss + `\nbody:has(.demo-banner) .layout{height:calc(100dvh - var(--top-h) - 31px)}`, 'Shed Designer');
writeFileSync('demo/dist/shed-designer-test.artifact.html', tester
  .replace(/<!doctype html>\s*/i, '').replace(/<html[^>]*>|<\/html>|<head>|<\/head>|<\/body>/gi, '').replace(/<body>/i, '')
  .replace(/<meta charset="utf-8">\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, ''));
console.log('demo/dist: shed-builder-demo.html', (builder.length / 1024).toFixed(0) + ' KB, admin.html', (admin.length / 1024).toFixed(0) + ' KB');
