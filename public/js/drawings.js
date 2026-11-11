// Drawing package: one PDF per quote with a 3D cover + spec sheet, the floor plan and all four elevations.
// Uses jsPDF + svg2pdf (loaded as /vendor/pdf/*.umd.min.js → window.jspdf).
import { ShedScene } from './shed3d.js';
import { floorPlanSVG, skidNote } from './shared/floorplan.js';
import { elevationSVG } from './shared/elevations.js';
import { DRAWING_INITIALS_BOX } from './shared/contract.js';

function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); }); }
async function loadPdfLibs() {
  if (!window.jspdf) await loadScript('/vendor/pdf/jspdf.umd.min.js');
  if (!window.jspdf?.jsPDF?.API?.svg) await loadScript('/vendor/pdf/svg2pdf.umd.min.js');
}
// Helvetica (WinAnsi) lacks some glyphs — map them to safe equivalents.
const pdfSafe = v => String(v ?? '').replace(/\u2212/g, '-').replace(/\u00d7/g, 'x').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2013|\u2014/g, '-');
function patchText(doc) {
  const orig = doc.text.bind(doc);
  doc.text = (t, ...a) => orig(Array.isArray(t) ? t.map(pdfSafe) : pdfSafe(t), ...a);
}
function fmtDay(s) { const d = s ? new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z')) : new Date(); return isNaN(d) ? new Date().toLocaleDateString('en-US') : d.toLocaleDateString('en-US'); }
const PAGE = { w: 792, h: 612, m: 32 };      // US Letter landscape, points
const INK = [29, 38, 36], MUTED = [125, 136, 133];

function svgEl(markup) {
  const el = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:10px;height:10px;overflow:hidden';
  host.appendChild(el); document.body.appendChild(host);
  return { el, done: () => host.remove() };
}
async function placeSVG(doc, markup, box) {
  const { el, done } = svgEl(markup);
  const vb = el.viewBox.baseVal, ar = vb.width / vb.height;
  let w = box.w, h = w / ar; if (h > box.h) { h = box.h; w = h * ar; }
  try { await doc.svg(el, { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, width: w, height: h }); }
  finally { done(); }
}
function frame(doc, meta, title, n, total) {
  const { w, h, m } = PAGE;
  doc.setDrawColor(...INK); doc.setLineWidth(0.8); doc.rect(m - 10, m - 10, w - 2 * m + 20, h - 2 * m + 20);
  // title block along the bottom
  const y = h - m - 26;
  doc.setLineWidth(0.5); doc.line(m - 10, y - 8, w - m + 10, y - 8);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...INK);
  doc.text(title, m, y + 6);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
  doc.text([meta.company, `${meta.quote}${meta.customer ? ' · ' + meta.customer : ''}`].filter(Boolean).join('   ·   '), m, y + 19);
  doc.text(`${meta.shed}   ·   ${meta.date}`, w / 2, y + 19, { align: 'center' });
  // contract copies get a "Customer initials" box at the right end of the title block
  const rx = meta.initials ? DRAWING_INITIALS_BOX.x * w - 12 : w - m;
  doc.text(`Sheet ${n} of ${total}`, rx, y + 6, { align: 'right' });
  if (meta.initials) { doc.setFontSize(6.5); doc.text('Dimensions are nominal. Verify on site before building.', w / 2, y + 28, { align: 'center' }); doc.setFontSize(8.5); }
  else doc.text('Dimensions are nominal. Verify on site before building.', rx, y + 19, { align: 'right' });
  if (meta.initials) {
    const b = DRAWING_INITIALS_BOX;
    doc.setDrawColor(...INK); doc.setLineWidth(0.6); doc.rect(b.x * w, b.y * h, b.w * w, b.h * h);
    doc.setFontSize(6.5); doc.setTextColor(...MUTED); doc.text('CUSTOMER APPROVAL (INITIALS)', b.x * w + 3, b.y * h + 7);
  }
}

export async function render3D(catalog, config) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-4000px;top:0;width:1200px;height:800px';
  document.body.appendChild(host);
  const sc = new ShedScene(host);
  try {
    sc.build(catalog, config); sc.frame('front34', false);
    await new Promise(r => setTimeout(r, 400)); // let custom .glb models load
    sc.renderer.render(sc.scene, sc.camera);
    return sc.renderer.domElement.toDataURL('image/jpeg', 0.9);
  } finally { sc.dispose(); host.remove(); }
}

/**
 * @param catalog full catalog (styles with sizes, colors, options, settings)
 * @param quote   formatted quote (as returned by GET /api/v1/quotes/:id) incl. config + pricing_lines
 * @returns Blob (application/pdf)
 */
export async function buildDrawingPackage(catalog, quote, { company = '', withPricing = false, terms = '', showTier = false, initials = false, money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) } = {}) {
  await loadPdfLibs();
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) throw new Error('PDF library failed to load');
  const config = quote.config;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  patchText(doc);
  const meta = {
    company, quote: `Quote ${quote.number}`, customer: quote.customer?.full_name || '',
    shed: `${quote.shed.style} ${quote.shed.size}${quote.shed.roofing ? ' · ' + quote.shed.roofing : ''}`,
    date: new Date().toLocaleDateString('en-US'), initials,
  };
  const total = withPricing ? 5 : 4;
  const { w, h, m } = PAGE, area = { x: m, y: m, w: w - 2 * m, h: h - 2 * m - 46 };

  // 1 — cover: 3D view + spec sheet
  const img = await render3D(catalog, config);
  const imgW = area.w * 0.6, imgH = imgW / 1.5;
  doc.addImage(img, 'JPEG', area.x, area.y, imgW, Math.min(imgH, area.h));
  let y = area.y + 6; const x = area.x + imgW + 18, colW = area.w - imgW - 18;
  doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text(quote.shed.style, x, y + 10); y += 28;
  doc.setFontSize(10); doc.setFont('helvetica', 'normal');
  const st = catalog.styles.find(s => s.id === config.style_id), sz = st?.sizes.find(z => z.id === config.size_id);
  const kv = [['Size', `${quote.shed.size} (${quote.shed.sq_ft} sq ft)`], ['Roofing', quote.shed.roofing || ''], ...(st && sz ? [['Skids', skidNote(st, sz)]] : []),
    ...Object.entries(quote.shed.colors || {}).map(([k, v]) => [k[0].toUpperCase() + k.slice(1), v]),
    ...(quote.dealer ? [['Dealer lot', quote.dealer.name]] : []),
    ['Customer', meta.customer], ['Delivery', [quote.customer?.address, quote.customer?.city, quote.customer?.state, quote.customer?.zip].filter(Boolean).join(', ')]];
  for (const [k, v] of kv) {
    if (!v) continue;
    doc.setTextColor(...MUTED); doc.text(k, x, y); doc.setTextColor(...INK);
    const lines = doc.splitTextToSize(String(v), colW - 70); doc.text(lines, x + 70, y); y += 14 * lines.length;
  }
  y += 8; doc.setFont('helvetica', 'bold'); doc.text('Options', x, y); y += 14; doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  for (const o of quote.options || []) {
    if (y > area.y + area.h - 10) { doc.text('…', x, y); break; }
    const lines = doc.splitTextToSize(`• ${o.name}${o.wall ? ` — ${o.wall} wall` : ''}${o.detail ? ` (${o.detail})` : ''}${o.note === 'Standard' ? ' (standard)' : ''}`, colW);
    doc.text(lines, x, y); y += 11.5 * lines.length;
  }
  if (withPricing && quote.pricing) {
    const by = area.y + Math.min(imgH, area.h) + 18;
    doc.setFillColor(243, 245, 244); doc.roundedRect(area.x, by, imgW, 34, 4, 4, 'F');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
    doc.text('Quoted price (incl. delivery & tax) - itemized on sheet 2', area.x + 12, by + 21);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...INK);
    doc.text(money(quote.pricing.total), area.x + imgW - 12, by + 22, { align: 'right' });
  }
  frame(doc, meta, '3D VIEW & SPECIFICATIONS', 1, total);

  // 2 — pricing (quote) sheet
  let sheet = 2;
  if (withPricing) {
    doc.addPage();
    let py = area.y + 8;
    doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text(`Quote ${quote.number}`, area.x, py + 8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...MUTED);
    doc.text(`Prepared ${fmtDay(quote.created_at)}${quote.dealer ? ' · ' + quote.dealer.name : ''}${showTier && quote.pricing?.tier ? ' · Price tier: ' + quote.pricing.tier : ''}`, area.x, py + 24);
    // customer block on the right
    const c = quote.customer || {};
    doc.setTextColor(...INK); doc.setFontSize(10);
    const who = [c.full_name, c.email, c.phone, [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ')].filter(Boolean);
    doc.text(who, area.x + area.w, py + 8, { align: 'right' });
    py += Math.max(52, 8 + who.length * 11.5 + 24);
    // table
    const colAmt = area.x + area.w, colNote = area.x + area.w * 0.56;
    doc.setFillColor(243, 245, 244); doc.rect(area.x, py - 12, area.w, 18, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text('ITEM', area.x + 6, py); doc.text('DETAIL', colNote, py); doc.text('PRICE', colAmt - 6, py, { align: 'right' });
    py += 18; doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    const lines = quote.pricing_lines || [];
    const maxY = area.y + area.h - 70;
    for (const l of lines) {
      if (l.type === 'color' && !l.amount) continue;
      if (py > maxY) { doc.text('… continued in your online quote', area.x + 6, py); break; }
      doc.setTextColor(...INK);
      const name = doc.splitTextToSize(String(l.label), colNote - area.x - 14);
      doc.text(name, area.x + 6, py);
      doc.setTextColor(...MUTED); doc.setFontSize(9);
      const det = [l.note, l.wall ? `${l.wall} wall` : '', l.detail].filter(Boolean).join(' · ');
      if (det) doc.text(doc.splitTextToSize(det, colAmt - colNote - 80), colNote, py);
      doc.setFontSize(10); doc.setTextColor(...(l.amount < 0 ? [6, 118, 71] : INK));
      doc.text(l.note === 'Standard' ? 'Included' : money(l.amount), colAmt - 6, py, { align: 'right' });
      py += 13 * Math.max(1, name.length) + 3;
      doc.setDrawColor(228, 232, 230); doc.setLineWidth(0.4); doc.line(area.x, py - 9, area.x + area.w, py - 9);
    }
    // totals
    py += 6; const tx = area.x + area.w * 0.6;
    const tot = [['Subtotal', quote.pricing.subtotal], ...(quote.pricing.delivery ? [['Delivery', quote.pricing.delivery]] : []), ...(quote.pricing.tax ? [[`Tax (${quote.pricing.tax_rate}%)`, quote.pricing.tax]] : [])];
    doc.setTextColor(...INK);
    for (const [k, v] of tot) { doc.text(k, tx, py); doc.text(money(v), colAmt - 6, py, { align: 'right' }); py += 15; }
    doc.setDrawColor(...INK); doc.setLineWidth(0.8); doc.line(tx, py - 9, area.x + area.w, py - 9);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text('Total', tx, py + 6); doc.text(money(quote.pricing.total), colAmt - 6, py + 6, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    if (terms) doc.text(doc.splitTextToSize(terms, area.w * 0.55), area.x, area.y + area.h - 40);
    frame(doc, meta, 'QUOTE & PRICING', sheet, total);
    sheet++;
  }

  // floor plan
  doc.addPage();
  await placeSVG(doc, floorPlanSVG(catalog, config, { customer: quote.customer, quote_number: quote.number }), area);
  frame(doc, meta, 'FLOOR PLAN', sheet, total); sheet++;

  // elevations, two per sheet at the same scale
  const pairs = [['front', 'back'], ['left', 'right']];
  for (const [i, pair] of pairs.entries()) {
    doc.addPage();
    const els = pair.map(wall => elevationSVG(catalog, config, wall));
    const half = { w: (area.w - 16) / 2, h: area.h };
    // common scale so both views on a sheet match
    const scale = Math.min(...els.map(e => Math.min(half.w / e.width, half.h / e.height)));
    for (const [k, e] of els.entries()) {
      const bw = e.width * scale, bh = e.height * scale;
      await placeSVG(doc, e.svg, { x: area.x + k * (half.w + 16) + (half.w - bw) / 2, y: area.y + (half.h - bh) / 2, w: bw, h: bh });
    }
    frame(doc, meta, `${pair[0].toUpperCase()} & ${pair[1].toUpperCase()} ELEVATIONS`, sheet + i, total);
  }
  return doc.output('blob');
}

/** Floor plan as a PNG data URL (for placing on a contract page). */
export async function floorPlanPNG(catalog, quote, scale = 2) {
  const markup = floorPlanSVG(catalog, quote.config, { customer: quote.customer, quote_number: quote.number });
  const el = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
  const vb = el.viewBox?.baseVal; const W = Math.round((vb?.width || 1000) * scale), H = Math.round((vb?.height || 700) * scale);
  el.setAttribute('width', W); el.setAttribute('height', H);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(el));
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not draw the floor plan')); i.src = url; });
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H);
  return cv.toDataURL('image/png');
}
