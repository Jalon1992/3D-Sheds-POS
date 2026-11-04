// Shared demo plumbing: PDF viewer location, no live-update stream, and links to /api/... files
// (contract PDFs) are fetched from the in-browser backend and saved/opened instead of navigated to.
window.__noLive = true;
window.__pdfjsFiles = { lib: new URL('vendor/pdfjs/pdf.min.js', location.href).href, worker: new URL('vendor/pdfjs/pdf.worker.min.js', location.href).href };
document.addEventListener('click', async e => {
  const a = e.target.closest?.('a[href*="/api/"]'); if (!a) return;
  e.preventDefault();
  const r = await fetch(a.getAttribute('href'));
  if (!r.ok) { alert((await r.json().catch(() => ({}))).error || 'Not available in the demo'); return; }
  const blob = await r.blob();
  const name = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || a.getAttribute('href').split('/').pop().split('?')[0];
  if (window.__shedSave) window.__shedSave(blob, name); else window.open(URL.createObjectURL(blob));
}, true);
// The claude.ai page viewer blocks confirm()/prompt()/alert(): in the demo, confirmations go ahead
// and prompts take their suggested value so every flow still works.
window.confirm = () => true;
window.prompt = (msg, def) => (def ?? '');
window.alert = msg => console.warn(msg);
