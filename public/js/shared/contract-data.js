// Builds the values a contract template can show. Shared by the server and the in-browser demo.
import { usd, saleTypeLabel } from './contract.js';

const toE164 = raw => { if (!raw) return null; const t = String(raw).trim(), d = t.replace(/\D/g, ''); if (t.startsWith('+') && d.length >= 8 && d.length <= 15) return '+' + d; if (d.length === 10) return '+1' + d; if (d.length === 11 && d[0] === '1') return '+' + d; return null; };
const prettyPhone = e => { const d = String(e || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : e; };
export function signerFirst(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }
function tzDate(tz, d = new Date()) { try { return d.toLocaleDateString('en-US', { timeZone: tz || 'America/Chicago' }); } catch { return d.toLocaleDateString('en-US'); } }

/** Everything a template can show, as display strings (raw numbers are kept under .raw). */
export function buildData({ q, fq, contact, sale_type, signers, rto, cash, custom, user, number, s }) {
  const p = q?.pricing || {}, lines = p.lines || [];
  const cust = signers.customer || {};
  const [cf, ...cl] = String(cust.name || '').trim().split(/\s+/);
  const addr = contact || q || {};
  const csz = [addr.city, [addr.state, addr.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const dealer = q?.dealer_id ? (s.dealers || []).find(d => String(d.id) === String(q.dealer_id)) || { name: q.dealer_name } : null;
  const colors = fq?.shed?.colors || {};
  const options = (fq?.options || []).filter(o => !String(o.name).startsWith('Removed:'));
  const base = lines.find(l => l.type === 'base')?.amount || 0;
  const subtotal = Number(p.subtotal) || 0, delivery = Number(p.delivery) || 0, tax = Number(p.tax) || 0, total = Number(p.total ?? q?.total) || 0;
  const deposit = sale_type === 'cash' ? Math.max(0, Number(cash?.deposit) || 0) : 0;
  const R = sale_type === 'rto' ? rto : null;
  const data = {
    contract: { number, date: tzDate(s.timezone), sale_type: saleTypeLabel(sale_type) },
    quote: { number: q?.number || '' },
    customer: {
      full_name: cust.name || [addr.first_name, addr.last_name].filter(Boolean).join(' '), first_name: cf || addr.first_name || '', last_name: cl.join(' ') || addr.last_name || '',
      email: cust.email || addr.email || '', phone: prettyPhone(toE164(cust.phone || addr.phone)) || cust.phone || addr.phone || '',
      address: addr.address || '', city: addr.city || '', state: addr.state || '', zip: addr.zip || '', city_state_zip: csz, full_address: [addr.address, csz].filter(Boolean).join(', '),
    },
    cobuyer: { full_name: signers.cobuyer?.name || '', email: signers.cobuyer?.email || '', phone: signers.cobuyer?.phone || '' },
    shed: {
      style: q?.style_name || '', size: q?.size_label || '', roofing: fq?.shed?.roofing || '',
      description: [q?.style_name, q?.size_label, fq?.shed?.roofing ? `(${fq.shed.roofing})` : ''].filter(Boolean).join(' '),
      siding_color: colors.siding || '', trim_color: colors.trim || '', roof_color: colors.roof || '', door_color: colors.door || '',
      colors: Object.entries(colors).map(([k, v]) => `${k[0].toUpperCase() + k.slice(1)}: ${v}`).join(' · '),
      options: options.map(o => `${o.name}${o.wall ? ` (${o.wall})` : ''}${o.note === 'Standard' ? ' - standard' : ''}`).join(', ') || 'None',
      serial: custom?.serial_number || '',
    },
    pricing: {
      base: usd(base), options_total: usd(subtotal - base), subtotal: usd(subtotal), delivery: usd(delivery), tax: usd(tax), tax_rate: p.tax_rate != null ? `${p.tax_rate}%` : '',
      total: usd(total), deposit: usd(deposit), balance_due: usd(Math.max(0, total - deposit)),
      line_items: lines.filter(l => !(l.type === 'color' && !l.amount)).map(l => `${l.label}: ${l.note === 'Standard' ? 'Included' : usd(l.amount)}`).concat(delivery ? [`Delivery: ${usd(delivery)}`] : [], tax ? [`Sales tax: ${usd(tax)}`] : [], [`Total: ${usd(total)}`]).join('\n'),
    },
    rto: R ? {
      term_months: String(R.term_months), cash_price: usd(R.cash_price), monthly_payment: usd(R.monthly_payment), monthly_tax: usd(R.monthly_tax), ldw: usd(R.ldw),
      monthly_total: usd(R.monthly_total), deposit: usd(R.deposit), total_of_payments: usd(R.total_of_payments), first_payment_date: R.first_payment_date || '', company: s.rto?.company || '',
    } : {},
    company: { name: s.company_name || '', phone: s.phone || '', address: s.company_address || '', website: s.website || '' },
    dealer: dealer ? { name: dealer.name || '', address: dealer.address || '', phone: dealer.phone || '' } : { name: '', address: '', phone: '' },
    sales_rep: { name: user?.name || user?.email || '', email: user?.email || '' },
    custom: custom || {},
    raw: { subtotal, delivery, tax, total, deposit, rto: R },
  };
  return data;
}
