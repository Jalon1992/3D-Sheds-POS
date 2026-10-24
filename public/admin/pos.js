// Point of sale: contracts, the new-contract wizard (Cash / Rent to Own), contract detail (send by text/email,
// sign in person, download), contract templates + the drag-and-drop field designer, and POS settings.
import { $, $$, esc, api, toast, guard, openModal, closeModal, confirmBox, fmt, fmtDate, saveFile, head, me, settings, can, isAdmin, onLive, hashQuery, loadCatalog, catalog, COPY, TRASH , planUrl } from './admin.js';
import { buildDrawingPackage, render3D, floorPlanPNG } from '../js/drawings.js';
import { FIELD_TYPES, SIGNER_ROLES, TAGS, tagLabel, rtoCalc, usd, saleTypeLabel, DEFAULT_RTO } from '../js/shared/contract.js';

const STATUS = { draft: 'Draft', sent: 'Sent', viewed: 'Opened', partial: 'Partly signed', completed: 'Signed', void: 'Void' };
const ROLE = Object.fromEntries(SIGNER_ROLES);
const fullName = c => [c?.first_name, c?.last_name].filter(Boolean).join(' ');
const tabs = active => `<div class="tabs"><button data-tab="#/pos" class="${active === 'contracts' ? 'on' : ''}">Contracts</button><button data-tab="#/pos/templates" class="${active === 'templates' ? 'on' : ''}">Templates</button>${isAdmin() ? `<button data-tab="#/pos/settings" class="${active === 'settings' ? 'on' : ''}">Rent-to-own &amp; contract settings</button>` : ''}</div>`;
const wireTabs = () => $$('[data-tab]').forEach(b => (b.onclick = () => { location.hash = b.dataset.tab; }));

export async function posPage(arg, rest = []) {
  if (arg === 'new') return wizard();
  if (arg === 'contracts' && rest[1]) return contractDetail(Number(rest[1]));
  if (arg === 'templates' && rest[1]) return designer(Number(rest[1]));
  if (arg === 'templates') return templatesPage();
  if (arg === 'settings') return posSettings();
  return contractsPage();
}

// ---------------------------------------------------------------------------
// Contracts list
// ---------------------------------------------------------------------------
async function contractsPage() {
  const st = hashQuery().get('status') || '';
  $('#main').innerHTML = head('Point of sale', 'Write up Cash and Rent-to-Own contracts from any 3D design, send them by text or email for e-signature, or sign in person.', '<a class="btn primary" href="#/pos/new">+ New contract</a>') + tabs('contracts') + `
    <div class="row" style="margin-bottom:12px"><input class="in" id="kq" placeholder="Search customer or contract #" style="max-width:300px">
      <select class="in" id="ks" style="max-width:200px"><option value="">All contracts</option>${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === st ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="in" id="kt" style="max-width:170px"><option value="">Cash &amp; RTO</option><option value="cash">Cash</option><option value="rto">Rent to own</option></select></div>
    <div class="card tbl-wrap" id="ktable"><div class="empty">Loading…</div></div>`;
  wireTabs();
  const render = async () => {
    const p = new URLSearchParams({ q: $('#kq').value, status: $('#ks').value, sale_type: $('#kt').value });
    const rows = await api('GET', '/api/pos/contracts?' + p);
    $('#ktable').innerHTML = rows.length ? `<table class="tbl"><tr><th>Contract</th><th>Customer</th><th>Building</th><th>Type</th><th class="num">Price</th><th>Status</th><th>Created</th></tr>${rows.map(k => `<tr class="click" data-id="${k.id}">
      <td><b>${esc(k.number)}</b><div class="muted" style="font-size:12px">${esc(k.template_name || '')}</div></td>
      <td>${esc(k.customer || fullName(k))}<div class="muted" style="font-size:12px">${esc(k.phone || k.email || '')}</div></td><td>${esc(k.shed || '')}</td>
      <td><span class="pill ${esc(k.sale_type)}">${k.sale_type === 'rto' ? 'Rent to own' : 'Cash'}</span>${k.monthly ? `<div class="muted" style="font-size:12px">${esc(k.monthly)}/mo</div>` : ''}</td>
      <td class="num"><b>${fmt(k.total)}</b></td>
      <td><span class="pill ${esc(k.status)}">${esc(STATUS[k.status] || k.status)}</span>${k.status !== 'void' && k.status !== 'draft' ? `<div class="muted" style="font-size:12px">${k.signed}/${k.signers} signed</div>` : ''}</td>
      <td class="muted">${fmtDate(k.created_at)}<div style="font-size:12px">${esc(k.created_by_name || '')}</div></td></tr>`).join('')}</table>`
      : `<div class="empty">No contracts yet. Click <b>+ New contract</b>, or open a quote and click <b>Start contract</b>.</div>`;
  };
  let t; $('#kq').oninput = () => { clearTimeout(t); t = setTimeout(guard(render), 250); };
  $('#ks').onchange = $('#kt').onchange = guard(render);
  $('#ktable').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = `#/pos/contracts/${tr.dataset.id}`; };
  onLive(type => { if (type === 'contract') render().catch(() => {}); });
  await render();
}

// ---------------------------------------------------------------------------
// New contract wizard
// ---------------------------------------------------------------------------
async function wizard() {
  const qp = hashQuery();
  const meta = await api('GET', '/api/pos/meta');
  const staff = (await api('GET', '/api/crm/users')).filter(u => ['admin', 'sales'].includes(u.role));
  const S = { quote: null, contact: null, sale_type: 'cash', template_id: null, cob: false, custom: {} };
  if (qp.get('quote')) S.quote = await api('GET', `/api/v1/quotes/${Number(qp.get('quote'))}`);
  const cid = qp.get('contact') || S.quote?.contact_id;
  if (cid && can('crm.view')) S.contact = await api('GET', `/api/crm/contacts/${Number(cid)}`).catch(() => null);
  if (!S.quote && S.contact?.quotes?.length) S.quote = await api('GET', `/api/v1/quotes/${S.contact.quotes[0].id}`);
  if (!meta.templates.some(t => t.sale_type === 'cash' || t.sale_type === 'any') && meta.templates.some(t => t.sale_type === 'rto')) S.sale_type = 'rto';

  const cust = S.quote?.customer || S.contact || {};
  const total = () => Number(S.quote?.pricing?.total) || 0;
  const cashPrice = () => (Number(S.quote?.pricing?.subtotal) || 0) + (Number(S.quote?.pricing?.delivery) || 0) || total();
  $('#main').innerHTML = head('New contract', 'Pick the design, Cash or Rent to Own, and the template. We build the contract with the 3D rendering, floor plan and elevations attached.', '<a class="btn ghost" href="#/pos">Cancel</a>') + `
  <div class="grid" style="grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start" id="wz">
    <div class="grid" style="gap:16px">
      <div class="card card-pad"><h2>1 · Design</h2><div id="wQuote" style="margin-top:10px"></div></div>
      <div class="card card-pad"><h2>2 · Sale type &amp; template</h2>
        <div class="choice" style="margin-top:10px"><label><input type="radio" name="sale" value="cash" ${S.sale_type === 'cash' ? 'checked' : ''}><b>Cash</b><small>Paid in full: deposit today, balance at delivery</small></label>
          <label><input type="radio" name="sale" value="rto" ${S.sale_type === 'rto' ? 'checked' : ''}><b>Rent to own</b><small>Monthly payments${meta.rto?.company ? ' through ' + esc(meta.rto.company) : ''}</small></label></div>
        <div id="wTpl" style="margin-top:14px"></div></div>
      <div class="card card-pad"><h2>3 · Who signs</h2><div class="form" style="margin-top:10px">
        <div class="section-t" style="margin-top:0;border:0;padding-top:0">Customer</div>
        <label class="fld full"><span>Full name *</span><input id="sName" value="${esc(fullName(cust) || cust.full_name || '')}"></label>
        <label class="fld"><span>Mobile (gets the link by text)</span><input id="sPhone" type="tel" value="${esc(cust.phone || '')}"></label>
        <label class="fld"><span>Email (gets the link by email)</span><input id="sEmail" type="email" value="${esc(cust.email || '')}"></label>
        <div class="full" id="wCob"></div>
        <div class="full" id="wCompany"></div></div></div>
      <div class="card card-pad" id="wMoney"></div>
      <div class="card card-pad" id="wCustom" hidden></div>
    </div>
    <div class="card card-pad" style="position:sticky;top:12px"><h2>Summary</h2><div id="wSum" style="margin-top:8px"></div>
      <div class="err" id="wErr" hidden style="margin-top:10px"></div>
      <button class="btn primary block" id="wGo" style="margin-top:14px">Prepare contract</button>
      <div class="busy" id="wBusy" hidden style="margin-top:12px"><span class="spin"></span><span id="wBusyT">Working…</span></div>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">You'll see the finished contract before anything is sent.</p></div>
  </div>`;

  const renderQuote = async () => {
    const q = S.quote;
    if (q) {
      $('#wQuote').innerHTML = `<div class="row" style="align-items:flex-start;flex-wrap:nowrap;gap:14px"><div class="plan-prev" style="width:200px;flex:none"><img src="${planUrl(q.id)}" alt=""></div>
        <div style="flex:1;min-width:0"><b style="font-size:16px">${esc(q.shed.style)} ${esc(q.shed.size)}</b><div class="muted">${esc(q.number)} · ${esc(q.customer.full_name)} · ${fmt(q.pricing.total)}</div>
        <div class="muted" style="font-size:12.5px;margin-top:6px">${esc(q.options.filter(o => !o.name.startsWith('Removed')).map(o => o.name).join(', ') || 'No options')}</div>
        <div class="row" style="margin-top:10px"><a class="btn ghost sm" href="${esc(q.links.view_3d)}" target="_blank">Open in 3D ↗</a><button class="btn ghost sm" id="wPick">Use a different design</button></div></div></div>`;
    } else {
      $('#wQuote').innerHTML = `<p class="muted" style="margin:0 0 10px">Pick the customer's 3D design (quote). Designing a new one? Open the configurator, submit it, then come back.</p><div class="row"><button class="btn primary sm" id="wPick">Choose a design</button><a class="btn ghost sm" href="/" target="_blank">Open configurator ↗</a></div>`;
    }
    $('#wPick').onclick = () => pickQuote(async q => { S.quote = await api('GET', `/api/v1/quotes/${q.id}`); if (!$('#sName').value) { $('#sName').value = S.quote.customer.full_name; $('#sEmail').value = S.quote.customer.email || ''; $('#sPhone').value = S.quote.customer.phone || ''; } renderQuote(); renderMoney(); renderSum(); });
  };
  const tplList = () => meta.templates.filter(t => t.sale_type === S.sale_type || t.sale_type === 'any');
  const tpl = () => meta.templates.find(t => t.id === S.template_id);
  const renderTpl = () => {
    const list = tplList();
    const ready = t => t.roles.includes('customer');
    if (!list.some(t => t.id === S.template_id && ready(t))) S.template_id = list.find(ready)?.id || null;
    $('#wTpl').innerHTML = list.length ? `<div class="choice">${list.map(t => ready(t)
      ? `<label><input type="radio" name="tpl" value="${t.id}" ${t.id === S.template_id ? 'checked' : ''}><b>${esc(t.name)}</b><small>${t.pages.length} page${t.pages.length === 1 ? '' : 's'}${t.append_drawings ? ' + drawings' : ''} · signers: ${t.roles.map(r => ROLE[r]).join(', ')}</small></label>`
      : `<label style="opacity:.6;cursor:not-allowed"><input type="radio" disabled><b>${esc(t.name)}</b><small>Not ready — ${can('pos.templates') ? `<a href="#/pos/templates/${t.id}">add a customer signature box</a>` : 'needs a customer signature box'}</small></label>`).join('')}</div>`
      : `<div class="callout warn">No ${saleTypeLabel(S.sale_type)} template yet. ${can('pos.templates') ? '<a href="#/pos/templates">Upload one</a>.' : 'Ask your admin to upload one.'}</div>`;
    const t = tpl();
    const roles = t?.roles || [];
    $('#wCob').innerHTML = roles.includes('cobuyer') ? `<label class="chk"><input type="checkbox" id="cobOn" ${S.cob ? 'checked' : ''}>Add a co-buyer</label><div class="form" id="cobF" style="margin-top:10px" ${S.cob ? '' : 'hidden'}>
      <label class="fld full"><span>Co-buyer name</span><input id="cName"></label><label class="fld"><span>Mobile</span><input id="cPhone" type="tel"></label><label class="fld"><span>Email</span><input id="cEmail" type="email"></label></div>` : '';
    if ($('#cobOn')) $('#cobOn').onchange = e => { S.cob = e.target.checked; $('#cobF').hidden = !S.cob; };
    $('#wCompany').innerHTML = roles.includes('company') ? `<label class="fld"><span>Signs for the company</span><select id="coSigner">${staff.map(u => `<option value="${u.id}" ${u.id === me.id ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join('')}</select><small>They'll get a "Sign as company" button on the contract page.</small></label>` : '';
    const custom = t?.custom || [];
    $('#wCustom').hidden = !custom.length && false;
    $('#wCustom').innerHTML = `<h2>5 · Extra details</h2><div class="form" style="margin-top:10px">${custom.map(k => `<label class="fld"><span>${esc(k)}</span><input data-custom="${esc(k)}" value="${esc(S.custom[k] || '')}"></label>`).join('')}
      <label class="fld"><span>Serial number (optional)</span><input data-custom="serial_number" value="${esc(S.custom.serial_number || '')}"></label></div>`;
    $('#wCustom').hidden = false;
    renderSum();
  };
  const terms = (meta.rto?.terms?.length ? meta.rto.terms : DEFAULT_RTO.terms);
  S.term = meta.rto?.default_term || terms[0]?.months;
  const rtoNow = () => rtoCalc(cashPrice(), S.term, meta.rto, meta.tax_rate, Number($('#rOver')?.value) || null);
  const renderMoney = () => {
    if (S.sale_type === 'cash') {
      const dep = S.deposit ?? Math.round(total() * (Number(meta.cash_deposit_pct) || 0)) / 100;
      $('#wMoney').innerHTML = `<h2>4 · Payment</h2><div class="form" style="margin-top:10px"><label class="fld"><span>Deposit collected today ($)</span><input id="cDep" type="number" step="0.01" min="0" value="${dep.toFixed(2)}"><small>Default ${meta.cash_deposit_pct || 0}% of the total — change it in Settings.</small></label>
        <div class="fld"><span>Balance due at delivery</span><div style="font-size:20px;font-weight:800;padding-top:6px" id="cBal">${fmt(Math.max(0, total() - dep))}</div></div></div>`;
      $('#cDep').oninput = () => { S.deposit = Number($('#cDep').value) || 0; $('#cBal').textContent = fmt(Math.max(0, total() - S.deposit)); renderSum(); };
    } else {
      $('#wMoney').innerHTML = `<h2>4 · Rent-to-own terms</h2><div class="form" style="margin-top:10px">
        <label class="fld"><span>Term</span><select id="rTerm">${terms.map(t => `<option value="${t.months}" ${Number(t.months) === Number(S.term) ? 'selected' : ''}>${t.months} months</option>`).join('')}</select></label>
        <label class="fld"><span>Override monthly rental ($, optional)</span><input id="rOver" type="number" step="0.01" min="0" placeholder="Use the rate sheet"></label>
        <label class="fld"><span>First payment due</span><input id="rFirst" type="date"></label><div></div>
        <div class="full"><table class="rto-table" id="rTable"></table></div></div>`;
      const upd = () => { const r = rtoNow(); $('#rTable').innerHTML = `<tr><td>Cash price (before tax)</td><td>${usd(r.cash_price)}</td></tr><tr><td>Monthly rental</td><td>${usd(r.monthly_payment)}</td></tr><tr><td>Sales tax (${r.tax_rate}%)</td><td>${usd(r.monthly_tax)}</td></tr>${r.ldw ? `<tr><td>Damage waiver</td><td>${usd(r.ldw)}</td></tr>` : ''}<tr class="big"><td>Monthly payment</td><td>${usd(r.monthly_total)}</td></tr><tr><td>Due at signing</td><td>${usd(r.deposit)}</td></tr><tr><td>Total of ${r.term_months} payments</td><td>${usd(r.total_of_payments)}</td></tr>`; renderSum(); };
      $('#rTerm').onchange = () => { S.term = Number($('#rTerm').value); upd(); };
      $('#rOver').oninput = upd; upd();
    }
  };
  const renderSum = () => {
    const t = tpl(); const q = S.quote;
    const r = S.sale_type === 'rto' && $('#rTable') ? rtoNow() : null;
    $('#wSum').innerHTML = `<dl class="kv"><dt>Customer</dt><dd>${esc($('#sName')?.value || '—')}</dd><dt>Building</dt><dd>${q ? esc(q.shed.style + ' ' + q.shed.size) : '<span class="err">Pick a design</span>'}</dd>
      <dt>Sale</dt><dd><span class="pill ${S.sale_type}">${saleTypeLabel(S.sale_type)}</span></dd><dt>Template</dt><dd>${t ? esc(t.name) : '—'}</dd>
      <dt>Total</dt><dd><b>${fmt(total())}</b></dd>${r ? `<dt>Monthly</dt><dd><b>${usd(r.monthly_total)}</b> × ${r.term_months}</dd><dt>At signing</dt><dd>${usd(r.deposit)}</dd>` : `<dt>Deposit</dt><dd>${fmt(S.deposit ?? Math.round(total() * (Number(meta.cash_deposit_pct) || 0)) / 100)}</dd>`}</dl>`;
  };
  $$('[name=sale]').forEach(r => (r.onchange = () => { S.sale_type = r.value; renderTpl(); renderMoney(); renderSum(); }));
  $('#wTpl').onchange = e => { if (e.target.name === 'tpl') { S.template_id = Number(e.target.value); renderTpl(); } };
  $('#wz').addEventListener('input', e => { if (e.target.dataset.custom) S.custom[e.target.dataset.custom] = e.target.value; if (e.target.id === 'sName') renderSum(); });
  await renderQuote(); renderTpl(); renderMoney(); renderSum();

  $('#wGo').onclick = async () => {
    const err = $('#wErr'); err.hidden = true;
    const fail = m => { err.textContent = m; err.hidden = false; };
    if (!S.template_id) return fail('Pick a contract template.');
    if (!$('#sName').value.trim()) return fail("Enter the customer's name.");
    if (!$('#sPhone').value.trim() && !$('#sEmail').value.trim()) return fail('Enter a mobile number or email so the customer can get the signing link.');
    if (!S.quote && !confirmBox('No 3D design picked. Create the contract without the rendering, floor plan and elevations?')) return;
    const btn = $('#wGo'); btn.disabled = true; $('#wBusy').hidden = false;
    const step = t => { $('#wBusyT').textContent = t; };
    try {
      const fd = new FormData();
      const payload = {
        quote_id: S.quote?.id || null, contact_id: S.contact?.id || S.quote?.contact_id || null, template_id: S.template_id, sale_type: S.sale_type,
        signers: { customer: { name: $('#sName').value.trim(), phone: $('#sPhone').value.trim(), email: $('#sEmail').value.trim() }, cobuyer: S.cob && $('#cName')?.value.trim() ? { name: $('#cName').value.trim(), phone: $('#cPhone').value.trim(), email: $('#cEmail').value.trim() } : null },
        company_signer_id: $('#coSigner') ? Number($('#coSigner').value) : null, custom: S.custom,
        rto: S.sale_type === 'rto' ? { term_months: S.term, monthly_override: Number($('#rOver').value) || null, first_payment_date: $('#rFirst').value ? new Date($('#rFirst').value + 'T12:00:00').toLocaleDateString('en-US') : '' } : null,
        cash: S.sale_type === 'cash' ? { deposit: Number($('#cDep').value) || 0 } : null,
      };
      fd.append('payload', JSON.stringify(payload));
      if (S.quote) {
        const cat = catalog || await loadCatalog();
        step('Rendering the 3D view…');
        const img = await render3D(cat, S.quote.config);
        fd.append('rendering', await (await fetch(img)).blob(), 'rendering.jpg');
        step('Drawing the floor plan…');
        fd.append('floorplan', await (await fetch(await floorPlanPNG(cat, S.quote))).blob(), 'floorplan.png');
        step('Drawing elevations…');
        fd.append('drawings', await buildDrawingPackage(cat, S.quote, { company: settings.company_name || '', withPricing: false, initials: true }), 'drawings.pdf');
      }
      step('Building the contract…');
      const k = await api('POST', '/api/pos/contracts', fd);
      toast(`Contract ${k.number} is ready`);
      location.hash = `#/pos/contracts/${k.id}?new=1`;
    } catch (e) { fail(e.message); btn.disabled = false; $('#wBusy').hidden = true; }
  };
}
function pickQuote(done) {
  openModal({
    title: 'Choose a 3D design', body: `<input class="in" id="pq" placeholder="Search name, email, phone or quote #" style="margin-bottom:10px"><div id="pl" class="tbl-wrap"></div>`,
    onMount: root => {
      const render = async () => {
        const r = await api('GET', `/api/v1/quotes?limit=40&q=${encodeURIComponent($('#pq', root).value)}`);
        $('#pl', root).innerHTML = r.data.length ? `<table class="tbl">${r.data.map(q => `<tr class="click" data-id="${q.id}"><td><b>${esc(q.number)}</b></td><td>${esc(q.customer.full_name)}<div class="muted" style="font-size:12px">${esc(q.customer.email || '')}</div></td><td>${esc(q.shed.style)} ${esc(q.shed.size)}</td><td class="num">${fmt(q.pricing.total)}</td><td class="muted">${fmtDate(q.created_at)}</td></tr>`).join('')}</table>` : '<div class="empty">No designs found.</div>';
        $('#pl', root).onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) { closeModal(); done(r.data.find(q => q.id === Number(tr.dataset.id))); } };
      };
      let t; $('#pq', root).oninput = () => { clearTimeout(t); t = setTimeout(guard(render), 250); }; guard(render)();
    },
  });
}

// ---------------------------------------------------------------------------
// Contract detail
// ---------------------------------------------------------------------------
async function contractDetail(id) {
  const k = await api('GET', `/api/pos/contracts/${id}`);
  const open = !['completed', 'void'].includes(k.status);
  const pdfUrl = `/api/pos/contracts/${id}/document.pdf`;
  const outside = k.signers.filter(s => s.role !== 'company');
  const isNew = hashQuery().get('new');
  $('#main').innerHTML = `<div class="head"><div><h1>Contract ${esc(k.number)} <span class="pill ${esc(k.status)}" style="vertical-align:middle">${esc(STATUS[k.status] || k.status)}</span></h1><p>${esc(k.summary.customer || '')} · ${esc(k.summary.shed || '')} · ${saleTypeLabel(k.sale_type)} · ${fmt(k.total)}${k.summary.rto?.monthly_total ? ` · ${esc(k.summary.rto.monthly_total)}/mo × ${esc(k.summary.rto.term_months)}` : ''}</p></div>
    <div class="row"><a class="btn ghost" href="#/pos">‹ All contracts</a>${can('contracts.download') ? `<a class="btn ${k.status === 'completed' ? 'primary' : 'ghost'}" href="${pdfUrl}?download=1">${k.status === 'completed' ? 'Download signed PDF' : 'Download PDF'}</a>` : ''}
      ${k.contact_id && can('crm.view') ? `<a class="btn ghost" href="#/crm/contacts/${k.contact_id}">Contact</a>` : ''}
      ${k.status !== 'void' && (k.status !== 'completed' || isAdmin()) ? '<button class="btn danger" id="kVoid">Void</button>' : ''}${k.status === 'draft' || (isAdmin() && k.status !== 'completed') ? `<button class="icon-btn" id="kDel" title="Delete">${TRASH}</button>` : ''}</div></div>
  ${k.status === 'void' ? `<div class="callout warn" style="margin-bottom:16px">Voided ${fmtDate(k.voided_at)}${k.void_reason ? ': ' + esc(k.void_reason) : ''}. The signing links no longer work.</div>` : ''}
  ${k.status === 'completed' ? `<div class="callout" style="margin-bottom:16px">✅ Signed by everyone ${fmtDate(k.completed_at)}. The signed PDF (with the 3D rendering, floor plan, elevations and the certificate of completion) was ${outside.some(s => s.email) ? 'emailed to the customer' : 'sent to the customer'}, and the order is on the <a href="#/orders">production board</a>.</div>` : ''}
  <div class="grid" style="grid-template-columns:minmax(0,1fr) 380px;gap:16px;align-items:start">
    <div class="grid" style="gap:16px">
      ${open ? `<div class="card card-pad" id="sendCard"><h2>${isNew || k.status === 'draft' ? 'Send for signature' : 'Signing'}</h2>
        <p class="muted" style="margin:2px 0 12px">Each signer gets their own secure link. They can sign on a phone, tablet or computer — no account needed.</p>
        ${k.status === 'draft' ? `<div class="row" style="margin-bottom:6px"><label class="chk"><input type="checkbox" id="viaSms" checked>Text the link</label><label class="chk"><input type="checkbox" id="viaEmail" checked>Email the link</label><button class="btn primary" id="sendAll">Send to ${outside.length > 1 ? 'buyers' : 'customer'}</button><span class="muted">or have them sign right here ↓</span></div>` : ''}
        <div>${k.signers.map(s => `<div class="signer-row"><span class="av">${esc((s.name || '?')[0])}</span><div class="grow"><b>${esc(s.name)}</b> <span class="muted">· ${esc(ROLE[s.role] || s.role)}</span>
          <div class="muted" style="font-size:12.5px">${esc([s.phone, s.email].filter(Boolean).join(' · ') || 'No contact info')} ${s.status !== 'signed' && s.role !== 'company' ? `<button class="btn link sm" data-edit="${s.id}" style="padding:0 4px">edit</button>` : ''}</div></div>
          <span class="pill ${esc(s.status)}">${s.status === 'signed' ? 'Signed ' + fmtDate(s.signed_at) : s.status === 'viewed' ? 'Opened ' + fmtDate(s.viewed_at) : 'Not signed'}</span>
          ${s.status !== 'signed' ? `<div class="row">${s.role !== 'company' && s.phone ? `<button class="btn ghost sm" data-sms="${s.id}">Text link</button>` : ''}${s.role !== 'company' && s.email ? `<button class="btn ghost sm" data-email="${s.id}">Email link</button>` : ''}
            <button class="icon-btn" data-copy="${esc(s.link)}" title="Copy signing link">${COPY}</button><button class="btn ${s.role === 'company' ? 'primary' : 'ghost'} sm" data-inperson="${s.id}">${s.role === 'company' ? 'Sign as company' : 'Sign now (in person)'}</button></div>` : ''}</div>`).join('')}</div></div>` : ''}
      <div class="card card-pad"><div class="row" style="justify-content:space-between;margin-bottom:10px"><h2>Document</h2><a class="btn ghost sm" href="${pdfUrl}" target="_blank">Open in new tab ↗</a></div>
        ${can('contracts.download') ? '<div class="pdf-pages" id="kPdf"><div class="busy"><span class="spin"></span>Loading document…</div></div>' : '<div class="muted">You can view the signed copy once everyone has signed.</div>'}</div>
    </div>
    <div class="grid" style="gap:16px">
      <div class="card card-pad"><h2>Details</h2><dl class="kv" style="margin-top:8px"><dt>Template</dt><dd>${esc(k.template_name || '')}</dd><dt>Sale type</dt><dd><span class="pill ${esc(k.sale_type)}">${saleTypeLabel(k.sale_type)}</span></dd>
        <dt>Total</dt><dd>${fmt(k.total)}</dd>${k.summary.rto?.monthly_total ? `<dt>Monthly</dt><dd>${esc(k.summary.rto.monthly_total)} × ${esc(k.summary.rto.term_months)} mo</dd><dt>At signing</dt><dd>${esc(k.summary.rto.deposit)}</dd>` : `<dt>Deposit</dt><dd>${fmt(k.raw?.deposit)}</dd>`}
        ${k.quote_id ? `<dt>3D design</dt><dd><a href="#/quotes/${k.quote_id}">View quote</a></dd>` : ''}<dt>Created</dt><dd>${fmtDate(k.created_at)}</dd>${k.sent_at ? `<dt>Sent</dt><dd>${fmtDate(k.sent_at)}</dd>` : ''}${k.expires_at && open ? `<dt>Links expire</dt><dd>${fmtDate(k.expires_at)}</dd>` : ''}
        ${k.signed_hash ? `<dt>Fingerprint</dt><dd><code style="font-size:10.5px;word-break:break-all">${esc(k.signed_hash)}</code></dd>` : ''}</dl></div>
      <div class="card card-pad"><h2>Activity</h2><div style="margin-top:8px">${k.events.slice().reverse().map(e => `<div class="task-row"><span><b style="font-weight:700">${esc(e.event)}</b>${e.detail ? ' — ' + esc(e.detail) : ''}<small>${fmtDate(e.created_at)}${e.user_name ? ' · ' + esc(e.user_name) : ''}${e.ip ? ' · IP ' + esc(e.ip) : ''}</small></span></div>`).join('')}</div></div>
    </div></div>`;
  if ($('#kPdf')) previewPdf($('#kPdf'), pdfUrl).catch(e => { $('#kPdf').innerHTML = `<div class="muted">Preview unavailable (${esc(e.message)}). Use “Open in new tab”.</div>`; });
  const reload = () => contractDetail(id);
  const send = async (body, label) => { const r = await api('POST', `/api/pos/contracts/${id}/send`, body); const bad = r.results.filter(x => !x.ok); toast(bad.length ? `Sent, but: ${bad.map(x => x.error).join('; ')}` : label, !!bad.length); reload(); };
  if ($('#sendAll')) $('#sendAll').onclick = guard(async () => { await send({ sms: $('#viaSms').checked, email: $('#viaEmail').checked }, 'Signing link sent'); });
  $('#main').onclick = guard(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sms) await send({ sms: true, email: false, signer_ids: [Number(b.dataset.sms)] }, 'Link texted');
    if (b.dataset.email) await send({ sms: false, email: true, signer_ids: [Number(b.dataset.email)] }, 'Link emailed');
    if (b.dataset.copy) { await navigator.clipboard?.writeText(b.dataset.copy); toast('Signing link copied'); }
    if (b.dataset.inperson) {
      const w = window.open('about:blank', '_blank');
      const r = await api('POST', `/api/pos/contracts/${id}/sign-in-person`, { signer_id: Number(b.dataset.inperson) });
      if (w) w.location = r.url; else location.href = r.url;
    }
    if (b.dataset.edit) {
      const s = k.signers.find(x => x.id === Number(b.dataset.edit));
      const phone = prompt(`Mobile for ${s.name}`, s.phone || ''); if (phone === null) return;
      const email = prompt(`Email for ${s.name}`, s.email || ''); if (email === null) return;
      await api('PATCH', `/api/pos/contracts/${id}/signers/${s.id}`, { phone, email }); toast('Updated'); reload();
    }
  });
  if ($('#kVoid')) $('#kVoid').onclick = guard(async () => { const reason = prompt('Why are you voiding this contract? (the signing links will stop working)'); if (reason === null) return; await api('POST', `/api/pos/contracts/${id}/void`, { reason }); toast('Contract voided'); reload(); });
  if ($('#kDel')) $('#kDel').onclick = guard(async () => { if (!confirmBox('Delete this contract?')) return; await api('DELETE', `/api/pos/contracts/${id}`); toast('Deleted'); location.hash = '#/pos'; });
  onLive((type, d) => { if (type === 'contract' && Number(d.id) === id && !$('#modal').open) reload(); });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
async function templatesPage() {
  const list = await api('GET', '/api/pos/templates');
  const edit = can('pos.templates');
  $('#main').innerHTML = head('Point of sale', 'Upload your contract PDFs for Cash and Rent-to-Own sales, then drag signature, initials, date and auto-filled boxes onto them.', edit ? '<button class="btn primary" id="tUp">+ Upload template (PDF)</button>' : '') + tabs('templates') + `
    <div class="tpl-cards">${list.map(t => {
      const sig = t.fields.filter(f => f.type === 'signature');
      return `<div class="card scard"><div class="body"><div class="row" style="justify-content:space-between"><b>${esc(t.name)}</b><span class="pill ${t.sale_type === 'any' ? '' : esc(t.sale_type)}">${saleTypeLabel(t.sale_type)}</span></div>
      <div class="muted" style="margin-top:6px;font-size:13px">${t.pages.length} page${t.pages.length === 1 ? '' : 's'} · ${t.fields.length} fields · ${sig.length} signature${sig.length === 1 ? '' : 's'}${t.append_drawings ? ' · drawings attached' : ''}</div>
      <div class="muted" style="font-size:12.5px;margin-top:4px">${t.used ? `Used on ${t.used} contract${t.used === 1 ? '' : 's'}` : 'Not used yet'}${t.active ? '' : ' · <b>archived</b>'}</div>
      ${!sig.some(f => f.role === 'customer') ? '<div class="err" style="margin-top:6px">No customer signature box yet</div>' : ''}</div>
      <div class="foot"><a class="btn ${edit ? 'primary' : 'ghost'} sm" href="#/pos/templates/${t.id}">${edit ? 'Edit fields' : 'View'}</a><a class="btn link sm" href="/api/pos/templates/${t.id}/file.pdf" target="_blank">Original PDF ↗</a></div></div>`;
    }).join('') || '<div class="empty">No templates yet.</div>'}</div>
    <div class="callout" style="margin-top:16px">Tip: make your contract in Word or Google Docs and save it as a PDF. Leave blank lines where the customer signs — you'll drop the boxes on top. The two <b>Sample</b> templates show how it works; duplicate or delete them when your own are ready.</div>`;
  wireTabs();
  if ($('#tUp')) $('#tUp').onclick = () => openModal({
    title: 'Upload a contract template', narrow: true,
    body: `<form class="form" id="uf"><label class="fld full"><span>Name</span><input name="name" placeholder="e.g. Cash Purchase Agreement 2026"></label>
      <label class="fld full"><span>Used for</span><select name="sale_type"><option value="cash">Cash sales</option><option value="rto">Rent-to-own sales</option><option value="any">Both</option></select></label>
      <label class="fld full"><span>PDF file</span><input type="file" name="file" accept="application/pdf,.pdf"><small>Have a Word or Google Doc? Use File → Save as / Download → PDF first.</small></label><div class="err full" id="uerr" hidden></div>
      <div class="busy full" id="ubusy" hidden><span class="spin"></span><span id="ubusyT">Uploading…</span></div></form>`,
    foot: '<span></span><button class="btn primary" id="ugo">Upload &amp; place fields</button>',
    onMount: root => {
      const f = $('#uf', root);
      f.file.onchange = () => { const n = f.file.files[0]?.name || ''; if (n && !f.name.value) f.name.value = n.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '); };
      $('#ugo', root).onclick = async () => {
        const err = $('#uerr', root); err.hidden = true;
        const file = f.file.files[0]; if (!file) { err.textContent = 'Choose a PDF'; err.hidden = false; return; }
        if (/\.(docx?|pages|odt|rtf)$/i.test(file.name)) { err.textContent = 'That is a word-processor file. Open it in Word or Google Docs and save/download it as a PDF, then upload the PDF.'; err.hidden = false; return; }
        $('#ugo', root).disabled = true; $('#ubusy', root).hidden = false;
        try {
          const t = await uploadPdf('/api/pos/templates', file, { name: f.name.value, sale_type: f.sale_type.value }, m => { $('#ubusyT', root).textContent = m; });
          closeModal(); toast('Uploaded — now place the fields'); location.hash = `#/pos/templates/${t.id}`;
        } catch (e) { err.textContent = e.message; err.hidden = false; $('#ugo', root).disabled = false; $('#ubusy', root).hidden = true; }
      };
    },
  });
}

/**
 * Upload a contract PDF. Locked PDFs (password or "no editing" restrictions — common with contracts
 * exported from form vendors, Adobe or DocuSign) are opened here in the browser and re-saved as an
 * unlocked copy that looks exactly the same, then uploaded.
 */
async function uploadPdf(url, file, extra = {}, progress = () => {}) {
  const send = blob => { const fd = new FormData(); for (const [k, v] of Object.entries(extra)) fd.append(k, v); fd.append('file', blob, file.name.replace(/\.pdf$/i, '') + '.pdf'); return api('POST', url, fd); };
  try { return await send(file); }
  catch (e) { if (!/LOCKED_PDF/.test(e.message)) throw e; }
  progress('This PDF is locked — making an unlocked copy…');
  const lib = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  for (let tries = 0; ; tries++) {
    try { doc = await lib.getDocument({ data: data.slice(), password: tries ? prompt(tries === 1 ? 'This PDF needs a password to open. Enter it:' : 'Wrong password — try again:') || '' : undefined }).promise; break; }
    catch (e) { if (e?.name !== 'PasswordException' || tries >= 3) throw new Error(e?.name === 'PasswordException' ? 'Could not open the PDF — the password was not accepted.' : 'Could not open the PDF: ' + e.message); }
  }
  const { jsPDF } = window.jspdf;
  let out = null;
  for (let i = 1; i <= doc.numPages; i++) {
    progress(`Making an unlocked copy… page ${i} of ${doc.numPages}`);
    const pg = await doc.getPage(i); const v1 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: 200 / 72 }); // 200 dpi keeps fine print sharp
    const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const orient = v1.width > v1.height ? 'landscape' : 'portrait';
    if (!out) out = new jsPDF({ unit: 'pt', format: [v1.width, v1.height], orientation: orient }); else out.addPage([v1.width, v1.height], orient);
    out.addImage(cv.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, v1.width, v1.height);
  }
  progress('Uploading…');
  const r = await send(out.output('blob'));
  toast('Your PDF was locked, so we uploaded an unlocked copy (it looks the same).');
  return r;
}

let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  const f = window.__pdfjsFiles || { lib: '/vendor/pdfjs/pdf.min.mjs', worker: '/vendor/pdfjs/pdf.worker.min.mjs' };
  pdfjs = await import(/* webpackIgnore: true */ f.lib);
  pdfjs.GlobalWorkerOptions.workerSrc = f.worker;
  return pdfjs;
}
async function previewPdf(host, url) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: await (await fetch(url)).arrayBuffer() }).promise;
  host.innerHTML = '';
  const W = Math.max(300, host.clientWidth - 24), dpr = Math.min(2, window.devicePixelRatio || 1);
  for (let i = 1; i <= doc.numPages; i++) {
    if (!document.body.contains(host)) return;
    const pg = await doc.getPage(i); const v1 = pg.getViewport({ scale: 1 }); const vp = pg.getViewport({ scale: W / v1.width * dpr });
    const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height; host.appendChild(cv);
    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  }
}
const fieldText = f => {
  const t = FIELD_TYPES[f.type];
  if (f.type === 'data') return tagLabel(f.tag);
  if (f.type === 'rendering') return '3D rendering';
  if (f.type === 'floorplan') return 'Floor plan';
  return `${ROLE[f.role] || ''} ${t.label.replace(/ \(.+\)$/, '').toLowerCase()}${f.required === false ? ' (optional)' : ''}`.trim();
};

async function designer(id) {
  let t = await api('GET', `/api/pos/templates/${id}`);
  const edit = can('pos.templates');
  let fields = t.fields.map(f => ({ ...f }));
  let sel = null, tool = null, dirty = false, role = 'customer', seq = Date.now() % 100000;
  const nid = () => 'f' + (++seq).toString(36);
  $('#main').innerHTML = `<div class="head"><div><h1>${esc(t.name)}</h1><p>Click a field type, then click on the page to drop it. Drag to move, drag the corner to resize.${edit ? '' : ' (view only)'}</p></div>
    <div class="row"><span class="muted" id="dState"></span><a class="btn ghost" href="#/pos/templates">‹ Templates</a>${edit ? '<button class="btn primary" id="dSave">Save</button>' : ''}</div></div>
  <div class="designer">
    <div class="card card-pad dz-tools" id="tools">
      <div class="section-t" style="margin:0 0 8px;border:0;padding:0">Signer fields</div>
      <label class="fld" style="margin-bottom:8px"><span>For</span><select id="role">${SIGNER_ROLES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      ${Object.entries(FIELD_TYPES).filter(([, v]) => v.signer).map(([k, v]) => `<button class="tool" data-tool="${k}"><span class="sw2" style="background:#1d4ed8"></span>${esc(v.label)}</button>`).join('')}
      <div class="section-t" style="margin:14px 0 8px;border:0;padding:0">Filled in for you</div>
      ${Object.entries(FIELD_TYPES).filter(([, v]) => !v.signer).map(([k, v]) => `<button class="tool" data-tool="${k}"><span class="sw2" style="background:${k === 'data' ? '#6b7673' : '#067647'}"></span>${esc(v.label)}</button>`).join('')}
      <p class="muted" style="font-size:12px;margin:10px 0 0">Blue = customer · purple = co-buyer · orange = company · grey = auto-filled · green = images.</p>
    </div>
    <div class="dz-pages" id="pages"><div class="busy"><span class="spin"></span>Loading PDF…</div></div>
    <div class="card card-pad dz-props" id="props"></div>
  </div>`;
  if (!edit) $('#tools').style.opacity = .5;
  const setDirty = v => { dirty = v; $('#dState').textContent = v ? 'Unsaved changes' : ''; };
  window.onbeforeunload = () => (dirty ? true : undefined);
  window.addEventListener('hashchange', () => { window.onbeforeunload = null; }, { once: true });

  // render pages
  const lib = await loadPdfjs();
  const buf = await (await fetch(`/api/pos/templates/${id}/file.pdf`)).arrayBuffer();
  const doc = await lib.getDocument({ data: buf }).promise;
  const host = $('#pages'); host.innerHTML = '';
  const maxW = Math.min(860, host.clientWidth - 36);
  for (let i = 0; i < doc.numPages; i++) {
    const pg = await doc.getPage(i + 1);
    const vp1 = pg.getViewport({ scale: 1 });
    const scale = maxW / vp1.width, dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = pg.getViewport({ scale: scale * dpr });
    const wrap = document.createElement('div'); wrap.className = 'dz-page'; wrap.style.width = vp1.width * scale + 'px'; wrap.style.height = vp1.height * scale + 'px';
    const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
    wrap.innerHTML = `<div class="pg-no">Page ${i + 1}</div>`; wrap.appendChild(cv);
    const layer = document.createElement('div'); layer.className = 'dz-layer'; layer.dataset.page = i; wrap.appendChild(layer);
    host.appendChild(wrap);
    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  }
  const layers = () => $$('.dz-layer', host);
  const drawFields = () => {
    for (const L of layers()) {
      const p = Number(L.dataset.page);
      L.innerHTML = fields.filter(f => f.page === p).map(f => `<div class="dz-f ${FIELD_TYPES[f.type].signer ? 'r-' + f.role : 't-' + f.type} ${sel === f.id ? 'sel' : ''}" data-id="${esc(f.id)}" style="left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%" title="${esc(fieldText(f))}">${esc(fieldText(f))}${edit ? '<span class="rz"></span>' : ''}</div>`).join('');
    }
  };
  const tagOptions = cur => TAGS.map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(([k, l]) => `<option value="${esc(k)}" ${k === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</optgroup>`).join('') + `<optgroup label="Other"><option value="__custom" ${String(cur).startsWith('custom:') ? 'selected' : ''}>Custom value (rep types it in)…</option></optgroup>`;
  const renderProps = () => {
    const f = fields.find(x => x.id === sel);
    if (!f) {
      const counts = SIGNER_ROLES.map(([k, l]) => [l, fields.filter(x => x.role === k).length]).filter(x => x[1]);
      $('#props').innerHTML = `<h2>Template</h2><form class="inline-edit" id="tf" style="margin-top:10px">
        <label>Name<input name="name" value="${esc(t.name)}" ${edit ? '' : 'disabled'}></label>
        <label>Used for<select name="sale_type" ${edit ? '' : 'disabled'}><option value="cash" ${t.sale_type === 'cash' ? 'selected' : ''}>Cash sales</option><option value="rto" ${t.sale_type === 'rto' ? 'selected' : ''}>Rent-to-own sales</option><option value="any" ${t.sale_type === 'any' ? 'selected' : ''}>Both</option></select></label>
        <label class="chk" style="color:var(--ink);font-size:13px"><input type="checkbox" name="append_drawings" ${t.append_drawings ? 'checked' : ''} ${edit ? '' : 'disabled'}>Attach drawings at the end (3D view & specs, floor plan, 4 elevations)</label>
        <label class="chk" style="color:var(--ink);font-size:13px"><input type="checkbox" name="initial_drawings" ${t.initial_drawings ? 'checked' : ''} ${edit ? '' : 'disabled'}>Customer initials each drawing sheet to approve it</label>
        <label class="chk" style="color:var(--ink);font-size:13px"><input type="checkbox" name="active" ${t.active ? 'checked' : ''} ${edit ? '' : 'disabled'}>Active (shows in the contract wizard)</label></form>
        <div class="section-t" style="margin:16px 0 8px">Fields</div><div class="muted" style="font-size:13px">${fields.length} total${counts.length ? ' · ' + counts.map(([l, n]) => `${l}: ${n}`).join(' · ') : ''}</div>
        ${!fields.some(x => x.type === 'signature' && x.role === 'customer') ? '<div class="callout warn" style="margin-top:8px;font-size:12.5px">Add at least one <b>Customer signature</b> box.</div>' : ''}
        ${edit ? `<div class="section-t" style="margin:16px 0 8px">More</div><div class="row"><label class="btn ghost sm">Replace PDF<input type="file" accept="application/pdf,.pdf" id="dRepl" hidden></label><button class="btn ghost sm" id="dDup">Duplicate</button><button class="btn danger sm" id="dDel">Delete</button></div>
        <p class="muted" style="font-size:12px">Replacing the PDF keeps the boxes you placed — handy when you fix a typo in the contract.</p>` : ''}`;
      $('#tf').oninput = () => setDirty(true);
      if ($('#dRepl')) $('#dRepl').onchange = guard(async e => { if (dirty) await save(); await uploadPdf(`/api/pos/templates/${id}/file`, e.target.files[0]); toast('PDF replaced'); setDirty(false); designer(id); });
      if ($('#dDup')) $('#dDup').onclick = guard(async () => { if (dirty) await save(); const r = await api('POST', `/api/pos/templates/${id}/duplicate`); toast('Duplicated'); location.hash = `#/pos/templates/${r.id}`; });
      if ($('#dDel')) $('#dDel').onclick = guard(async () => { if (!confirmBox('Delete this template? (Templates already used on contracts are archived instead.)')) return; const r = await api('DELETE', `/api/pos/templates/${id}`); setDirty(false); toast(r?.archived ? 'Archived (it was used on contracts)' : 'Deleted'); location.hash = '#/pos/templates'; });
      return;
    }
    const ft = FIELD_TYPES[f.type];
    const isCustom = f.type === 'data' && String(f.tag).startsWith('custom:');
    $('#props').innerHTML = `<h2>${esc(ft.label)}</h2><div class="inline-edit" id="pf" style="margin-top:10px">
      ${ft.signer ? `<label>Who fills it<select data-k="role">${SIGNER_ROLES.map(([k, l]) => `<option value="${k}" ${k === f.role ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="chk" style="color:var(--ink);font-size:13px"><input type="checkbox" data-k="required" ${f.required !== false ? 'checked' : ''}>Required</label>` : ''}
      ${f.type === 'data' ? `<label>Shows<select data-k="tag">${tagOptions(f.tag)}</select></label>${isCustom ? `<label>Custom value name<input data-k="custom" value="${esc(String(f.tag).slice(7))}" placeholder="e.g. Anchor type"></label>` : ''}` : ''}
      ${f.type === 'text' ? `<label>Label shown to the signer<input data-k="label" value="${esc(f.label || '')}" placeholder="e.g. Gate code"></label>` : ''}
      ${['data', 'text', 'date_signed'].includes(f.type) ? `<label>Font size<select data-k="fontSize"><option value="">Auto (fit the box)</option>${[7, 8, 9, 10, 11, 12, 14, 16, 18, 22].map(n => `<option ${Number(f.fontSize) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Align<select data-k="align">${['left', 'center', 'right'].map(a => `<option ${(f.align || 'left') === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label>` : ''}
      <label>Page<select data-k="page">${Array.from({ length: layers().length }, (_, i) => `<option value="${i}" ${i === f.page ? 'selected' : ''}>Page ${i + 1}</option>`).join('')}</select></label>
      ${edit ? `<div class="row"><button class="btn ghost sm" id="fDup">Duplicate</button><button class="btn danger sm" id="fDel">Delete</button><button class="btn link sm" id="fDone">Done</button></div>` : ''}
      <p class="muted" style="font-size:12px;margin:0">Arrow keys nudge · Delete removes · Esc deselects</p></div>`;
    if (!edit) $$('#pf select, #pf input').forEach(x => (x.disabled = true));
    $('#pf').onchange = $('#pf').oninput = e => {
      const k = e.target.dataset.k; if (!k) return;
      if (k === 'required') f.required = e.target.checked;
      else if (k === 'page') f.page = Number(e.target.value);
      else if (k === 'fontSize') f.fontSize = e.target.value ? Number(e.target.value) : undefined;
      else if (k === 'tag') { if (e.target.value === '__custom') { f.tag = 'custom:' + (prompt('Name this value (the sales rep types it in when writing the contract):', 'Anchor type') || 'Custom value'); renderProps(); } else f.tag = e.target.value; }
      else if (k === 'custom') f.tag = 'custom:' + (e.target.value || 'Custom value');
      else f[k] = e.target.value;
      setDirty(true); drawFields();
      if (k === 'role' || k === 'tag' || k === 'page') renderProps();
    };
    if ($('#fDel')) $('#fDel').onclick = () => { fields = fields.filter(x => x.id !== f.id); sel = null; setDirty(true); drawFields(); renderProps(); };
    if ($('#fDup')) $('#fDup').onclick = () => { const c = { ...f, id: nid(), y: Math.min(1 - f.h, f.y + f.h + 0.01) }; fields.push(c); sel = c.id; setDirty(true); drawFields(); renderProps(); };
    if ($('#fDone')) $('#fDone').onclick = () => { sel = null; drawFields(); renderProps(); };
  };
  const save = async () => {
    const tf = $('#tf');
    const body = { fields };
    if (tf) Object.assign(body, { name: tf.name.value, sale_type: tf.sale_type.value, append_drawings: tf.append_drawings.checked, initial_drawings: tf.initial_drawings.checked, active: tf.active.checked });
    t = await api('PUT', `/api/pos/templates/${id}`, body);
    fields = t.fields.map(f => ({ ...f })); if (sel && !fields.some(f => f.id === sel)) sel = null;
    setDirty(false); drawFields(); toast('Template saved');
  };
  if ($('#dSave')) $('#dSave').onclick = guard(save);
  $('#role').onchange = e => { role = e.target.value; };
  $('#tools').onclick = e => {
    const b = e.target.closest('[data-tool]'); if (!b || !edit) return;
    tool = tool === b.dataset.tool ? null : b.dataset.tool;
    $$('[data-tool]').forEach(x => x.classList.toggle('on', x.dataset.tool === tool));
    layers().forEach(L => L.classList.toggle('placing', !!tool));
    if (tool) toast('Now click on the page where it goes');
  };
  // place / select / drag / resize
  let drag = null;
  host.addEventListener('pointerdown', e => {
    const L = e.target.closest('.dz-layer'); if (!L) return;
    const r = L.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    if (tool && edit) {
      const ft = FIELD_TYPES[tool];
      const f = { id: nid(), type: tool, page: Number(L.dataset.page), w: ft.w, h: ft.h, x: 0, y: 0, required: ft.signer ? true : false };
      f.x = Math.max(0, Math.min(1 - f.w, px - f.w / 2)); f.y = Math.max(0, Math.min(1 - f.h, py - f.h / 2));
      if (ft.signer) f.role = role;
      if (tool === 'data') f.tag = 'customer.full_name';
      fields.push(f); sel = f.id; tool = null;
      $$('[data-tool]').forEach(x => x.classList.remove('on')); layers().forEach(x => x.classList.remove('placing'));
      setDirty(true); drawFields(); renderProps(); e.preventDefault(); return;
    }
    const el = e.target.closest('.dz-f');
    if (!el) { if (sel) { sel = null; drawFields(); renderProps(); } return; }
    const f = fields.find(x => x.id === el.dataset.id); if (!f) return;
    if (sel !== f.id) { sel = f.id; drawFields(); renderProps(); }
    if (!edit) return;
    drag = { f, L, r, mode: e.target.classList.contains('rz') ? 'size' : 'move', sx: px, sy: py, ox: f.x, oy: f.y, ow: f.w, oh: f.h };
    host.setPointerCapture?.(e.pointerId); e.preventDefault();
  });
  host.addEventListener('pointermove', e => {
    if (!drag) return;
    const { f, r } = drag; const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    if (drag.mode === 'move') { f.x = Math.max(0, Math.min(1 - f.w, drag.ox + px - drag.sx)); f.y = Math.max(0, Math.min(1 - f.h, drag.oy + py - drag.sy)); }
    else { f.w = Math.max(0.01, Math.min(1 - f.x, drag.ow + px - drag.sx)); f.h = Math.max(0.008, Math.min(1 - f.y, drag.oh + py - drag.sy)); }
    const el = $(`.dz-f[data-id="${CSS.escape(f.id)}"]`, drag.L);
    if (el) Object.assign(el.style, { left: f.x * 100 + '%', top: f.y * 100 + '%', width: f.w * 100 + '%', height: f.h * 100 + '%' });
  });
  const end = () => { if (drag) { if (drag.f.x !== drag.ox || drag.f.y !== drag.oy || drag.f.w !== drag.ow || drag.f.h !== drag.oh) setDirty(true); drag = null; } };
  host.addEventListener('pointerup', end); host.addEventListener('pointercancel', end);
  const onKey = e => {
    if (!document.body.contains(host)) return document.removeEventListener('keydown', onKey);
    if (e.target.closest('input, textarea, select') || !edit) return;
    const f = fields.find(x => x.id === sel);
    if (e.key === 'Escape') { sel = null; tool = null; layers().forEach(x => x.classList.remove('placing')); drawFields(); renderProps(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); guard(save)(); return; }
    if (!f) return;
    const step = e.shiftKey ? 0.01 : 0.002;
    if (e.key === 'Delete' || e.key === 'Backspace') { fields = fields.filter(x => x.id !== f.id); sel = null; setDirty(true); drawFields(); renderProps(); e.preventDefault(); }
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) { f.x = Math.max(0, Math.min(1 - f.w, f.x + mv[0])); f.y = Math.max(0, Math.min(1 - f.h, f.y + mv[1])); setDirty(true); drawFields(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);
  drawFields(); renderProps();
}

// ---------------------------------------------------------------------------
// POS settings (admin): rent-to-own rate sheet, deposits, contract messages
// ---------------------------------------------------------------------------
async function posSettings() {
  const s = await api('GET', '/api/admin/settings');
  const rto = { ...DEFAULT_RTO, ...(s.rto || {}) };
  let terms = (rto.terms || []).map(t => ({ ...t }));
  const T = (k, label, o = {}) => `<label class="fld ${o.full ? 'full' : ''}"><span>${label}</span>${o.area ? `<textarea name="${k}" style="min-height:${o.h || 90}px">${esc(s[k] ?? '')}</textarea>` : `<input name="${k}" type="${o.type || 'text'}" step="any" value="${esc(s[k] ?? '')}" placeholder="${esc(o.ph || '')}">`}${o.help ? `<small>${o.help}</small>` : ''}</label>`;
  $('#main').innerHTML = head('Point of sale', 'Your rent-to-own rate sheet, deposits and the messages customers get.', '<button class="btn primary" id="psave">Save</button>') + tabs('settings') + `
  <div class="grid" style="gap:16px">
    <div class="card card-pad"><h2>Rent to own</h2><p class="muted" style="margin:2px 0 12px">Monthly rental = cash price (building + delivery, before tax) × term factor ÷ months. Enter the factors from your RTO company's rate sheet. Reps can override the monthly amount on a contract.</p>
      <div class="form"><label class="fld"><span>RTO company name</span><input id="rCo" value="${esc(rto.company || '')}" placeholder="e.g. ABC Rent-to-Own"></label>
        <label class="fld"><span>Default term</span><select id="rDef"></select></label>
        <label class="fld"><span>Due at signing (number of monthly payments)</span><input id="rDep" type="number" step="0.5" min="0" value="${esc(rto.deposit_payments ?? 1)}"></label>
        <label class="fld"><span>Damage waiver (LDW) per month ($)</span><input id="rLdw" type="number" step="0.01" min="0" value="${esc(rto.ldw_monthly ?? 0)}"></label>
        <label class="fld"><span>Tax rate on rental (%)</span><input id="rTax" type="number" step="0.001" min="0" value="${esc(rto.tax_rate ?? '')}" placeholder="Same as sales tax (${esc(s.tax_rate || 0)}%)"></label><div></div>
        <div class="fld full"><span>Terms</span><table class="mini" style="max-width:520px"><tr><th>Months</th><th>Factor</th><th>Example on $5,000</th><th></th></tr><tbody id="rRows"></tbody></table><button type="button" class="btn ghost sm" id="rAdd" style="margin-top:6px;justify-self:start">+ Add term</button></div></div></div>
    <div class="card card-pad"><h2>Contracts</h2><div class="form" style="margin-top:10px">
      ${T('cash_deposit_pct', 'Default cash deposit (% of total)', { type: 'number' })}${T('contract_link_days', 'Signing links expire after (days)', { type: 'number' })}
      ${T('timezone', 'Time zone for dates on contracts', { ph: 'America/Chicago', help: 'e.g. America/Chicago, America/New_York, America/Denver' })}${T('company_address', 'Company address (for contracts)')}
      ${T('esign_consent_text', 'E-sign consent text (shown before signing)', { area: true, full: true, help: 'Leave blank for the standard ESIGN consent wording.' })}
      <label class="fld full"><label class="chk"><input type="checkbox" name="send_signed_copy" ${s.send_signed_copy !== false ? 'checked' : ''}>Email the signed PDF to the customer automatically (or text a download link if there's no email)</label></label></div></div>
    <div class="card card-pad"><h2>Messages</h2><p class="muted" style="margin:2px 0 10px">Merge tags: {{signer.first_name}}, {{link}}, {{contract.number}}, {{shed.description}}, {{company.name}}, {{company.phone}}, {{sales_rep.name}}, {{pricing.total}}, {{rto.monthly_total}}</p><div class="form">
      ${T('contract_sms', 'Signing link — text', { area: true, full: true })}${T('contract_email_subject', 'Signing link — email subject', { full: true })}${T('contract_email_body', 'Signing link — email', { area: true, full: true, h: 160 })}
      ${T('signed_customer_email_subject', 'Signed copy — email subject', { full: true })}${T('signed_customer_email_body', 'Signed copy — email', { area: true, full: true, h: 120 })}${T('signed_customer_sms', 'Signed copy — text (when there is no email)', { area: true, full: true })}</div></div>
  </div>`;
  wireTabs();
  const drawTerms = () => {
    $('#rRows').innerHTML = terms.map((t, i) => `<tr><td><input type="number" data-m="${i}" value="${esc(t.months)}" min="1"></td><td><input type="number" step="0.001" data-f="${i}" value="${esc(t.factor)}" min="0"></td><td class="muted">${usd(5000 * Number(t.factor || 0) / Number(t.months || 1))}/mo</td><td><button type="button" class="icon-btn" data-rm="${i}">${TRASH}</button></td></tr>`).join('');
    $('#rDef').innerHTML = terms.map(t => `<option value="${t.months}" ${Number(t.months) === Number(rto.default_term) ? 'selected' : ''}>${t.months} months</option>`).join('');
  };
  drawTerms();
  $('#rRows').onchange = e => { const i = e.target.dataset.m ?? e.target.dataset.f; if (i == null) return; if (e.target.dataset.m != null) terms[i].months = Number(e.target.value); else terms[i].factor = Number(e.target.value); drawTerms(); };
  $('#rRows').onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { terms.splice(Number(b.dataset.rm), 1); drawTerms(); } };
  $('#rAdd').onclick = () => { terms.push({ months: 72, factor: 2 }); drawTerms(); };
  $('#psave').onclick = guard(async () => {
    const valid = terms.filter(t => Number(t.months) > 0 && Number(t.factor) > 0);
    if (!valid.length) throw new Error('Add at least one rent-to-own term');
    const d = { rto: { company: $('#rCo').value, terms: valid.sort((a, b) => a.months - b.months), deposit_payments: Number($('#rDep').value) || 0, ldw_monthly: Number($('#rLdw').value) || 0, tax_rate: $('#rTax').value === '' ? null : Number($('#rTax').value), default_term: Number($('#rDef').value) } };
    for (const el of $$('#main [name]')) d[el.name] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) || 0 : el.value);
    await api('PUT', '/api/admin/settings', d); toast('Saved');
  });
}
