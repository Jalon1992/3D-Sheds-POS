// Dashboard reports: sales, leads and quotes by MTD / YTD / month / year / all years, with year-over-year comparison.
// Data: GET /api/admin/reports → one row per local day (see public/js/shared/reports.js). Charts are plain SVG.
import { $, $$, esc, api, fmt } from './admin.js';
import { sumRange, emptyDay } from '../js/shared/reports.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const C = { now: '#2a78d6', last: '#b8c0bd', cash: '#2a78d6', rto: '#eb6834', s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a' };
const METRICS = {
  sales_value: { label: 'Sales $', money: true }, sales: { label: 'Sales (count)' }, leads: { label: 'Leads' },
  quotes: { label: 'Quotes (count)' }, quote_value: { label: 'Quoted $', money: true },
};
const pad = n => String(n).padStart(2, '0');
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(Math.min(d, dim(y, m)))}`;
const money = n => fmt(Math.round(Number(n) || 0)).replace(/\.00$/, ''); // reports use whole dollars
const short = n => { const a = Math.abs(n); return a >= 1e6 ? '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : a >= 1e3 ? '$' + (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k' : '$' + Math.round(n); };
const val = (m, n) => (METRICS[m]?.money ? money(n) : Number(n || 0).toLocaleString('en-US'));
const valShort = (m, n) => (METRICS[m]?.money ? short(n) : Number(n || 0).toLocaleString('en-US'));
const rate = (a, b) => (b ? (a / b) * 100 : null);
function delta(now, prev) {
  if (prev == null) return '';
  if (!prev && !now) return '<span class="dl flat">no change</span>';
  if (!prev) return '<span class="dl up">▲ new</span>';
  const p = ((now - prev) / prev) * 100;
  if (Math.abs(p) < 0.5) return '<span class="dl flat">■ even</span>';
  return `<span class="dl ${p > 0 ? 'up' : 'down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0)}%</span>`;
}

// ---------------------------------------------------------------------------
// periods
// ---------------------------------------------------------------------------
function periodOf(st, today) {
  const [ty, tm, td] = today.split('-').map(Number);
  const y = st.year, m = st.month;
  switch (st.mode) {
    case 'mtd': return { label: `${MONTHS_LONG[tm - 1]} ${ty} to date`, short: 'MTD', from: ymd(ty, tm, 1), to: today, pFrom: ymd(ty - 1, tm, 1), pTo: ymd(ty - 1, tm, td), year: ty, month: tm, daily: true, cut: td };
    case 'ytd': return { label: `${ty} to date`, short: 'YTD', from: `${ty}-01-01`, to: today, pFrom: `${ty - 1}-01-01`, pTo: ymd(ty - 1, tm, td), year: ty, cutMonth: tm };
    case 'month': { const cur = y === ty && m === tm; return { label: `${MONTHS_LONG[m - 1]} ${y}${cur ? ' (so far)' : ''}`, short: MONTHS[m - 1] + ' ' + y, from: ymd(y, m, 1), to: ymd(y, m, 31), pFrom: ymd(y - 1, m, 1), pTo: ymd(y - 1, m, 31), year: y, month: m, daily: true, cut: cur ? td : null }; }
    case 'year': { const cur = y === ty; return { label: `${y}${cur ? ' (so far)' : ''}`, short: String(y), from: `${y}-01-01`, to: `${y}-12-31`, pFrom: `${y - 1}-01-01`, pTo: `${y - 1}-12-31`, year: y, cutMonth: cur ? tm : null }; }
    default: return { label: 'All years', short: 'All', from: '0000-01-01', to: '9999-12-31', all: true, year: ty };
  }
}

// ---------------------------------------------------------------------------
// SVG charts
// ---------------------------------------------------------------------------
function niceStep(v) { if (v <= 0) return 1; const e = 10 ** Math.floor(Math.log10(v)); const f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; }
/** Round axis: 4–5 even steps of 1/2/2.5/5 × 10ⁿ. */
function axis(v, steps = 4) { const st = niceStep(Math.max(v, 1) / steps); const max = Math.max(st, Math.ceil(Math.max(v, 1) / st) * st); const ticks = []; for (let t = 0; t <= max + st / 2; t += st) ticks.push(t); return { max, ticks }; }
function barChart({ labels, series, metric, highlight = new Set(), id }) {
  const W = 760, H = 250, L = 52, R = 10, T = 14, B = 30;
  const { max, ticks } = axis(Math.max(1, ...series.flatMap(s => s.values)));
  const n = labels.length, band = (W - L - R) / n, gap = 2, inner = Math.min(band * 0.78, 44), bw = (inner - gap * (series.length - 1)) / series.length;
  const y = v => T + (H - T - B) * (1 - v / max);
  const bars = labels.map((lab, i) => {
    const x0 = L + band * i + (band - inner) / 2;
    const marks = series.map((s, k) => { const v = s.values[i] || 0, h = Math.max(0, y(0) - y(v)), x = x0 + k * (bw + gap);
      return h ? `<path d="M${x},${y(0)} V${y(v) + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, bw / 2)},-${Math.min(4, h)} H${x + bw - Math.min(4, bw / 2)} q${Math.min(4, bw / 2)},0 ${Math.min(4, bw / 2)},${Math.min(4, h)} V${y(0)} Z" fill="${s.color}"/>` : ''; }).join('');
    return `<g>${highlight.has(i) ? `<rect x="${L + band * i + 1}" y="${T}" width="${band - 2}" height="${H - T - B}" fill="#2a78d6" opacity=".06" rx="4"/>` : ''}${marks}
      <text x="${L + band * i + band / 2}" y="${H - 10}" text-anchor="middle" class="ax ${highlight.has(i) ? 'on' : ''}">${esc(lab)}</text>
      <rect class="hit" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent"/></g>`;
  }).join('');
  const grid = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="${t ? 'gl' : 'base'}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" class="ax">${valShort(metric, t)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="img" aria-label="Bar chart" id="${id}">${grid}${bars}</svg>`;
}
function lineChart({ labels, series, metric, id }) {
  const W = 760, H = 220, L = 52, R = 70, T = 14, B = 30;
  const { max, ticks } = axis(Math.max(1, ...series.flatMap(s => s.values.filter(v => v != null))), 3);
  const n = labels.length, x = i => L + (n === 1 ? 0 : ((W - L - R) * i) / (n - 1)), y = v => T + (H - T - B) * (1 - v / max);
  const every = Math.ceil(n / 12);
  const grid = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="${t ? 'gl' : 'base'}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" class="ax">${valShort(metric, t)}</text>`).join('')
    + labels.map((l, i) => (i % every === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" class="ax">${esc(l)}</text>` : '')).join('');
  const lines = series.map(s => {
    const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
    if (!pts.length) return '';
    const last = pts.at(-1), lv = s.values.filter(v => v != null).at(-1);
    return `<path d="M${pts.map(p => p.join(',')).join(' L')}" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>
      <circle cx="${last[0]}" cy="${last[1]}" r="4.5" fill="${s.color}" stroke="#fff" stroke-width="2"/>
      <text x="${last[0] + 8}" y="${last[1] + 4}" class="endlab">${valShort(metric, lv)}</text>`;
  }).join('');
  const hits = labels.map((l, i) => `<rect class="hit" data-i="${i}" x="${x(i) - (W - L - R) / Math.max(1, n - 1) / 2}" y="${T}" width="${(W - L - R) / Math.max(1, n - 1)}" height="${H - T - B}" fill="transparent"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="img" aria-label="Running total line chart" id="${id}">${grid}${lines}<line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" hidden/>${hits}</svg>`;
}
const legend = items => `<div class="viz-legend">${items.map(([c, l, dash]) => `<span><i style="background:${dash ? 'transparent' : c};${dash ? `border-top:2px dashed ${c};height:0;width:14px;border-radius:0` : ''}"></i>${esc(l)}</span>`).join('')}</div>`;
function wireTip(card, svg, rowsFor) {
  const tip = $('.viz-tip', card); const xh = $('.xh', svg);
  svg.addEventListener('mousemove', e => {
    const h = e.target.closest('.hit'); if (!h) { tip.hidden = true; if (xh) xh.hidden = true; return; }
    tip.innerHTML = rowsFor(Number(h.dataset.i)); tip.hidden = false;
    const r = card.getBoundingClientRect(); let lx = e.clientX - r.left + 14; if (lx + tip.offsetWidth > r.width - 8) lx = e.clientX - r.left - tip.offsetWidth - 14;
    tip.style.left = lx + 'px'; tip.style.top = (e.clientY - r.top + 12) + 'px';
    if (xh) { const b = h.getBBox(); xh.setAttribute('x1', b.x + b.width / 2); xh.setAttribute('x2', b.x + b.width / 2); xh.hidden = false; }
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; if (xh) xh.hidden = true; });
}
const tipRows = (title, rows) => `<b>${esc(title)}</b>${rows.map(([c, l, v]) => `<div><i style="background:${c}"></i>${esc(l)}<span>${v}</span></div>`).join('')}`;

// ---------------------------------------------------------------------------
// page section
// ---------------------------------------------------------------------------
/** show: { sales, leads } — sales figures need Point of sale, lead figures need the CRM. Quotes are always shown. */
export async function renderReports(host, show = { sales: true, leads: true }) {
  const metricOk = k => (k.startsWith('sales') ? show.sales : k === 'leads' ? show.leads : true);
  const metrics = Object.fromEntries(Object.entries(METRICS).filter(([k]) => metricOk(k)));
  let st = { mode: 'mtd', metric: show.sales ? 'sales_value' : 'quotes', compare: true, dealer: '' };
  try { st = { ...st, ...JSON.parse(localStorage.getItem('sb-report') || '{}') }; } catch { /* */ }
  if (!metricOk(st.metric)) st.metric = show.sales ? 'sales_value' : 'quotes';
  let data = null;
  const load = async () => { data = await api('GET', '/api/admin/reports' + (st.dealer ? '?dealer=' + encodeURIComponent(st.dealer) : '')); };
  await load();
  const [ty, tm] = data.today.split('-').map(Number);
  st.year ||= ty; st.month ||= tm;
  const years = () => { const ys = new Set([ty]); for (const r of data.days) ys.add(Number(r.d.slice(0, 4))); return [...ys].sort((a, b) => b - a); };

  const draw = () => {
    try { localStorage.setItem('sb-report', JSON.stringify({ mode: st.mode, metric: st.metric, compare: st.compare, dealer: st.dealer })); } catch { /* */ }
    const P = periodOf(st, data.today), days = data.days;
    const cur = sumRange(days, P.from, P.to), prev = P.all ? null : sumRange(days, P.pFrom, P.pTo);
    const cmp = st.compare && !P.all;
    const tiles0 = [
      ['Sales', money(cur.sales_value), `${cur.sales} sold · ${cur.cash} cash · ${cur.rto} rent-to-own`, cmp ? [cur.sales_value, prev.sales_value, money(prev.sales_value)] : null],
      ['Leads', cur.leads.toLocaleString(), `${cur.leads_3d} from the 3D builder`, cmp ? [cur.leads, prev.leads, prev.leads] : null],
      ['Quotes', cur.quotes.toLocaleString(), `${money(cur.quote_value)} quoted`, cmp ? [cur.quotes, prev.quotes, prev.quotes] : null],
      ['Close rate', rate(cur.sales, cur.quotes) == null ? '—' : rate(cur.sales, cur.quotes).toFixed(0) + '%', 'sales ÷ quotes', cmp ? [rate(cur.sales, cur.quotes) || 0, rate(prev.sales, prev.quotes) ?? null, rate(prev.sales, prev.quotes) == null ? '—' : rate(prev.sales, prev.quotes).toFixed(0) + '%'] : null],
      ['Average sale', cur.sales ? money(cur.sales_value / cur.sales) : '—', 'per signed contract', cmp ? [cur.sales ? cur.sales_value / cur.sales : 0, prev.sales ? prev.sales_value / prev.sales : null, prev.sales ? money(prev.sales_value / prev.sales) : '—'] : null],
    ];
    const tiles = tiles0.filter(([t]) => (['Sales', 'Close rate', 'Average sale'].includes(t) ? show.sales : t === 'Leads' ? show.leads : true));
    // chart A: month by month (or year by year)
    let labels, nowV, lastV, hl = new Set(), titleA;
    const m = st.metric;
    if (P.all) {
      const ys = years().slice().reverse(); labels = ys.map(String);
      nowV = ys.map(yy => sumRange(days, `${yy}-01-01`, `${yy}-12-31`)[m]); lastV = null; titleA = 'Year by year'; hl.add(ys.indexOf(ty));
    } else {
      labels = MONTHS;
      nowV = MONTHS.map((_, i) => sumRange(days, ymd(P.year, i + 1, 1), ymd(P.year, i + 1, 31))[m]);
      lastV = MONTHS.map((_, i) => sumRange(days, ymd(P.year - 1, i + 1, 1), ymd(P.year - 1, i + 1, 31))[m]);
      titleA = `Month by month · ${P.year}${cmp ? ' vs ' + (P.year - 1) : ''}`;
      if (P.month) hl.add(P.month - 1); else if (P.cutMonth) for (let i = 0; i < P.cutMonth; i++) hl.add(i); else for (let i = 0; i < 12; i++) hl.add(i);
    }
    const seriesA = [{ name: P.all ? 'Total' : String(P.year), color: C.now, values: nowV }, ...(cmp && lastV ? [{ name: String(P.year - 1), color: C.last, values: lastV }] : [])];
    // chart B: running total
    let lineLabels = [], runNow = [], runLast = [];
    if (!P.all) {
      if (P.daily) {
        const nd = dim(P.year, P.month); let a = 0, b = 0;
        const byDay = new Map(days.map(r => [r.d, r]));
        for (let d = 1; d <= nd; d++) {
          lineLabels.push(`${MONTHS[P.month - 1]} ${d}`);
          a += byDay.get(ymd(P.year, P.month, d))?.[m] || 0; b += d <= dim(P.year - 1, P.month) ? (byDay.get(ymd(P.year - 1, P.month, d))?.[m] || 0) : 0;
          runNow.push(P.cut && d > P.cut ? null : a); runLast.push(b);
        }
      } else {
        let a = 0, b = 0;
        for (let i = 0; i < 12; i++) { lineLabels.push(MONTHS[i]); a += nowV[i]; b += lastV[i]; runNow.push(P.cutMonth && i + 1 > P.cutMonth ? null : a); runLast.push(b); }
      }
    }
    // mix + sources
    const mixTot = cur.cash_value + cur.rto_value;
    const srcs = [['3D builder', cur.leads_3d, C.s1], ['Walk-in, phone & manual', cur.leads_manual, C.s2], ['Texts & emails', cur.leads_msg, C.s3]];
    const srcMax = Math.max(1, ...srcs.map(s => s[1]));
    // tables
    const ys = years();
    const yRows = ys.map(yy => {
      const isCur = yy === ty; const to = isCur ? data.today : `${yy}-12-31`;
      const r = sumRange(days, `${yy}-01-01`, to); const p = sumRange(days, `${yy - 1}-01-01`, isCur ? ymd(yy - 1, tm, Number(data.today.slice(8))) : `${yy - 1}-12-31`);
      return { yy, isCur, r, p };
    });
    const mRows = P.all ? [] : MONTHS.map((mm, i) => ({ mm, i, r: sumRange(days, ymd(P.year, i + 1, 1), ymd(P.year, i + 1, 31)), p: sumRange(days, ymd(P.year - 1, i + 1, 1), ymd(P.year - 1, i + 1, 31)) }));

    if (!document.body.contains(host)) return; // left the dashboard while it was loading
    host.innerHTML = `<div class="rep">
      <div class="rep-bar">
        <div class="seg" role="tablist" aria-label="Period">${[['mtd', 'Month to date'], ['ytd', 'Year to date'], ['month', 'Month'], ['year', 'Year'], ['all', 'All years']].map(([k, l]) => `<button role="tab" aria-selected="${st.mode === k}" class="${st.mode === k ? 'on' : ''}" data-mode="${k}">${l}</button>`).join('')}</div>
        ${st.mode === 'month' ? `<select class="in sel" id="rMonth">${MONTHS_LONG.map((l, i) => `<option value="${i + 1}" ${i + 1 === st.month ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
        ${['month', 'year'].includes(st.mode) ? `<select class="in sel" id="rYear">${years().map(yy => `<option ${yy === st.year ? 'selected' : ''}>${yy}</option>`).join('')}</select>` : ''}
        ${!P.all ? `<label class="chk" style="font-size:13px"><input type="checkbox" id="rCmp" ${st.compare ? 'checked' : ''}>Compare with last year</label>` : ''}
        ${data.dealers.length ? `<select class="in sel" id="rLot" style="margin-left:auto"><option value="">All lots</option>${data.dealers.map(d => `<option value="${esc(d.id)}" ${String(d.id) === st.dealer ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
      </div>
      <p class="rep-period"><b>${esc(P.label)}</b>${cmp ? ` · compared with the same dates in ${P.year - 1}` : ''}</p>
      <div class="kpis">${tiles.map(([t, v, sub, c]) => `<div class="card kpi"><div class="lbl">${t}</div><div class="val">${v}</div><div class="sub">${esc(sub)}</div>${c ? `<div class="cmp">${delta(c[0], c[1])}<span>${P.year - 1}: ${esc(String(c[2]))}</span></div>` : ''}</div>`).join('')}</div>
      <div class="card card-pad viz-card" id="cardA"><div class="viz-head"><h2>${esc(titleA)}</h2>
        <div class="seg sm" role="tablist" aria-label="Measure">${Object.entries(metrics).map(([k, v]) => `<button class="${st.metric === k ? 'on' : ''}" data-metric="${k}">${v.label}</button>`).join('')}</div></div>
        ${legend(seriesA.map(s => [s.color, s.name]))}${barChart({ labels, series: seriesA, metric: m, highlight: hl, id: 'vizA' })}<div class="viz-tip" hidden></div></div>
      ${P.all ? '' : `<div class="card card-pad viz-card" id="cardB"><div class="viz-head"><h2>Running total · ${esc(METRICS[m].label)} · ${esc(P.daily ? MONTHS_LONG[P.month - 1] : 'January to December')}</h2></div>
        ${legend([[C.now, String(P.year)], ...(cmp ? [[C.last, String(P.year - 1), true]] : [])])}${lineChart({ labels: lineLabels, series: [{ color: C.now, values: runNow }, ...(cmp ? [{ color: '#8a9490', values: runLast, dash: true }] : [])], metric: m, id: 'vizB' })}<div class="viz-tip" hidden></div></div>`}
      <div class="grid g2">
        ${show.sales ? '' : '<!--'}<div class="card card-pad"><h2>Sales mix · ${esc(P.short)}</h2><p class="muted" style="margin:2px 0 12px">Signed sales by how the customer pays</p>
          ${mixTot ? `<div class="mixbar">${cur.cash_value ? `<div style="flex:${cur.cash_value};background:${C.cash}"></div>` : ''}${cur.rto_value ? `<div style="flex:${cur.rto_value};background:${C.rto}"></div>` : ''}</div>
          <div class="mixlab"><div><i style="background:${C.cash}"></i>Cash <b>${money(cur.cash_value)}</b> · ${cur.cash} sale${cur.cash === 1 ? '' : 's'} · ${(cur.cash_value / mixTot * 100).toFixed(0)}%</div><div><i style="background:${C.rto}"></i>Rent to own <b>${money(cur.rto_value)}</b> · ${cur.rto} sale${cur.rto === 1 ? '' : 's'} · ${(cur.rto_value / mixTot * 100).toFixed(0)}%</div></div>` : '<div class="muted">No signed sales in this period yet.</div>'}</div>
        ${show.sales ? '' : '-->'}${show.leads ? '' : '<!--'}<div class="card card-pad"><h2>Where leads came from · ${esc(P.short)}</h2><p class="muted" style="margin:2px 0 12px">${cur.leads} new lead${cur.leads === 1 ? '' : 's'}</p>
          ${srcs.map(([l, n, c]) => `<div class="hbar"><span>${esc(l)}</span><div><i style="width:${(n / srcMax) * 100}%;background:${c}"></i></div><b>${n}</b></div>`).join('')}</div>${show.leads ? '' : '-->'}
      </div>
      <div class="card"><div class="card-pad" style="padding-bottom:6px"><h2>Year over year</h2><p class="muted" style="margin:2px 0 0">${ty} is year to date and compared with the same dates in ${ty - 1}</p></div>
        <div class="tbl-wrap"><table class="tbl"><tr><th>Year</th><th class="num">Leads</th><th class="num">Quotes</th><th class="num">Quoted $</th><th class="num">Sales</th><th class="num">Sales $</th><th class="num">Close rate</th><th class="num">Sales $ vs prior</th></tr>
        ${yRows.map(({ yy, isCur, r, p }) => `<tr><td><b>${yy}</b>${isCur ? ' <span class="pill">YTD</span>' : ''}</td><td class="num">${r.leads}</td><td class="num">${r.quotes}</td><td class="num">${money(r.quote_value)}</td><td class="num">${r.sales}</td><td class="num"><b>${money(r.sales_value)}</b></td><td class="num">${rate(r.sales, r.quotes) == null ? '—' : rate(r.sales, r.quotes).toFixed(0) + '%'}</td><td class="num">${yy > ys.at(-1) ? delta(r.sales_value, p.sales_value) : '<span class="muted">—</span>'}</td></tr>`).join('')}</table></div></div>
      ${P.all ? '' : `<div class="card"><div class="card-pad" style="padding-bottom:6px"><h2>${P.year} by month</h2></div><div class="tbl-wrap"><table class="tbl"><tr><th>Month</th><th class="num">Leads</th><th class="num">Quotes</th><th class="num">Quoted $</th><th class="num">Sales</th><th class="num">Cash</th><th class="num">RTO</th><th class="num">Sales $</th><th class="num">vs ${P.year - 1}</th></tr>
        ${mRows.map(({ mm, i, r, p }) => `<tr class="${hl.has(i) && P.month ? 'hl' : ''}"><td>${mm}</td><td class="num">${r.leads}</td><td class="num">${r.quotes}</td><td class="num">${money(r.quote_value)}</td><td class="num">${r.sales}</td><td class="num">${r.cash}</td><td class="num">${r.rto}</td><td class="num"><b>${money(r.sales_value)}</b></td><td class="num">${(P.year === ty && i + 1 > tm) || P.year > ty ? '<span class="muted">not yet</span>' : r.sales_value || p.sales_value ? delta(r.sales_value, p.sales_value) : '<span class="muted">—</span>'}</td></tr>`).join('')}
        <tr class="tot"><td>Total</td>${['leads', 'quotes'].map(k => `<td class="num">${mRows.reduce((a, x) => a + x.r[k], 0)}</td>`).join('')}<td class="num">${money(mRows.reduce((a, x) => a + x.r.quote_value, 0))}</td>${['sales', 'cash', 'rto'].map(k => `<td class="num">${mRows.reduce((a, x) => a + x.r[k], 0)}</td>`).join('')}<td class="num"><b>${money(mRows.reduce((a, x) => a + x.r.sales_value, 0))}</b></td><td></td></tr></table></div></div>`}
    </div>`;

    // drop table columns for modules this install doesn't have
    const hideCol = t => (!show.sales && (['Sales', 'Sales $', 'Close rate', 'Sales $ vs prior', 'Cash', 'RTO'].includes(t) || /^vs \d{4}$/.test(t))) || (!show.leads && t === 'Leads');
    for (const tbl of $$('table', host)) {
      const heads = [...tbl.rows[0].cells].map(c => c.textContent.trim()), drop = heads.map(hideCol);
      if (!drop.some(Boolean)) continue;
      for (const row of [...tbl.rows]) if (row.cells.length === heads.length) for (let i = heads.length - 1; i >= 0; i--) if (drop[i]) row.deleteCell(i);
    }
    $$('[data-mode]', host).forEach(b => (b.onclick = () => { st.mode = b.dataset.mode; if (st.mode === 'month' && !st.month) st.month = tm; draw(); }));
    $$('[data-metric]', host).forEach(b => (b.onclick = () => { st.metric = b.dataset.metric; draw(); }));
    if ($('#rMonth', host)) $('#rMonth', host).onchange = e => { st.month = Number(e.target.value); draw(); };
    if ($('#rYear', host)) $('#rYear', host).onchange = e => { st.year = Number(e.target.value); draw(); };
    if ($('#rCmp', host)) $('#rCmp', host).onchange = e => { st.compare = e.target.checked; draw(); };
    if ($('#rLot', host)) $('#rLot', host).onchange = async e => { st.dealer = e.target.value; await load(); draw(); };
    wireTip($('#cardA', host), $('#vizA', host), i => tipRows(P.all ? labels[i] : `${MONTHS_LONG[i]}`, seriesA.map(s => [s.color, s.name, val(m, s.values[i])])));
    if (!P.all) wireTip($('#cardB', host), $('#vizB', host), i => tipRows(`Through ${lineLabels[i]}`, [[C.now, String(P.year), runNow[i] == null ? '—' : val(m, runNow[i])], ...(cmp ? [['#8a9490', String(P.year - 1), val(m, runLast[i])]] : [])]));
  };
  draw();
  return { reload: async () => { await load(); draw(); } };
}
export { emptyDay };
