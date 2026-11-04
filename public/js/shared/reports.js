// Sales / leads / quotes reporting. Shared by the server (/api/admin/reports) and the in-browser demo.
// Input rows are plain records; output is one row per local calendar day that had activity.

const DAY_FIELDS = ['leads', 'leads_3d', 'leads_manual', 'leads_msg', 'quotes', 'quote_value', 'sales', 'sales_value', 'cash', 'cash_value', 'rto', 'rto_value'];
export const emptyDay = () => Object.fromEntries(DAY_FIELDS.map(k => [k, 0]));

/** 'YYYY-MM-DD HH:MM:SS' (UTC, as SQLite stores it) → local 'YYYY-MM-DD' in the company's time zone. */
export function localDay(ts, tz = 'America/Chicago') {
  if (!ts) return null;
  const d = new Date(String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z'));
  if (isNaN(d)) return null;
  try { return d.toLocaleDateString('en-CA', { timeZone: tz }); } catch { return d.toISOString().slice(0, 10); }
}
const leadBucket = src => (/configurator|3d/i.test(src || '') ? 'leads_3d' : /inbound/i.test(src || '') ? 'leads_msg' : 'leads_manual');

/**
 * @param contacts  [{created_at, source, dealer_id}]
 * @param quotes    [{created_at, total, dealer_id}]
 * @param contracts [{id, group_id, revision, status, sale_type, total, completed_at, dealer_id}]
 *   A sale is counted once per contract (all its revisions): on the day it was first fully signed,
 *   at the value of its latest signed version. Sales whose latest version was voided are left out.
 */
export function dailyReport({ contacts = [], quotes = [], contracts = [], tz, dealer = '' }) {
  const days = new Map();
  const day = d => { if (!days.has(d)) days.set(d, { d, ...emptyDay() }); return days.get(d); };
  const lotOk = r => !dealer || String(r.dealer_id ?? '') === String(dealer);
  for (const c of contacts) { if (!lotOk(c)) continue; const d = localDay(c.created_at, tz); if (!d) continue; const r = day(d); r.leads++; r[leadBucket(c.source)]++; }
  for (const q of quotes) { if (!lotOk(q)) continue; const d = localDay(q.created_at, tz); if (!d) continue; const r = day(d); r.quotes++; r.quote_value += Number(q.total) || 0; }
  const groups = new Map();
  for (const k of contracts) { if (!lotOk(k)) continue; const g = k.group_id || k.id; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(k); }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.revision || 1) - (b.revision || 1));
    const latest = list.at(-1);
    if (latest.status === 'void') continue;
    const signed = list.filter(k => k.completed_at);
    if (!signed.length) continue;
    const first = signed.reduce((a, b) => (a.completed_at < b.completed_at ? a : b));
    const last = signed.at(-1);
    const d = localDay(first.completed_at, tz); if (!d) continue;
    const r = day(d), v = Number(last.total) || 0, t = last.sale_type === 'rto' ? 'rto' : 'cash';
    r.sales++; r.sales_value += v; r[t]++; r[t + '_value'] += v;
  }
  return [...days.values()].sort((a, b) => a.d.localeCompare(b.d)).map(r => ({ ...r, quote_value: Math.round(r.quote_value * 100) / 100, sales_value: Math.round(r.sales_value * 100) / 100, cash_value: Math.round(r.cash_value * 100) / 100, rto_value: Math.round(r.rto_value * 100) / 100 }));
}

/** Sum the day rows between two 'YYYY-MM-DD' dates (inclusive). */
export function sumRange(days, from, to) {
  const out = emptyDay();
  for (const r of days) if (r.d >= from && r.d <= to) for (const k of DAY_FIELDS) out[k] += r[k] || 0;
  return out;
}
