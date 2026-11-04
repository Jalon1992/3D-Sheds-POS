// Shared by the server (contract PDFs) and the admin (template designer + contract wizard).

/** Field types you can place on a contract template. */
export const FIELD_TYPES = {
  signature: { label: 'Signature', signer: true, w: 0.26, h: 0.045 },
  initials: { label: 'Initials', signer: true, w: 0.08, h: 0.035 },
  date_signed: { label: 'Date signed', signer: true, w: 0.14, h: 0.025 },
  text: { label: 'Text box (signer fills in)', signer: true, w: 0.22, h: 0.025 },
  checkbox: { label: 'Checkbox (signer ticks)', signer: true, w: 0.022, h: 0.017 },
  data: { label: 'Auto-filled info', signer: false, w: 0.26, h: 0.022 },
  rendering: { label: '3D rendering image', signer: false, w: 0.4, h: 0.22 },
  floorplan: { label: 'Floor plan image', signer: false, w: 0.4, h: 0.3 },
};
export const SIGNER_ROLES = [['customer', 'Customer'], ['cobuyer', 'Co-buyer'], ['company', 'Company / sales rep']];
export const SALE_TYPES = [['cash', 'Cash sale'], ['rto', 'Rent to own']];
export const saleTypeLabel = t => (t === 'rto' ? 'Rent to Own' : t === 'cash' ? 'Cash' : 'Cash or Rent to Own');

/** Auto-filled info you can drop onto a template. Use "custom:<name>" for a value the rep types when creating the contract. */
export const TAGS = [
  ['Contract', [['contract.number', 'Contract number'], ['contract.date', 'Contract date'], ['contract.sale_type', 'Sale type (Cash / Rent to Own)'], ['quote.number', 'Quote number']]],
  ['Customer', [['customer.full_name', 'Customer full name'], ['customer.first_name', 'First name'], ['customer.last_name', 'Last name'], ['customer.email', 'Email'], ['customer.phone', 'Phone'],
    ['customer.address', 'Street address'], ['customer.city', 'City'], ['customer.state', 'State'], ['customer.zip', 'ZIP'], ['customer.city_state_zip', 'City, State ZIP'], ['customer.full_address', 'Full address (one line)']]],
  ['Co-buyer', [['cobuyer.full_name', 'Co-buyer name'], ['cobuyer.email', 'Co-buyer email'], ['cobuyer.phone', 'Co-buyer phone']]],
  ['Building', [['shed.style', 'Style'], ['shed.size', 'Size'], ['shed.description', 'Style + size + roofing'], ['shed.roofing', 'Roofing'], ['shed.siding_color', 'Siding color'], ['shed.trim_color', 'Trim color'],
    ['shed.roof_color', 'Roof color'], ['shed.door_color', 'Door color'], ['shed.options', 'Options (list)'], ['shed.colors', 'Colors (one line)'], ['shed.serial', 'Serial number']]],
  ['Price', [['pricing.base', 'Base building price'], ['pricing.options_total', 'Options total'], ['pricing.subtotal', 'Subtotal'], ['pricing.delivery', 'Delivery'], ['pricing.tax', 'Sales tax'], ['pricing.tax_rate', 'Tax rate %'],
    ['pricing.total', 'Total (cash price incl. tax)'], ['pricing.deposit', 'Deposit / down payment'], ['pricing.balance_due', 'Balance due'], ['pricing.line_items', 'Itemized price list']]],
  ['Rent to own', [['rto.term_months', 'Term (months)'], ['rto.cash_price', 'Cash price (before tax)'], ['rto.monthly_payment', 'Monthly rental (before tax)'], ['rto.monthly_tax', 'Monthly tax'],
    ['rto.ldw', 'Monthly damage waiver (LDW)'], ['rto.monthly_total', 'Total monthly payment'], ['rto.deposit', 'Due at signing (security deposit / first payment)'], ['rto.total_of_payments', 'Total of all payments'], ['rto.first_payment_date', 'First payment due'], ['rto.company', 'RTO company name']]],
  ['Seller', [['company.name', 'Company name'], ['company.phone', 'Company phone'], ['company.address', 'Company address'], ['company.website', 'Website'], ['dealer.name', 'Dealer lot name'], ['dealer.address', 'Dealer lot address'], ['dealer.phone', 'Dealer lot phone'], ['sales_rep.name', 'Sales rep name'], ['sales_rep.email', 'Sales rep email']]],
];
export const TAG_LABEL = Object.fromEntries(TAGS.flatMap(([, l]) => l));
export const tagLabel = t => (String(t).startsWith('custom:') ? String(t).slice(7) : TAG_LABEL[t] || t);
export const lookup = (data, tag) => {
  if (!tag) return '';
  if (String(tag).startsWith('custom:')) return data?.custom?.[String(tag).slice(7)] ?? '';
  const v = String(tag).split('.').reduce((o, k) => (o == null ? o : o[k]), data);
  return v == null ? '' : String(v);
};

/** Default rent-to-own setup. Replace with your RTO company's rate sheet in Admin → Point of sale → Settings. */
export const DEFAULT_RTO = {
  company: '', terms: [{ months: 24, factor: 1.4 }, { months: 36, factor: 1.6 }, { months: 48, factor: 1.75 }, { months: 60, factor: 1.9 }],
  deposit_payments: 1, ldw_monthly: 0, tax_rate: null, default_term: 36,
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
/**
 * Monthly rent-to-own numbers for a cash price (before tax).
 * monthly rental = cash price × term factor ÷ months; tax on the rental; due at signing = N monthly payments.
 */
export function rtoCalc(cashPrice, months, rto = DEFAULT_RTO, fallbackTax = 0, overrideMonthly = null) {
  const terms = rto?.terms?.length ? rto.terms : DEFAULT_RTO.terms;
  const term = terms.find(t => Number(t.months) === Number(months)) || terms.find(t => Number(t.months) === Number(rto?.default_term)) || terms[0];
  const m = Number(term.months);
  const monthly = overrideMonthly > 0 ? r2(overrideMonthly) : r2((Number(cashPrice) || 0) * Number(term.factor || 1) / m);
  const taxRate = rto?.tax_rate == null || rto.tax_rate === '' ? Number(fallbackTax) || 0 : Number(rto.tax_rate);
  const monthly_tax = r2(monthly * taxRate / 100);
  const ldw = r2(rto?.ldw_monthly || 0);
  const monthly_total = r2(monthly + monthly_tax + ldw);
  const depN = Number(rto?.deposit_payments ?? 1);
  return { term_months: m, factor: Number(term.factor), cash_price: r2(cashPrice), monthly_payment: monthly, tax_rate: taxRate, monthly_tax, ldw, monthly_total, deposit: r2(monthly_total * depN), total_of_payments: r2(monthly_total * m) };
}
export const usd = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Initials box drawn on each drawing sheet of a contract (fractions of a US Letter landscape page). */
export const DRAWING_INITIALS_BOX = { x: 640 / 792, y: 548 / 612, w: 120 / 792, h: 34 / 612 };
