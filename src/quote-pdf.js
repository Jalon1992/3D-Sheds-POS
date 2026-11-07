// The company's copy of a quote as a PDF: a pricing page built here from the server's own prices
// (so nobody can change them), followed by the drawing set the customer's browser rendered
// (3D view, elevations, floor plan) when it sent one. Used for GoHighLevel and the admin download.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const INK = rgb(0.09, 0.125, 0.114), MUTED = rgb(0.42, 0.47, 0.46), LINE = rgb(0.894, 0.91, 0.902), BAND = rgb(0.953, 0.961, 0.957), GREEN = rgb(0.024, 0.463, 0.278);
const W = 792, H = 612, M = 40; // US letter, landscape (matches the drawing set)
const SAFE = { '−': '-', '×': 'x', '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '•': '-', ' ': ' ', '″': '"', '′': "'" };
const clean = (font, s) => { const set = new Set(font.getCharacterSet()); return [...String(s ?? '')].map(ch => SAFE[ch] ?? ch).map(ch => (set.has(ch.codePointAt(0)) ? ch : '?')).join(''); };
const money = n => (Number(n) < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function wrap(font, text, size, maxW) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(clean(font, t), size) > maxW && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

/**
 * @param {object} o { quote: formatted quote (formatQuote), lines: pricing lines, company, terms, showTier, drawings?: Buffer }
 * @returns {Promise<Uint8Array>}
 */
export async function buildQuotePdf({ quote, lines = [], company = '', terms = '', showTier = true, drawings = null }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Quote ${quote.number}`); pdf.setCreator('3D Shed Builder'); if (company) pdf.setAuthor(company);
  const reg = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page, y;
  const text = (s, x, yy, { size = 10, font = reg, color = INK, align = 'left' } = {}) => {
    const t = clean(font, s), w = font.widthOfTextAtSize(t, size);
    page.drawText(t, { x: align === 'right' ? x - w : x, y: yy, size, font, color });
  };
  const newPage = () => {
    page = pdf.addPage([W, H]); y = H - M;
    text(company || 'Quote', M, y - 14, { size: 17, font: bold });
    text(`Quote ${quote.number}`, W - M, y - 14, { size: 17, font: bold, align: 'right' });
    const created = quote.created_at ? new Date(String(quote.created_at).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(quote.created_at) ? '' : 'Z')) : new Date();
    text(`Prepared ${created.toLocaleDateString('en-US')}${quote.dealer?.name ? ' · ' + quote.dealer.name : ''}${showTier && quote.pricing?.tier ? ' · Price tier: ' + quote.pricing.tier : ''}`, W - M, y - 30, { size: 9.5, color: MUTED, align: 'right' });
    page.drawLine({ start: { x: M, y: y - 42 }, end: { x: W - M, y: y - 42 }, thickness: 1, color: INK });
    y -= 64;
  };
  newPage();

  // customer (left) and building (right)
  const c = quote.customer || {}, sh = quote.shed || {};
  const who = [c.full_name, c.email, c.phone, [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ')].filter(Boolean);
  const bld = [`${sh.style || ''} ${sh.size || ''}${sh.sq_ft ? ` (${sh.sq_ft} sq ft)` : ''}`, sh.roofing ? `Roofing: ${sh.roofing}` : '', ...Object.entries(sh.colors || {}).map(([k, v]) => `${k[0].toUpperCase() + k.slice(1)}: ${v}`)].filter(Boolean);
  text('CUSTOMER', M, y, { size: 8.5, font: bold, color: MUTED }); text('BUILDING', W / 2, y, { size: 8.5, font: bold, color: MUTED });
  let yl = y - 15, yr = y - 15;
  for (const l of who) { text(l, M, yl); yl -= 13; }
  for (const l of bld) { text(l, W / 2, yr, { font: l === bld[0] ? bold : reg }); yr -= 13; }
  y = Math.min(yl, yr) - 14;

  // item table
  const colNote = M + (W - 2 * M) * 0.5, colAmt = W - M;
  const head = () => {
    page.drawRectangle({ x: M, y: y - 5, width: W - 2 * M, height: 18, color: BAND });
    text('ITEM', M + 6, y, { size: 8.5, font: bold, color: MUTED }); text('DETAIL', colNote, y, { size: 8.5, font: bold, color: MUTED }); text('PRICE', colAmt - 6, y, { size: 8.5, font: bold, color: MUTED, align: 'right' });
    y -= 20;
  };
  head();
  for (const l of lines) {
    if (l.type === 'color' && !l.amount) continue;
    const name = wrap(reg, l.label, 10, colNote - M - 16);
    const det = wrap(reg, [l.note && l.note !== 'Standard' ? l.note : '', l.wall ? `${l.wall} wall` : '', l.detail].filter(Boolean).join(' · '), 9, colAmt - colNote - 90);
    const rows = Math.max(name.length, det.filter(Boolean).length, 1);
    if (y - rows * 13 < M + 150) { newPage(); head(); }
    name.forEach((t, i) => text(t, M + 6, y - i * 13));
    det.forEach((t, i) => t && text(t, colNote, y - i * 13, { size: 9, color: MUTED }));
    text(l.note === 'Standard' ? 'Included' : money(l.amount), colAmt - 6, y, { color: l.amount < 0 ? GREEN : INK, align: 'right' });
    y -= rows * 13 + 4;
    page.drawLine({ start: { x: M, y: y + 9 }, end: { x: W - M, y: y + 9 }, thickness: 0.4, color: LINE });
  }

  // totals
  const p = quote.pricing || {}, tx = M + (W - 2 * M) * 0.62;
  if (y < M + 140) newPage();
  y -= 8;
  for (const [k, v] of [['Subtotal', p.subtotal], ...(p.delivery ? [['Delivery', p.delivery]] : []), ...(p.tax ? [[`Tax (${p.tax_rate}%)`, p.tax]] : [])]) { text(k, tx, y); text(money(v), colAmt - 6, y, { align: 'right' }); y -= 15; }
  page.drawLine({ start: { x: tx, y: y + 9 }, end: { x: W - M, y: y + 9 }, thickness: 0.8, color: INK });
  y -= 8; text('Total', tx, y, { size: 13, font: bold }); text(money(p.total), colAmt - 6, y, { size: 13, font: bold, align: 'right' });
  y -= 26;

  // notes, terms, links
  const foot = [];
  if (c.notes) foot.push(['Customer notes', c.notes]);
  if (terms) foot.push(['Terms', terms]);
  if (quote.links?.view_3d) foot.push(['See it in 3D', quote.links.view_3d]);
  for (const [k, v] of foot) {
    const ls = wrap(reg, v, 9, W - 2 * M - 110);
    if (y - ls.length * 12 < M) newPage();
    text(k, M, y, { size: 9, font: bold, color: MUTED }); ls.forEach((t, i) => text(t, M + 110, y - i * 12, { size: 9, color: k === 'See it in 3D' ? GREEN : INK })); y -= ls.length * 12 + 8;
  }

  // the drawing set from the customer's browser (3D view, elevations, floor plan)
  if (drawings) {
    try {
      const d = await PDFDocument.load(drawings);
      for (const pg of await pdf.copyPages(d, d.getPageIndices())) pdf.addPage(pg);
    } catch (e) { console.error('Quote PDF: drawings could not be added:', e.message); }
  }
  return pdf.save();
}

/** A browser-made drawing set we are willing to merge: a real PDF of a sensible size. */
export async function checkDrawings(buf) {
  if (!buf || buf.length < 100 || buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Not a PDF');
  const d = await PDFDocument.load(buf);
  const n = d.getPageCount();
  if (n < 1 || n > 12) throw new Error('Unexpected page count');
  return n;
}
