// Copies the Three.js build + addons into public/vendor so the app is fully self-hosted (no CDN needed).
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'three');
const dst = join(root, 'public', 'vendor', 'three');
if (!existsSync(src)) { console.log('three not installed yet, skipping'); process.exit(0); }
mkdirSync(dst, { recursive: true });
for (const f of ['three.module.js', 'three.core.js']) {
  if (existsSync(join(src, 'build', f))) cpSync(join(src, 'build', f), join(dst, f));
}
cpSync(join(src, 'examples', 'jsm'), join(dst, 'addons'), { recursive: true });
// PDF libraries (drawing packages are built in the browser)
const pdfDst = join(root, 'public', 'vendor', 'pdf');
mkdirSync(pdfDst, { recursive: true });
for (const [pkg, file] of [['jspdf', 'jspdf.umd.min.js'], ['svg2pdf.js', 'svg2pdf.umd.min.js']]) {
  const f = join(root, 'node_modules', pkg, 'dist', file);
  if (existsSync(f)) cpSync(f, join(pdfDst, file));
}
// pdf.js renders contract PDFs in the browser (template designer + customer signing page)
const pdfjsSrc = join(root, 'node_modules', 'pdfjs-dist', 'build');
const pdfjsDst = join(root, 'public', 'vendor', 'pdfjs');
mkdirSync(pdfjsDst, { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) if (existsSync(join(pdfjsSrc, f))) cpSync(join(pdfjsSrc, f), join(pdfjsDst, f));
console.log('Copied three.js + PDF libraries to public/vendor');
