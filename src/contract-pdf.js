// Contract PDFs with pdf-lib: fill auto info into a template, append the drawing package,
// stamp signatures, and add a certificate of completion (audit trail).
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import crypto from 'node:crypto';
import { lookup } from '../public/js/shared/contract.js';

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** Read page sizes as seen in a PDF viewer (rotation applied). */
export async function inspectPdf(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  return pdf.getPages().map(p => {
    const { width, height } = p.getSize(); const r = ((p.getRotation().angle % 360) + 360) % 360;
    return r % 180 ? { w: height, h: width, rotate: r } : { w: width, h: height, rotate: r };
  });
}

// viewer (top-left origin, rotation applied) → PDF user space for the page
function anchor(page, f) {
  const { width: W, height: H } = page.getSize();
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  const Wv = r % 180 ? H : W, Hv = r % 180 ? W : H;
  const vx = f.x * Wv, vy = f.y * Hv, vw = f.w * Wv, vh = f.h * Hv;
  const map = (x, y) => (r === 90 ? [y, x] : r === 180 ? [W - x, y] : r === 270 ? [W - y, H - x] : [x, H - y]);
  return { r, vw, vh, at: (dx, dy) => map(vx + dx, vy + vh - dy) }; // (dx, dy) measured from the box's bottom-left, y up
}

const SAFE = { '−': '-', '×': 'x', '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '•': '-', ' ': ' ' };
function safeText(font, s) {
  const set = safeText.cache.get(font) || new Set(font.getCharacterSet());
  safeText.cache.set(font, set);
  return [...String(s ?? '')].map(ch => SAFE[ch] ?? ch).join('').split('').map(ch => (ch === '\n' || set.has(ch.codePointAt(0)) ? ch : '?')).join('');
}
safeText.cache = new Map();

function wrap(font, text, size, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const t = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(t, size) <= maxW || !line) line = t; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/** Draw text into a field box: shrinks to fit; wraps when the box is tall enough for 2+ lines. */
function drawTextBox(page, font, f, text, { color = rgb(0.07, 0.1, 0.09), maxSize = 11 } = {}) {
  text = safeText(font, text); if (!text) return;
  const a = anchor(page, f);
  const pad = Math.min(2, a.vw * 0.03);
  let size = Math.min(Number(f.fontSize) || maxSize, a.vh * 0.78);
  const multi = a.vh >= size * 2.3 || text.includes('\n');
  let lines;
  for (;;) {
    lines = multi ? wrap(font, text, size, a.vw - pad * 2) : [text];
    const tooWide = lines.some(l => font.widthOfTextAtSize(l, size) > a.vw - pad * 2);
    const tooTall = lines.length * size * 1.18 > a.vh + 0.5;
    if ((!tooWide && !tooTall) || size <= 5) break;
    size -= 0.25;
  }
  const lh = size * 1.18;
  const startDy = multi ? a.vh - size - 1 : Math.max(1, (a.vh - size) / 2 + size * 0.22);
  lines.forEach((ln, i) => {
    const dy = startDy - i * lh; if (dy < -1) return;
    const tw = font.widthOfTextAtSize(ln, size);
    const dx = f.align === 'right' ? a.vw - pad - tw : f.align === 'center' ? (a.vw - tw) / 2 : pad;
    const [x, y] = a.at(dx, dy);
    page.drawText(ln, { x, y, size, font, color, rotate: degrees(a.r) });
  });
}
async function drawImageBox(pdf, page, f, bytes, kind) {
  const img = kind === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  const a = anchor(page, f);
  const s = Math.min(a.vw / img.width, a.vh / img.height);
  const w = img.width * s, h = img.height * s;
  const align = f.align || (f.type === 'signature' || f.type === 'initials' ? 'left' : 'center');
  const dx = align === 'left' ? 0 : (a.vw - w) / 2;
  const [x, y] = a.at(dx, (a.vh - h) / 2);
  page.drawImage(img, { x, y, width: w, height: h, rotate: degrees(a.r) });
}
const b64 = s => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'base64') : Uint8Array.from(atob(s), c => c.charCodeAt(0)));
const dataUrlBytes = (u, kind) => { const m = String(u || '').match(new RegExp(`^data:image/${kind === 'png' ? 'png' : 'jpe?g'};base64,(.+)$`)); return m ? b64(m[1]) : null; };

/**
 * Template + auto-filled info + images + appended drawing sheets → the document customers sign.
 * @returns {{ bytes: Uint8Array, pages: Array, templatePages: number }}
 */
export async function preparePdf({ templateBytes, fields, data, rendering, floorplan, drawingsBytes, appendDrawings }) {
  const pdf = await PDFDocument.load(templateBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // fillable PDFs: bake the form fields into the page so nobody can edit them after signing
  try { const form = pdf.getForm(); if (form.getFields().length) form.flatten(); } catch { /* unusual form — leave it */ }
  const pages = pdf.getPages();
  for (const f of fields) {
    const page = pages[f.page]; if (!page) continue;
    if (f.type === 'data') drawTextBox(page, font, f, lookup(data, f.tag));
    else if (f.type === 'rendering' && rendering) await drawImageBox(pdf, page, f, rendering, 'jpg');
    else if (f.type === 'floorplan' && floorplan) await drawImageBox(pdf, page, f, floorplan, 'png');
  }
  const templatePages = pages.length;
  if (appendDrawings && drawingsBytes) {
    const dr = await PDFDocument.load(drawingsBytes);
    const copied = await pdf.copyPages(dr, dr.getPageIndices());
    copied.forEach(p => pdf.addPage(p));
  }
  pdf.setTitle(`Contract ${data.contract?.number || ''}`.trim());
  pdf.setProducer('3D Shed Builder'); pdf.setCreator('3D Shed Builder');
  const bytes = await pdf.save();
  return { bytes, pages: await inspectPdf(bytes), templatePages };
}

const fmtTs = (s, tz) => {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  try { return d.toLocaleString('en-US', { timeZone: tz || 'America/Chicago', dateStyle: 'medium', timeStyle: 'long' }); } catch { return d.toISOString(); }
};

/** Stamp every signer's signatures / initials / dates / answers and add the certificate of completion. */
export async function finalizePdf({ preparedBytes, fields, signers, contract, events, tz, company }) {
  const pdf = await PDFDocument.load(preparedBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  const byRole = Object.fromEntries(signers.map(s => [s.role, s]));
  for (const f of fields) {
    const s = byRole[f.role]; const page = pages[f.page];
    if (!s || !page || s.status !== 'signed') continue;
    const v = (s.values_json || {})[f.id];
    if (f.type === 'signature' || f.type === 'initials') { const b = dataUrlBytes(v, 'png'); if (b) await drawImageBox(pdf, page, f, b, 'png'); }
    else if (f.type === 'date_signed') drawTextBox(page, font, f, new Date(String(s.signed_at).replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { timeZone: tz || 'America/Chicago' }));
    else if (f.type === 'text' && v) drawTextBox(page, font, f, String(v));
    else if (f.type === 'checkbox' && (v === true || v === 'true' || v === 1)) {
      const a = anchor(page, f); const sz = Math.min(a.vw, a.vh);
      const [x1, y1] = a.at(sz * 0.18, sz * 0.5), [x2, y2] = a.at(sz * 0.42, sz * 0.2), [x3, y3] = a.at(sz * 0.85, sz * 0.85);
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: Math.max(1, sz * 0.12), color: rgb(0.07, 0.1, 0.09) });
      page.drawLine({ start: { x: x2, y: y2 }, end: { x: x3, y: y3 }, thickness: Math.max(1, sz * 0.12), color: rgb(0.07, 0.1, 0.09) });
    }
  }

  // ---- certificate of completion (US Letter portrait)
  const W = 612, H = 792, M = 48;
  let page = pdf.addPage([W, H]); let y = H - M;
  const ink = rgb(0.09, 0.13, 0.12), muted = rgb(0.45, 0.5, 0.49), line = rgb(0.85, 0.88, 0.87);
  const T = (t, x, yy, o = {}) => page.drawText(safeText(o.font || font, t), { x, y: yy, size: o.size || 9.5, font: o.font || font, color: o.color || ink });
  const newPageIfNeeded = need => { if (y - need < M) { page = pdf.addPage([W, H]); y = H - M; } };
  T('Certificate of Completion', M, y - 6, { font: bold, size: 18 }); y -= 30;
  T(`${company || ''}  ·  Contract ${contract.number}  ·  ${contract.template_name || ''}`, M, y, { color: muted }); y -= 22;
  const kv = [['Status', 'Completed — signed by all parties'], ['Completed', fmtTs(contract.completed_at, tz)], ['Sale type', contract.sale_type === 'rto' ? 'Rent to Own' : 'Cash'],
    ['Pages', `${pages.length} (contract + drawings), plus this certificate`], ['Document fingerprint', 'SHA-256 of the document as sent for signature:'], ['', contract.prepared_hash || '']];
  for (const [k, v] of kv) { T(k, M, y, { color: muted }); T(v, M + 130, y, { size: k ? 9.5 : 8 }); y -= 15; }
  y -= 8;
  for (const s of signers) {
    newPageIfNeeded(120);
    page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.6, color: line }); y -= 12;
    T(`${s.role === 'cobuyer' ? 'Co-buyer' : s.role === 'company' ? 'Company' : 'Customer'}: ${s.name || ''}`, M, y, { font: bold, size: 11 }); y -= 16;
    const rows = [['Email', s.email || '—'], ['Mobile', s.phone || '—'], ['Viewed', fmtTs(s.viewed_at, tz) || '—'], ['Agreed to e-sign', fmtTs(s.consent_at, tz) || '—'], ['Signed', fmtTs(s.signed_at, tz) || '—'], ['IP address', s.ip || '—'], ['Device', String(s.user_agent || '—').slice(0, 95)]];
    for (const [k, v] of rows) { T(k, M + 10, y, { color: muted }); T(v, M + 130, y); y -= 13.5; }
    const sig = Object.entries(s.values_json || {}).map(([id, v]) => ({ f: fields.find(f => f.id === id), v })).find(x => x.f?.type === 'signature' && dataUrlBytes(x.v, 'png'));
    if (sig) {
      const img = await pdf.embedPng(dataUrlBytes(sig.v, 'png'));
      const sc = Math.min(160 / img.width, 40 / img.height);
      page.drawImage(img, { x: W - M - 170, y: y + 40, width: img.width * sc, height: img.height * sc });
    }
    y -= 8;
  }
  newPageIfNeeded(60);
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.6, color: line }); y -= 12;
  T('Activity', M, y, { font: bold, size: 11 }); y -= 16;
  for (const e of events) {
    newPageIfNeeded(14);
    T(fmtTs(e.created_at, tz), M, y, { size: 8.5, color: muted });
    const txt = `${e.event}${e.detail ? ' — ' + e.detail : ''}${e.ip ? ' (IP ' + e.ip + ')' : ''}`;
    const ls = wrap(font, safeText(font, txt), 8.5, W - M - (M + 175));
    ls.forEach((l, i) => { if (i) { y -= 11; newPageIfNeeded(12); } T(l, M + 175, y, { size: 8.5 }); });
    y -= 13;
  }
  newPageIfNeeded(40); y -= 10;
  const legal = 'Each signer agreed to do business electronically and to use an electronic signature, which has the same legal effect as a handwritten signature (U.S. ESIGN Act and UETA). Signing links were unique to each signer and delivered to the email address or mobile number shown above.';
  for (const l of wrap(font, legal, 8, W - 2 * M)) { T(l, M, y, { size: 8, color: muted }); y -= 10.5; }
  const bytes = await pdf.save();
  return bytes;
}

// ---------------------------------------------------------------------------
// Sample templates (seeded on first run so the point of sale works out of the box)
// ---------------------------------------------------------------------------
export async function buildSampleTemplate(kind) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 50;
  const fields = []; let fid = 0;
  const F = (page, type, x, yTop, w, h, extra = {}) => fields.push({ id: 'f' + (++fid), page, type, x: x / W, y: yTop / H, w: w / W, h: h / H, required: true, ...extra });
  const ink = rgb(0.09, 0.13, 0.12), muted = rgb(0.42, 0.47, 0.46), ln = rgb(0.75, 0.79, 0.78);
  let page = pdf.addPage([W, H]); let pi = 0;
  const T = (t, x, yTop, o = {}) => page.drawText(t, { x, y: H - yTop, size: o.size || 9.5, font: o.font || font, color: o.color || ink });
  const L = (x, yTop, w) => page.drawLine({ start: { x, y: H - yTop }, end: { x: x + w, y: H - yTop }, thickness: 0.6, color: ln });
  const label = (t, x, yTop, w, tag, extra = {}) => { T(t, x, yTop - 13, { size: 7.5, color: muted }); L(x, yTop + 2, w); F(pi, 'data', x, yTop - 11, w, 13, { tag, required: false, ...extra }); };
  const para = (text, yTop, size = 8.6) => { let y = yTop; for (const l of wrap(font, text, size, W - 2 * M)) { T(l, M, y, { size }); y += size * 1.38; } return y; };

  const rto = kind === 'rto';
  T('SAMPLE — replace with your own agreement', M, 34, { size: 8, color: rgb(0.7, 0.25, 0.15), font: bold });
  F(0, 'data', M, 42, 300, 20, { tag: 'company.name', required: false, fontSize: 15 });
  T(rto ? 'Rent-to-Own Agreement' : 'Purchase Agreement — Cash Sale', M, 82, { size: 17, font: bold });
  T('Contract #', 400, 52, { size: 8, color: muted }); F(0, 'data', 450, 42, 112, 13, { tag: 'contract.number', required: false });
  T('Date', 400, 68, { size: 8, color: muted }); F(0, 'data', 450, 58, 112, 13, { tag: 'contract.date', required: false });
  let y = 112;
  T('BUYER', M, y, { font: bold, size: 9 }); y += 22;
  label('Name', M, y, 250, 'customer.full_name'); label('Phone', 320, y, 242, 'customer.phone'); y += 28;
  label('Email', M, y, 250, 'customer.email'); label('Co-buyer', 320, y, 242, 'cobuyer.full_name'); y += 28;
  label('Delivery address', M, y, 512, 'customer.full_address'); y += 34;
  T('BUILDING', M, y, { font: bold, size: 9 }); y += 22;
  label('Style & size', M, y, 250, 'shed.description'); label('Serial #', 320, y, 242, 'shed.serial'); y += 28;
  label('Colors', M, y, 512, 'shed.colors'); y += 28;
  T('Options', M, y - 13, { size: 7.5, color: muted }); F(0, 'data', M, y - 10, 512, 46, { tag: 'shed.options', required: false, fontSize: 8.5 }); y += 44;
  T(rto ? 'RENTAL TERMS' : 'PRICE', M, y, { font: bold, size: 9 }); y += 8;
  const rows = rto
    ? [['Cash price (before tax)', 'rto.cash_price'], ['Term (months)', 'rto.term_months'], ['Monthly rental', 'rto.monthly_payment'], ['Monthly sales tax', 'rto.monthly_tax'], ['Monthly damage waiver', 'rto.ldw'], ['Total monthly payment', 'rto.monthly_total'], ['Due at signing', 'rto.deposit'], ['Total of all payments to own', 'rto.total_of_payments']]
    : [['Building & options', 'pricing.subtotal'], ['Delivery', 'pricing.delivery'], ['Sales tax', 'pricing.tax'], ['Total price', 'pricing.total'], ['Deposit paid today', 'pricing.deposit'], ['Balance due at delivery', 'pricing.balance_due']];
  for (const [t, tag] of rows) { y += 17; T(t, M + 6, y); L(M, y + 4, 512); F(0, 'data', 412, y - 10, 150, 13, { tag, required: false, align: 'right' }); }
  y += 26;
  if (!rto) {
    T('3D DESIGN', M, y, { font: bold, size: 9 });
    F(0, 'rendering', M, y + 6, 250, 150, { required: false });
    F(0, 'floorplan', 312, y + 6, 250, 150, { required: false });
  } else {
    y = para('Payments are due monthly. You may own the building by making all payments, or buy it early for the payoff amount the rental company quotes you. You may return the building at any time and end the agreement; you will not owe further rent but will not get back payments already made. This is a rental-purchase agreement, not a credit sale.', y);
    T('3D DESIGN', M, y + 10, { font: bold, size: 9 });
    F(0, 'rendering', M, y + 16, 250, 140, { required: false });
    F(0, 'floorplan', 312, y + 16, 250, 140, { required: false });
  }
  T('Buyer initials', 400, H - 40, { size: 7.5, color: muted }); page.drawRectangle({ x: 460, y: 30, width: 102, height: 22, borderColor: ln, borderWidth: 0.6 });
  F(0, 'initials', 461, H - 51, 100, 20, { role: 'customer' });

  // page 2 — terms + signatures
  page = pdf.addPage([W, H]); pi = 1;
  T('TERMS AND CONDITIONS (SAMPLE)', M, 60, { font: bold, size: 11 });
  y = 84;
  const terms = rto ? [
    '1. Ownership. The building remains the property of the rental company until all payments are made or the early purchase option is exercised.',
    '2. Payments. Monthly payments are due on the same day each month. A late fee may apply as allowed by law.',
    '3. Site. Buyer will provide a level, accessible site. Additional charges may apply if the site requires blocking, leveling or special equipment.',
    '4. Damage waiver. If elected, the monthly damage waiver covers repair or replacement as described in the waiver terms.',
    '5. Return. Buyer may return the building at any time by notifying the rental company; pickup charges may apply.',
    '6. Drawings. Buyer has reviewed the 3D rendering, floor plan and elevations attached to this agreement and approves the design.',
  ] : [
    '1. Payment. The deposit is due at signing. The balance is due at delivery by cash, certified check or card.',
    '2. Build time. Build and delivery dates are estimates. Seller will contact Buyer to schedule delivery.',
    '3. Site. Buyer will provide a level, accessible site. Additional charges may apply if the site requires blocking, leveling or special equipment.',
    '4. Changes. Changes after signing may change the price and the build date and must be agreed in writing.',
    '5. Cancellation. Custom orders may not be cancelled after production starts; the deposit may be kept to cover materials.',
    '6. Drawings. Buyer has reviewed the 3D rendering, floor plan and elevations attached to this agreement and approves the design.',
  ];
  for (const t of terms) y = para(t, y) + 6;
  y += 4; page.drawRectangle({ x: M, y: H - y - 10, width: 9, height: 9, borderColor: ink, borderWidth: 0.8 });
  F(1, 'checkbox', M, y - 1, 9, 9, { role: 'customer' });
  T('I have read and agree to the terms above and approve the attached drawings.', M + 16, y + 7, { size: 9 });
  y += 30;
  T('Notes', M, y, { size: 7.5, color: muted }); F(1, 'text', M, y + 3, 512, 14, { role: 'customer', required: false, label: 'Notes for the seller (optional)' }); L(M, y + 18, 512);
  y += 60;
  const sigBlock = (title, role, x) => {
    T(title, x, y, { font: bold, size: 9 });
    L(x, y + 44, 230); T('Signature', x, y + 54, { size: 7.5, color: muted }); F(1, 'signature', x, y + 8, 230, 34, { role, required: role !== 'cobuyer' });
    L(x, y + 76, 140); T('Date', x, y + 86, { size: 7.5, color: muted }); F(1, 'date_signed', x, y + 62, 140, 13, { role, required: role !== 'cobuyer' });
  };
  sigBlock('BUYER', 'customer', M); sigBlock('CO-BUYER (if any)', 'cobuyer', 332);
  y += 120;
  sigBlock('SELLER', 'company', M);
  T('Printed name', 332, y + 30, { size: 7.5, color: muted }); L(332, y + 20, 230); F(1, 'data', 332, y + 6, 230, 13, { tag: 'sales_rep.name', required: false });
  T('This sample is for testing only. Have your attorney review your own agreement before using it with customers.', M, H - 40, { size: 7.5, color: muted });
  pdf.setTitle(rto ? 'Sample Rent-to-Own Agreement' : 'Sample Cash Purchase Agreement');
  return { bytes: await pdf.save(), fields };
}
