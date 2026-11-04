// CRM pages: contacts, contact record (two-way text/email), conversations inbox, pipeline board,
// tasks, the production & delivery board, and Messaging & alerts settings.
import { $, $$, esc, api, toast, guard, openModal, closeModal, confirmBox, fmt, fmtDate, saveFile, head, me, settings, can, isAdmin, onLive, hashQuery, downloadDrawings, CONFIG_URL, TRASH, COPY , planUrl , live } from './admin.js';

const SOURCES = ['Manual', 'Walk-in', 'Phone call', 'Website', 'Facebook', 'Google', 'Referral', 'Repeat customer', 'Other'];
const initials = c => (((String(c.first_name || c.email || c.phone || '?').trim()[0]) || '?') + ((String(c.last_name || '').trim()[0]) || '')).toUpperCase();
const fullName = c => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || 'Unnamed';
const ago = s => {
  if (!s) return '';
  const d = (Date.now() - new Date(String(s).replace(' ', 'T') + 'Z')) / 1000;
  if (d < 60) return 'just now'; if (d < 3600) return Math.floor(d / 60) + 'm ago'; if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 86400 * 7) return Math.floor(d / 86400) + 'd ago'; return fmtDate(s).replace(/,? \d+:\d+.*$/, '');
};
const tel = p => String(p || '').replace(/[^\d+]/g, '');
const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const segs = t => { const n = [...String(t || '')].length; const uni = /[^\x00-\x7F£¥èéùìòÇØøÅå]/.test(t || ''); const per = uni ? 70 : 160; return n <= per ? 1 : Math.ceil(n / (uni ? 67 : 153)); };
let usersCache = null;
const users = async () => (usersCache ||= await api('GET', '/api/crm/users'));
let msgStatus = null;
const messaging = async () => (msgStatus ||= (await api('GET', '/api/crm/me')).messaging);
let snippetsCache = null;
const snippets = async () => (snippetsCache ||= can('crm.view') ? await api('GET', '/api/crm/snippets') : []);
let pipesCache = null;
const pipelines = async (force) => (pipesCache = (!force && pipesCache) || await api('GET', '/api/crm/pipelines'));

// ---------------------------------------------------------------------------
// Contacts list
// ---------------------------------------------------------------------------
export async function crmContacts(arg, rest = []) {
  if (arg === 'contacts' && rest[1]) return contactRecord(Number(rest[1]));
  const pipes = await pipelines();
  const sales = pipes.find(p => p.kind === 'sales');
  const stageName = id => sales?.stages.find(s => s.id === id)?.name || id || '';
  const qp = hashQuery();
  $('#main').innerHTML = head('Contacts', 'Every lead from the 3D builder lands here automatically. Add walk-ins and phone leads by hand.',
    `<button class="btn ghost" id="cExport">Export CSV</button><button class="btn primary" id="cAdd">+ Add lead</button>`) + `
    <div class="row" style="margin-bottom:12px"><input class="in" id="cq" placeholder="Search name, phone, email, city" style="max-width:320px" value="${esc(qp.get('q') || '')}">
      <select class="in" id="cf" style="max-width:190px"><option value="">Everyone</option><option value="unread">Unread messages</option><option value="me">Assigned to me</option><option value="none">Unassigned</option></select>
      <select class="in" id="cs" style="max-width:190px"><option value="recent">Recent activity</option><option value="created">Newest first</option><option value="messages">Latest message</option><option value="name">Name A–Z</option></select>
      <span class="muted" id="ccount"></span></div>
    <div class="card tbl-wrap" id="ctable"><div class="empty">Loading…</div></div>`;
  const all = await users();
  const uname = id => all.find(u => u.id === id)?.name || '';
  const render = async () => {
    const f = $('#cf').value;
    const p = new URLSearchParams({ q: $('#cq').value, sort: $('#cs').value, limit: 300 });
    if (f === 'unread') p.set('unread', 1); if (f === 'me') p.set('assigned', 'me'); if (f === 'none') p.set('assigned', 'none');
    const res = await api('GET', '/api/crm/contacts?' + p);
    live('#ccount').textContent = `${res.total} contact${res.total === 1 ? '' : 's'}`;
    live('#ctable').innerHTML = res.data.length ? `<table class="tbl"><tr><th>Name</th><th>Phone / email</th><th>Stage</th><th>Tags</th><th>Source</th><th>Assigned</th><th>Last activity</th></tr>
      ${res.data.map(c => `<tr class="click" data-id="${c.id}"><td><div class="who"><span class="av">${esc(initials(c))}</span><div><b>${esc(fullName(c))}</b>${c.last_message ? `<span class="muted trunc" style="font-size:12px">${esc(c.last_message)}</span>` : ''}</div>${c.unread ? '<span class="dot-unread" title="Unread"></span>' : ''}</div></td>
      <td>${esc(c.phone || '')}<div class="muted" style="font-size:12.5px">${esc(c.email || '')}</div></td>
      <td>${c.stage ? `<span class="pill">${esc(stageName(c.stage))}</span>` : ''}</td>
      <td>${(c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</td>
      <td class="muted">${esc(c.source || '')}</td><td>${esc(uname(c.assigned_to))}</td><td class="muted">${ago(c.last_activity_at)}</td></tr>`).join('')}</table>`
      : '<div class="empty">No contacts yet. Leads from the 3D builder show up here automatically, or click <b>+ Add lead</b>.</div>';
  };
  let t; $('#cq').oninput = () => { clearTimeout(t); t = setTimeout(guard(render), 250); };
  $('#cf').onchange = $('#cs').onchange = guard(render);
  $('#ctable').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = `#/crm/contacts/${tr.dataset.id}`; };
  $('#cAdd').onclick = () => addLeadModal();
  $('#cExport').onclick = guard(async () => {
    const res = await api('GET', '/api/crm/contacts?limit=500&sort=created');
    const rows = [['First', 'Last', 'Email', 'Phone', 'Address', 'City', 'State', 'ZIP', 'Source', 'Tags', 'Stage', 'Created']];
    for (const c of res.data) rows.push([c.first_name, c.last_name, c.email, c.phone, c.address, c.city, c.state, c.zip, c.source, (c.tags || []).join('; '), stageName(c.stage), c.created_at]);
    saveFile(new Blob([rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' }), 'contacts.csv');
  });
  onLive(type => { if (type === 'contact' || type === 'message') render().catch(() => {}); });
  await render();
}

async function addLeadModal(prefill = {}) {
  const all = await users();
  const pipes = await pipelines(); const sales = pipes.find(p => p.kind === 'sales');
  openModal({
    title: 'Add lead', narrow: true,
    body: `<form class="form" id="lf">
      <label class="fld"><span>First name</span><input name="first_name" value="${esc(prefill.first_name || '')}" autocomplete="off"></label>
      <label class="fld"><span>Last name</span><input name="last_name" autocomplete="off"></label>
      <label class="fld"><span>Mobile phone</span><input name="phone" type="tel" placeholder="(555) 555-5555"></label>
      <label class="fld"><span>Email</span><input name="email" type="email"></label>
      <label class="fld full"><span>Address</span><input name="address"></label>
      <label class="fld"><span>City</span><input name="city"></label>
      <label class="fld"><span>State / ZIP</span><div class="row" style="flex-wrap:nowrap"><input name="state" style="width:40%" class="in"><input name="zip" style="width:60%" class="in"></div></label>
      <label class="fld"><span>Source</span><select name="source">${SOURCES.map(s => `<option>${s}</option>`).join('')}</select></label>
      <label class="fld"><span>Tags</span><input name="tags" placeholder="e.g. 12x24, financing"></label>
      <div class="section-t">Opportunity</div>
      <label class="fld"><span>What are they looking for?</span><input name="opportunity_title" placeholder="e.g. 12x24 Lofted Barn"></label>
      <label class="fld"><span>Estimated value ($)</span><input name="value" type="number" step="1"></label>
      <label class="fld"><span>Stage</span><select name="stage">${(sales?.stages || []).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>Assign to</span><select name="assigned_to">${all.filter(u => ['admin', 'sales'].includes(u.role)).map(u => `<option value="${u.id}" ${u.id === me.id ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join('')}</select></label>
      <label class="fld full"><span>Note</span><textarea name="note" placeholder="What did they ask about?"></textarea></label>
      <label class="chk full"><input type="checkbox" name="sms_consent">Customer agreed to receive text messages</label>
      <div class="err full" id="lerr" hidden></div></form>`,
    foot: `<span></span><div class="row"><button class="btn ghost" data-x2>Cancel</button><button class="btn primary" id="lsave">Add lead</button></div>`,
    onMount: root => {
      $('[data-x2]', root).onclick = closeModal;
      $('#lsave', root).onclick = async () => {
        const f = $('#lf', root); const d = Object.fromEntries(new FormData(f));
        d.tags = String(d.tags || '').split(',').map(x => x.trim()).filter(Boolean); d.sms_consent = f.sms_consent.checked; d.assigned_to = Number(d.assigned_to) || null;
        const err = $('#lerr', root); err.hidden = true;
        try {
          const r = await fetch('/api/crm/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
          const j = await r.json();
          if (r.status === 409) { err.innerHTML = `${esc(j.error)} <a href="#/crm/contacts/${j.contact_id}">Open that contact</a>`; err.hidden = false; $('a', err).onclick = closeModal; return; }
          if (!r.ok) throw new Error(j.error || 'Could not save');
          closeModal(); toast('Lead added'); location.hash = `#/crm/contacts/${j.id}`;
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Conversation thread + composer (used by the contact record and the inbox)
// ---------------------------------------------------------------------------
function threadHTML(c) {
  const items = c.timeline || [];
  if (!items.length) return '<div class="empty">No messages yet. Send the first text or email below.</div>';
  return items.map(it => {
    if (it.kind === 'message') {
      const failed = it.status === 'failed';
      const stat = it.direction === 'in' ? '' : failed ? ` · not sent: ${esc(it.error || 'failed')}` : it.status === 'test' ? ' · test mode (not actually sent)' : it.status === 'delivered' ? ' · delivered' : ' · sent';
      return `<div class="bub ${it.direction} ${failed ? 'failed' : ''}">${it.channel === 'email' && it.subject ? `<span class="subj">✉ ${esc(it.subject)}</span>` : ''}${linkify(it.body)}<span class="meta">${it.channel === 'email' ? 'Email' : 'Text'}${it.user_name ? ' · ' + esc(it.user_name) : ''} · ${fmtDate(it.created_at)}${stat}</span></div>`;
    }
    if (it.type === 'note' || it.type === 'call') return `<div class="evt note"><b>${it.type === 'call' ? '📞 Call' : '📝 Note'}${it.user_name ? ' · ' + esc(it.user_name) : ''}</b> · ${fmtDate(it.created_at)}<br>${linkify(it.body)}</div>`;
    return `<div class="evt">${linkify(it.body)} · ${ago(it.created_at)}${it.user_name ? ' · ' + esc(it.user_name) : ''}</div>`;
  }).join('');
}
async function composerHTML(c, { notes = true } = {}) {
  const m = await messaging();
  const sn = await snippets();
  const warn = [];
  if (!m.sms && !m.email) warn.push(`Texting and email aren't set up yet${isAdmin() ? ' — <a href="#/messaging">set them up</a>' : ' — ask your admin'}. Messages will be saved but not delivered.`);
  if (m.test_mode) warn.push('Test mode is on: messages are logged here but not actually delivered.');
  return `<div class="composer">
    ${warn.length ? `<div class="callout warn" style="padding:8px 10px;font-size:12.5px">${warn.join('<br>')}</div>` : ''}
    <div class="ch"><button type="button" class="chb on" data-ch="sms">Text</button><button type="button" class="chb" data-ch="email">Email</button>${notes && can('crm.edit') ? '<button type="button" class="chb" data-ch="note">Note</button>' : ''}
      ${sn.length ? `<select class="in" id="snip" style="max-width:190px;margin-left:auto;padding:5px 8px;font-size:13px"><option value="">Saved replies…</option>${sn.map(s => `<option value="${s.id}" data-ch="${s.channel}">${esc(s.name)}${s.channel === 'email' ? ' (email)' : ''}</option>`).join('')}</select>` : ''}</div>
    <input id="msubj" placeholder="Subject" hidden>
    <textarea id="mbody" placeholder="${c.dnd_sms ? 'This contact opted out of texts (STOP).' : `Text ${esc(c.first_name || 'customer')}…`}"></textarea>
    <div class="send-row"><small class="muted" id="mhint">${c.phone ? 'To ' + esc(c.phone) : 'No mobile number on file'} · merge tags like {{contact.first_name}} work</small><button class="btn primary sm" id="msend">Send text</button></div></div>`;
}
function wireComposer(root, c, onSent) {
  let ch = 'sms';
  const body = $('#mbody', root), subj = $('#msubj', root), btn = $('#msend', root), hint = $('#mhint', root);
  const setCh = v => {
    ch = v; $$('[data-ch]', root).forEach(b => b.classList.toggle('on', b.dataset.ch === v && b.tagName === 'BUTTON'));
    subj.hidden = v !== 'email';
    btn.textContent = v === 'sms' ? 'Send text' : v === 'email' ? 'Send email' : 'Save note';
    body.placeholder = v === 'note' ? 'Internal note — only your team sees this' : v === 'email' ? `Email ${c.first_name || 'customer'}…` : (c.dnd_sms ? 'This contact opted out of texts (STOP).' : `Text ${c.first_name || 'customer'}…`);
    upd();
  };
  const upd = () => {
    if (ch === 'sms') hint.textContent = `${c.phone ? 'To ' + c.phone : 'No mobile number on file'} · ${[...body.value].length} chars · ${segs(body.value)} segment${segs(body.value) === 1 ? '' : 's'}`;
    else if (ch === 'email') hint.textContent = c.email ? 'To ' + c.email : 'No email on file';
    else hint.textContent = 'Notes are internal';
  };
  $$('button[data-ch]', root).forEach(b => (b.onclick = () => setCh(b.dataset.ch)));
  body.oninput = upd;
  const sn = $('#snip', root);
  if (sn) sn.onchange = async () => {
    const s = (await snippets()).find(x => String(x.id) === sn.value); sn.value = ''; if (!s) return;
    setCh(s.channel); body.value = s.body; if (s.subject) subj.value = s.subject; upd(); body.focus();
  };
  body.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') btn.click(); });
  btn.onclick = async () => {
    const text = body.value.trim(); if (!text) return body.focus();
    btn.disabled = true;
    try {
      if (ch === 'note') await api('POST', `/api/crm/contacts/${c.id}/notes`, { body: text });
      else await api('POST', `/api/crm/contacts/${c.id}/messages`, { channel: ch, body: text, subject: subj.value });
      body.value = ''; subj.value = ''; upd(); toast(ch === 'note' ? 'Note saved' : ch === 'sms' ? 'Text sent' : 'Email sent');
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; onSent && onSent(); }
  };
  setCh('sms');
  return { focus: v => { setCh(v); body.focus(); } };
}
const scrollEnd = el => { if (el) el.scrollTop = el.scrollHeight; };

// ---------------------------------------------------------------------------
// Contact record
// ---------------------------------------------------------------------------
async function contactRecord(id) {
  let c = await api('GET', `/api/crm/contacts/${id}`);
  const all = await users();
  const pipes = await pipelines();
  if (c.unread) api('POST', `/api/crm/contacts/${id}/read`).catch(() => {});
  const staff = all.filter(u => ['admin', 'sales'].includes(u.role));
  const latestQuote = () => c.quotes[0];
  $('#main').innerHTML = `<div class="head"><div class="who"><a href="#/crm" class="icon-btn" title="Back to contacts">‹</a><span class="av lg">${esc(initials(c))}</span><div><h1 id="cName">${esc(fullName(c))}</h1><p style="margin:2px 0 0" class="muted">${esc(c.source || '')}${c.created_at ? ' · added ' + ago(c.created_at) : ''}</p></div></div>
    <div class="row">${c.phone ? `<a class="btn ghost" href="tel:${esc(tel(c.phone))}">Call</a>` : ''}<button class="btn ghost" id="bText">Text</button><button class="btn ghost" id="bEmail">Email</button>
      <a class="btn ghost" href="${esc(CONFIG_URL)}" target="_blank" title="Design a building for this customer in the dealer configurator">Design in 3D ↗</a>
      ${can('pos.create') ? `<a class="btn primary" href="#/pos/new?${latestQuote() ? 'quote=' + latestQuote().id : 'contact=' + c.id}">New contract</a>` : ''}
      ${can('crm.delete') ? `<button class="icon-btn" id="bDel" title="Delete contact">${TRASH}</button>` : ''}</div></div>
  <div class="crm3">
    <div class="crm-side" id="leftCol"></div>
    <div class="card thread-wrap"><div class="thread" id="thread">${threadHTML(c)}</div><div id="composer"></div></div>
    <div class="crm-side" id="rightCol"></div>
  </div>`;
  live('#composer').innerHTML = await composerHTML(c);
  let comp = wireComposer($('#composer'), c, () => reload());
  $('#bText').onclick = () => comp.focus('sms'); $('#bEmail').onclick = () => comp.focus('email');
  if ($('#bDel')) $('#bDel').onclick = guard(async () => { if (!confirmBox(`Delete ${fullName(c)} and all their messages, notes and deals? Quotes and contracts are kept.`)) return; await api('DELETE', `/api/crm/contacts/${id}`); toast('Contact deleted'); location.hash = '#/crm'; });
  scrollEnd($('#thread'));

  const renderLeft = () => {
    $('#leftCol').innerHTML = `<div class="card card-pad"><h3>Contact <button class="btn link sm" id="saveC" style="padding:0">Save</button></h3><form class="inline-edit" id="cf">
      <div class="row" style="flex-wrap:nowrap"><label style="flex:1">First<input name="first_name" value="${esc(c.first_name || '')}"></label><label style="flex:1">Last<input name="last_name" value="${esc(c.last_name || '')}"></label></div>
      <label>Mobile<input name="phone" type="tel" value="${esc(c.phone || '')}"></label><label>Email<input name="email" type="email" value="${esc(c.email || '')}"></label>
      <label>Address<input name="address" value="${esc(c.address || '')}"></label>
      <div class="row" style="flex-wrap:nowrap"><label style="flex:2">City<input name="city" value="${esc(c.city || '')}"></label><label style="flex:1">State<input name="state" value="${esc(c.state || '')}"></label><label style="flex:1.3">ZIP<input name="zip" value="${esc(c.zip || '')}"></label></div>
      <label>Tags<input name="tags" value="${esc((c.tags || []).join(', '))}" placeholder="comma separated"></label>
      <label>Source<input name="source" value="${esc(c.source || '')}" list="srcList"></label><datalist id="srcList">${SOURCES.map(s => `<option>${s}</option>`).join('')}</datalist>
      <label>Assigned to<select name="assigned_to"><option value="">Nobody</option>${staff.map(u => `<option value="${u.id}" ${u.id === c.assigned_to ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join('')}</select></label>
      <label class="chk" style="font-size:13px;color:var(--ink)"><input type="checkbox" name="sms_consent" ${c.sms_consent ? 'checked' : ''}>OK to text (consent)</label>
      <label class="chk" style="font-size:13px;color:var(--ink)"><input type="checkbox" name="dnd_sms" ${c.dnd_sms ? 'checked' : ''}>Do not text</label>
      <label class="chk" style="font-size:13px;color:var(--ink)"><input type="checkbox" name="dnd_email" ${c.dnd_email ? 'checked' : ''}>Do not email</label>
      ${c.address ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([c.address, c.city, c.state, c.zip].filter(Boolean).join(', '))}" target="_blank" rel="noopener" style="font-size:13px">Open address in Google Maps ↗</a>` : ''}
    </form></div>`;
    if (!can('crm.edit')) $$('#cf input, #cf select').forEach(i => (i.disabled = true));
    $('#saveC').onclick = guard(async () => {
      const f = $('#cf'); const d = Object.fromEntries(new FormData(f));
      for (const k of ['sms_consent', 'dnd_sms', 'dnd_email']) d[k] = f[k].checked;
      d.tags = String(d.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      await api('PATCH', `/api/crm/contacts/${id}`, d); toast('Saved'); await reload(true);
    });
  };
  const renderRight = () => {
    const opps = c.opportunities;
    const pipeOf = o => pipes.find(p => p.id === o.pipeline_id);
    live('#rightCol').innerHTML = `
      <div class="card card-pad"><h3>Opportunities</h3><div class="mini-list">${opps.length ? opps.map(o => `<div class="mini-item">
        <div class="row"><b>${esc(o.order_number ? o.order_number + ' · ' : '')}${esc(o.title || 'Opportunity')}</b>${o.value != null ? `<span>${fmt(o.value)}</span>` : ''}</div>
        <div class="muted" style="font-size:12px">${esc(o.pipeline_name || '')}${o.delivery_date ? ' · delivery ' + esc(o.delivery_date) : ''}</div>
        <div class="row" style="flex-wrap:nowrap"><select data-ostage="${o.id}" ${can('crm.edit') ? '' : 'disabled'}>${(pipeOf(o)?.stages || []).map(s => `<option value="${esc(s.id)}" ${s.id === o.stage ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
          ${pipeOf(o)?.kind === 'sales' ? `<select data-ostatus="${o.id}" ${can('crm.edit') ? '' : 'disabled'}>${['open', 'won', 'lost'].map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : ''}</div></div>`).join('') : '<div class="muted" style="font-size:13px">None yet.</div>'}</div>
        ${can('crm.edit') ? '<button class="btn link sm" id="addOpp" style="padding:6px 0 0">+ Add opportunity</button>' : ''}</div>
      <div class="card card-pad"><h3>3D designs</h3><div class="mini-list">${c.quotes.length ? c.quotes.map(q => `<div class="mini-item"><div class="row"><b>${esc(q.number)}</b><span>${fmt(q.total)}</span></div>
        <div class="muted" style="font-size:12px">${esc(q.style_name)} ${esc(q.size_label)} · ${ago(q.created_at)}</div>
        <div class="row"><a class="btn ghost sm" href="/?q=${esc(q.token)}" target="_blank">Open 3D ↗</a><a class="btn ghost sm" href="#/quotes/${q.id}">Quote</a>${can('pos.create') ? `<a class="btn primary sm" href="#/pos/new?quote=${q.id}">Contract</a>` : ''}</div></div>`).join('') : '<div class="muted" style="font-size:13px">No 3D designs yet. Click <b>Design in 3D</b> and submit it with this customer\'s email.</div>'}</div></div>
      <div class="card card-pad"><h3>Contracts</h3><div class="mini-list">${c.contracts.length ? c.contracts.map(k => `<a class="mini-item" href="#/pos/contracts/${k.id}" style="text-decoration:none;color:inherit"><div class="row"><b>${esc(k.number)}</b><span class="pill ${esc(k.status)}">${esc(statusLabel(k.status))}</span></div>
        <div class="muted" style="font-size:12px">${k.sale_type === 'rto' ? 'Rent to own' : 'Cash'} · ${fmt(k.total)} · ${ago(k.created_at)}</div></a>`).join('') : '<div class="muted" style="font-size:13px">None yet.</div>'}</div></div>
      <div class="card card-pad"><h3>Tasks</h3><div id="tasks">${c.tasks.length ? c.tasks.map(t => taskRow(t)).join('') : '<div class="muted" style="font-size:13px;margin-bottom:8px">No tasks.</div>'}</div>
        ${can('crm.edit') ? `<form id="tf" class="row" style="margin-top:8px;flex-wrap:nowrap"><input class="in" name="title" placeholder="Call back about financing…" style="flex:2"><input class="in" type="date" name="due_at" style="flex:1;min-width:120px"><button class="btn ghost sm">Add</button></form>` : ''}</div>`;
    $('#rightCol').onchange = guard(async e => {
      const t = e.target;
      if (t.dataset.ostage) { await api('PATCH', `/api/crm/opportunities/${t.dataset.ostage}`, { stage: t.value }); toast('Stage updated'); reload(); }
      if (t.dataset.ostatus) { await api('PATCH', `/api/crm/opportunities/${t.dataset.ostatus}`, { status: t.value }); toast('Updated'); reload(); }
      if (t.dataset.task) { await api('PATCH', `/api/crm/tasks/${t.dataset.task}`, { done: t.checked }); reload(); }
    });
    if ($('#tf')) $('#tf').onsubmit = guard(async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); if (!d.title.trim()) return; await api('POST', `/api/crm/contacts/${id}/tasks`, d); toast('Task added'); reload(); });
    if ($('#addOpp')) $('#addOpp').onclick = guard(async () => {
      const title = prompt('What is the customer looking for? (e.g. 10x16 Garage)'); if (!title) return;
      await api('POST', '/api/crm/opportunities', { contact_id: id, title }); reload();
    });
  };
  let leftDirty = false;
  const reload = async (forceLeft = false) => {
    c = await api('GET', `/api/crm/contacts/${id}`);
    const th = $('#thread'); if (!th) return;
    const atEnd = th.scrollHeight - th.scrollTop - th.clientHeight < 80;
    th.innerHTML = threadHTML(c); if (atEnd) scrollEnd(th);
    renderRight();
    if (forceLeft || !leftDirty) { renderLeft(); leftDirty = false; live('#cName').textContent = fullName(c); }
  };
  renderLeft(); renderRight();
  $('#leftCol').addEventListener('input', () => { leftDirty = true; });
  onLive((type, d) => {
    if ((type === 'message' || type === 'contact') && Number(d.contact_id ?? d.id) === id) { if (d.direction === 'in') api('POST', `/api/crm/contacts/${id}/read`).catch(() => {}); reload(); }
    if (type === 'contact' && d.deleted && d.id === id) location.hash = '#/crm';
    if (type === 'opportunity' || type === 'contract') reload();
  });
}
const statusLabel = s => ({ draft: 'Draft', sent: 'Sent', viewed: 'Opened', partial: 'Partly signed', completed: 'Signed', void: 'Void' }[s] || s);
function taskRow(t) {
  const late = !t.done_at && t.due_at && t.due_at < new Date().toISOString().slice(0, 10);
  return `<label class="task-row ${t.done_at ? 'done' : ''}"><input type="checkbox" data-task="${t.id}" ${t.done_at ? 'checked' : ''} ${can('crm.edit') ? '' : 'disabled'}><span>${esc(t.title)}<small class="${late ? 'late' : ''}">${t.due_at ? (late ? 'Overdue · ' : 'Due ') + esc(t.due_at) : 'No due date'}${t.assigned_name ? ' · ' + esc(t.assigned_name) : ''}</small></span></label>`;
}

// ---------------------------------------------------------------------------
// Conversations inbox
// ---------------------------------------------------------------------------
export async function crmConversations(arg) {
  let current = arg ? Number(arg) : null;
  $('#main').innerHTML = head('Conversations', 'Texts and emails with every customer. Replies come in live.', '<button class="btn ghost" id="newConv">+ New message</button>') + `
    <div class="card inbox"><div class="inbox-list"><div style="padding:10px;border-bottom:1px solid var(--line);display:grid;gap:8px"><input class="in" id="iq" placeholder="Search"><label class="chk" style="font-size:13px"><input type="checkbox" id="iun">Unread only</label></div><div id="ilist"></div></div>
    <div class="inbox-pane" id="ipane"><div class="empty">Pick a conversation.</div></div></div>`;
  const renderList = async () => {
    const p = new URLSearchParams({ q: $('#iq').value }); if ($('#iun').checked) p.set('unread', 1);
    const rows = await api('GET', '/api/crm/conversations?' + p);
    live('#ilist').innerHTML = rows.length ? rows.map(r => `<div class="inbox-item ${r.id === current ? 'on' : ''}" data-id="${r.id}"><span class="av">${esc(initials(r))}</span><div class="t"><b>${esc(fullName(r))}</b><span>${r.last_direction === 'out' ? 'You: ' : ''}${r.last_channel === 'email' ? '✉ ' : ''}${esc(r.last_message || '')}</span></div><div style="display:grid;justify-items:end;gap:4px"><small>${ago(r.last_message_at)}</small>${r.unread ? '<span class="dot-unread"></span>' : ''}</div></div>`).join('')
      : '<div class="empty">No conversations yet.</div>';
  };
  const openConv = async id => {
    current = id; history.replaceState(null, '', `#/conversations/${id}`);
    $$('#ilist .inbox-item').forEach(x => x.classList.toggle('on', Number(x.dataset.id) === id));
    const c = await api('GET', `/api/crm/contacts/${id}`);
    if (c.unread) await api('POST', `/api/crm/contacts/${id}/read`).catch(() => {});
    live('#ipane').innerHTML = `<div class="inbox-head"><div class="who"><span class="av">${esc(initials(c))}</span><div><b>${esc(fullName(c))}</b><span class="muted" style="font-size:12.5px">${esc([c.phone, c.email].filter(Boolean).join(' · '))}</span></div></div><a class="btn ghost sm" href="#/crm/contacts/${c.id}">Open contact</a></div>
      <div class="thread-wrap"><div class="thread" id="thread">${threadHTML(c)}</div><div id="composer"></div></div>`;
    live('#composer').innerHTML = await composerHTML(c);
    wireComposer($('#composer'), c, async () => { const n = await api('GET', `/api/crm/contacts/${id}`); live('#thread').innerHTML = threadHTML(n); scrollEnd($('#thread')); renderList(); });
    scrollEnd($('#thread')); renderList();
  };
  $('#ilist').onclick = e => { const it = e.target.closest('.inbox-item'); if (it) guard(openConv)(Number(it.dataset.id)); };
  let t; $('#iq').oninput = () => { clearTimeout(t); t = setTimeout(guard(renderList), 250); }; $('#iun').onchange = guard(renderList);
  $('#newConv').onclick = async () => {
    const q = prompt('Who do you want to message? Type a name, phone or email'); if (!q) return;
    const r = await api('GET', '/api/crm/contacts?limit=5&q=' + encodeURIComponent(q));
    if (!r.data.length) { if (confirmBox('No contact found. Add a new lead?')) addLeadModal({ first_name: q }); return; }
    openConv(r.data[0].id);
  };
  onLive(async (type, d) => {
    if (type !== 'message') return;
    renderList();
    if (current && Number(d.contact_id) === current && $('#thread')) {
      const n = await api('GET', `/api/crm/contacts/${current}`); live('#thread').innerHTML = threadHTML(n); scrollEnd($('#thread'));
      if (d.direction === 'in') api('POST', `/api/crm/contacts/${current}/read`).catch(() => {});
    }
  });
  await renderList();
  if (current) await openConv(current);
}

// ---------------------------------------------------------------------------
// Kanban board (sales pipeline + production & delivery)
// ---------------------------------------------------------------------------
function kanban(root, pipe, cards, { cardHTML, canDrop, onMove, onOpen, colExtra }) {
  const groups = [];
  root.innerHTML = `<div class="kanban">${pipe.stages.map(st => {
    const list = cards.filter(c => c.stage === st.id);
    const showGroup = st.group && !groups.includes(st.group) && groups.push(st.group);
    return `<div class="kcol" data-stage="${esc(st.id)}"><div class="kcol-h"><div>${showGroup ? `<div class="kgroup">${esc(st.group === 'delivery' ? 'Delivery' : 'Production')}</div>` : ''}<b>${esc(st.name)}</b></div><span>${list.length}${colExtra ? ' · ' + colExtra(list) : ''}</span></div>
      <div class="kcol-body">${list.map(c => `<div class="kcard" draggable="true" data-id="${c.id}">${cardHTML(c)}
        <select class="kmove" data-move="${c.id}" aria-label="Move to stage"><option value="">Move to…</option>${pipe.stages.filter(s => s.id !== st.id).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div>`).join('')}</div></div>`;
  }).join('')}</div>`;
  let dragId = null;
  root.ondragstart = e => { const k = e.target.closest('.kcard'); if (!k) return; dragId = Number(k.dataset.id); k.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragId)); };
  root.ondragend = e => { e.target.closest?.('.kcard')?.classList.remove('dragging'); $$('.kcol.over', root).forEach(x => x.classList.remove('over')); };
  root.ondragover = e => { const col = e.target.closest('.kcol'); if (!col || dragId == null) return; if (canDrop && !canDrop(cards.find(c => c.id === dragId), col.dataset.stage)) return; e.preventDefault(); $$('.kcol.over', root).forEach(x => x !== col && x.classList.remove('over')); col.classList.add('over'); };
  root.ondragleave = e => { const col = e.target.closest('.kcol'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('over'); };
  root.ondrop = e => { const col = e.target.closest('.kcol'); if (!col || dragId == null) return; e.preventDefault(); col.classList.remove('over'); const c = cards.find(x => x.id === dragId); dragId = null; if (c && c.stage !== col.dataset.stage) onMove(c, col.dataset.stage); };
  root.onchange = e => { const s = e.target.closest('[data-move]'); if (s && s.value) { const c = cards.find(x => x.id === Number(s.dataset.move)); onMove(c, s.value); } };
  root.onclick = e => { if (e.target.closest('select, a, button')) return; const k = e.target.closest('.kcard'); if (k) onOpen(cards.find(c => c.id === Number(k.dataset.id))); };
}
const daysIn = s => { const d = Math.floor((Date.now() - new Date(String(s).replace(' ', 'T') + 'Z')) / 864e5); return d <= 0 ? 'today' : d + 'd'; };

export async function crmPipeline() {
  const pipes = (await pipelines(true)).filter(p => p.kind === 'sales');
  let pid = Number(hashQuery().get('p')) || pipes[0]?.id;
  $('#main').innerHTML = head('Pipeline', 'Drag cards between stages. Contracts move deals along automatically: sent → "Contract sent", signed → "Sold".',
    `${pipes.length > 1 ? `<select class="in" id="pp">${pipes.map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
     <select class="in" id="pf" style="max-width:170px"><option value="">Everyone's deals</option><option value="me">My deals</option></select>
     <label class="chk" style="font-size:13px"><input type="checkbox" id="pwon">Show won & lost</label>${can('crm.settings') ? '<button class="btn ghost" id="pEdit">Edit stages</button>' : ''}<button class="btn primary" id="pAdd">+ Add lead</button>`) + '<div id="board"><div class="empty">Loading…</div></div>';
  const render = async () => {
    const res = await api('GET', `/api/crm/opportunities?pipeline_id=${pid}${$('#pwon').checked ? '&all=1' : ''}`);
    let cards = res.data;
    if (!$('#pwon').checked) cards = cards.filter(c => c.status === 'open' || c.stage === res.pipeline.stages.at(-1)?.id);
    if ($('#pf').value === 'me') cards = cards.filter(c => c.assigned_to === me.id);
    kanban(live('#board'), res.pipeline, cards, {
      colExtra: list => fmt(list.reduce((a, c) => a + (Number(c.value) || 0), 0)).replace(/\.00$/, ''),
      cardHTML: c => `<div class="row"><b>${esc(fullName(c))}</b>${c.unread ? '<span class="dot-unread" title="Unread message"></span>' : ''}</div>
        <div>${esc(c.title || '')}</div>
        <div class="row"><span class="muted">${c.quote_number ? esc(c.quote_number) + ' · ' : ''}${daysIn(c.stage_changed_at)}</span><b>${fmt(c.value).replace(/\.00$/, '')}</b></div>
        ${c.latest_contract_status ? `<div><span class="pill ${esc(c.latest_contract_status)}">Contract ${esc(statusLabel(c.latest_contract_status).toLowerCase())}</span></div>` : ''}
        ${c.status !== 'open' ? `<div><span class="pill ${c.status}">${esc(c.status)}</span></div>` : ''}${c.assigned_name ? `<div class="muted">${esc(c.assigned_name)}</div>` : ''}`,
      onMove: guard(async (c, stage) => { await api('PATCH', `/api/crm/opportunities/${c.id}`, { stage }); toast('Moved'); render(); }),
      onOpen: c => { location.hash = `#/crm/contacts/${c.contact_id}`; },
    });
  };
  if ($('#pp')) $('#pp').onchange = () => { pid = Number($('#pp').value); render(); };
  $('#pf').onchange = $('#pwon').onchange = guard(render);
  $('#pAdd').onclick = () => addLeadModal();
  if ($('#pEdit')) $('#pEdit').onclick = () => editStages(pipes.find(p => p.id === pid), render);
  onLive(type => { if (type === 'opportunity' || type === 'contact' || type === 'contract' || type === 'message') render().catch(() => {}); });
  await render();
}
function editStages(pipe, done) {
  let rows = pipe.stages.map(s => ({ ...s }));
  const draw = root => {
    $('#stRows', root).innerHTML = rows.map((s, i) => `<div class="row" style="flex-wrap:nowrap;margin-bottom:6px"><input class="in" data-i="${i}" value="${esc(s.name)}"><button class="icon-btn" data-up="${i}" title="Move up">↑</button><button class="icon-btn" data-rm="${i}" title="Remove">${TRASH}</button></div>`).join('');
  };
  openModal({
    title: `Stages — ${pipe.name}`, narrow: true,
    body: `<p class="muted" style="margin-top:0">Rename, reorder or add stages. Keep "Contract sent" and "Sold" if you want contracts to move deals automatically.</p><div id="stRows"></div><button class="btn ghost sm" id="stAdd">+ Add stage</button>`,
    foot: '<span></span><button class="btn primary" id="stSave">Save stages</button>',
    onMount: root => {
      draw(root);
      root.addEventListener('input', e => { if (e.target.dataset.i) rows[Number(e.target.dataset.i)].name = e.target.value; });
      root.addEventListener('click', e => {
        const up = e.target.closest('[data-up]'), rm = e.target.closest('[data-rm]');
        if (up) { const i = Number(up.dataset.up); if (i > 0) [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(root); }
        if (rm) { rows.splice(Number(rm.dataset.rm), 1); draw(root); }
      });
      $('#stAdd', root).onclick = () => { rows.push({ name: 'New stage' }); draw(root); };
      $('#stSave', root).onclick = guard(async () => { await api('PUT', `/api/crm/pipelines/${pipe.id}`, { stages: rows }); pipesCache = null; closeModal(); toast('Stages saved'); done(); });
    },
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export async function crmTasks() {
  $('#main').innerHTML = head('Tasks', 'Follow-ups for your team. Add tasks from any contact.', `<select class="in" id="tw"><option value="me">My tasks</option><option value="all">Everyone's tasks</option></select><label class="chk" style="font-size:13px"><input type="checkbox" id="tdone">Show done</label>`) + '<div class="card card-pad" id="tl"></div>';
  const render = async () => {
    const rows = await api('GET', `/api/crm/tasks?${$('#tw').value === 'me' ? 'mine=1&' : ''}open=${$('#tdone').checked ? 0 : 1}`);
    live('#tl').innerHTML = rows.length ? rows.map(t => `<div class="row" style="flex-wrap:nowrap;align-items:flex-start">${taskRow(t)}<a href="#/crm/contacts/${t.contact_id}" style="margin-left:auto;white-space:nowrap;font-size:13px;padding-top:6px">${esc([t.first_name, t.last_name].filter(Boolean).join(' ') || 'Contact')} ›</a></div>`).join('') : '<div class="empty">Nothing to do. 🎉</div>';
  };
  $('#tw').onchange = $('#tdone').onchange = guard(render);
  $('#tl').onchange = guard(async e => { if (e.target.dataset.task) { await api('PATCH', `/api/crm/tasks/${e.target.dataset.task}`, { done: e.target.checked }); render(); } });
  await render();
}

// ---------------------------------------------------------------------------
// Production & delivery board
// ---------------------------------------------------------------------------
export async function ordersBoard() {
  const view = hashQuery().get('view') || (me.role === 'delivery' ? 'schedule' : 'board');
  $('#main').innerHTML = head('Production & delivery', 'Signed contracts land here automatically. Production moves buildings through the shop; delivery schedules and delivers them.',
    `<div class="tabs" style="margin:0;border:0"><button class="${view === 'board' ? 'on' : ''}" data-v="board">Board</button><button class="${view === 'schedule' ? 'on' : ''}" data-v="schedule">Delivery schedule</button></div>`) + '<div id="board"><div class="empty">Loading…</div></div>';
  $$('[data-v]').forEach(b => (b.onclick = () => { location.hash = `#/orders?view=${b.dataset.v}`; }));
  const all = await users();
  let res;
  const groupOf = (pipe, id) => pipe.stages.find(s => s.id === id)?.group || 'production';
  const mayMove = (pipe, c, to) => {
    if (isAdmin() || can('crm.edit')) return true;
    const from = pipe.stages.find(s => s.id === c.stage);
    const tg = groupOf(pipe, to);
    const okTo = tg === 'delivery' ? res.me.delivery : res.me.production;
    const okFrom = (groupOf(pipe, c.stage) === 'delivery' ? res.me.delivery : res.me.production) || (from?.handoff && tg === 'delivery');
    return okTo && okFrom;
  };
  const render = async () => {
    res = await api('GET', '/api/crm/orders');
    if (!res.pipeline) { live('#board').innerHTML = '<div class="empty">No production pipeline.</div>'; return; }
    const pipe = res.pipeline;
    if (view === 'schedule') {
      const del = res.data.filter(o => groupOf(pipe, o.stage) === 'delivery' || pipe.stages.find(s => s.id === o.stage)?.handoff).sort((a, b) => String(a.delivery_date || '9999').localeCompare(String(b.delivery_date || '9999')));
      live('#board').innerHTML = del.length ? `<div class="card tbl-wrap"><table class="tbl"><tr><th>Date</th><th>Order</th><th>Customer</th><th>Address</th><th>Building</th><th>Driver</th><th>Stage</th></tr>${del.map(o => `<tr class="click" data-id="${o.id}">
        <td><b>${esc(o.delivery_date || 'Not scheduled')}</b><div class="muted" style="font-size:12px">${esc(o.delivery_window || '')}</div></td><td>${esc(o.order_number || '')}</td>
        <td>${esc(fullName(o))}<div class="muted" style="font-size:12px">${o.phone ? `<a href="tel:${esc(tel(o.phone))}">${esc(o.phone)}</a>` : ''}</div></td>
        <td>${o.address ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([o.address, o.city, o.state, o.zip].filter(Boolean).join(', '))}" target="_blank" rel="noopener">${esc([o.address, o.city].filter(Boolean).join(', '))}</a>` : '<span class="muted">—</span>'}</td>
        <td>${esc(o.title || '')}${o.serial_number ? `<div class="muted" style="font-size:12px">S/N ${esc(o.serial_number)}</div>` : ''}</td><td>${esc(o.driver_name || '')}</td>
        <td><span class="pill">${esc(pipe.stages.find(s => s.id === o.stage)?.name || o.stage)}</span></td></tr>`).join('')}</table></div>` : '<div class="empty">Nothing ready for delivery yet.</div>';
      $('#board').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('a')) orderModal(res.data.find(o => o.id === Number(tr.dataset.id)), pipe, all, render); };
      return;
    }
    kanban(live('#board'), pipe, res.data, {
      canDrop: (c, to) => mayMove(pipe, c, to),
      cardHTML: o => `<div class="row"><b>${esc(o.order_number || 'Order')}</b>${o.sale_type ? `<span class="pill ${esc(o.sale_type)}">${o.sale_type === 'rto' ? 'RTO' : 'Cash'}</span>` : ''}</div>
        <div>${esc(fullName(o))}</div><div class="muted">${esc(o.title || '')}</div>
        <div class="muted">${esc([o.city, o.state].filter(Boolean).join(', '))}${o.serial_number ? ' · S/N ' + esc(o.serial_number) : ''}</div>
        ${o.delivery_date ? `<div><span class="pill on">🚚 ${esc(o.delivery_date)}${o.delivery_window ? ' ' + esc(o.delivery_window) : ''}</span></div>` : ''}
        <div class="muted">In stage ${daysIn(o.stage_changed_at)}${o.driver_name ? ' · ' + esc(o.driver_name) : ''}</div>`,
      onMove: guard(async (o, stage) => {
        if (!mayMove(pipe, o, stage)) { toast("Your role can't move cards there", true); return render(); }
        await api('PATCH', `/api/crm/opportunities/${o.id}`, { stage }); toast('Moved'); render();
      }),
      onOpen: o => orderModal(o, pipe, all, render),
    });
  };
  onLive(type => { if (type === 'opportunity' || type === 'contract') render().catch(() => {}); });
  await render();
}
function orderModal(o, pipe, all, done) {
  const editDelivery = can('orders.delivery') || can('crm.edit'), editProd = can('orders.production') || can('crm.edit');
  const drivers = all.filter(u => ['delivery', 'admin'].includes(u.role));
  const addr = [o.address, o.city, o.state, o.zip].filter(Boolean).join(', ');
  openModal({
    title: `${o.order_number || 'Order'} — ${fullName(o)}`,
    body: `<div class="drawer"><div>
      <div class="row" style="margin-bottom:14px">
        ${o.quote_id ? '<button class="btn primary sm" id="oDraw">Drawings PDF</button>' : ''}
        ${o.quote_token ? `<a class="btn ghost sm" href="/?q=${esc(o.quote_token)}" target="_blank">Open 3D ↗</a>` : ''}
        ${o.contract_id && (can('contracts.download') || o.contract_status === 'completed') ? `<a class="btn ghost sm" href="/api/pos/contracts/${o.contract_id}/document.pdf" target="_blank">Signed contract PDF</a>` : ''}
        ${o.phone ? `<a class="btn ghost sm" href="tel:${esc(tel(o.phone))}">Call ${esc(o.first_name || '')}</a>` : ''}
        ${addr ? `<a class="btn ghost sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}">Directions ↗</a>` : ''}
        ${can('crm.view') ? `<a class="btn ghost sm" href="#/crm/contacts/${o.contact_id}" data-close>Open in CRM</a>` : ''}</div>
      ${o.quote_id ? `<div class="plan-prev"><img src="${planUrl(o.quote_id)}" alt="Floor plan"></div>` : ''}
      ${can('orders.message') && o.phone ? `<div class="card card-pad" style="margin-top:14px"><h3 style="margin:0 0 8px;font-size:14px">Text ${esc(o.first_name || 'customer')}</h3>
        <div class="row" style="margin-bottom:8px"><button class="btn ghost sm" data-quick="Hi {{contact.first_name}}, this is ${esc(me.name || '')} with ${esc(settings.company_name || '')}. Your building is scheduled for delivery ${esc(o.delivery_date || 'soon')}${o.delivery_window ? ' (' + esc(o.delivery_window) + ')' : ''}.">Delivery date</button>
          <button class="btn ghost sm" data-quick="Hi {{contact.first_name}}, we're on the way with your building! See you soon.">On the way</button>
          <button class="btn ghost sm" data-quick="Hi {{contact.first_name}}, your building has been delivered. Thank you for choosing ${esc(settings.company_name || 'us')}!">Delivered</button></div>
        <textarea class="in" id="oMsg" style="min-height:70px;width:100%;border:1px solid #d6dcda;border-radius:8px;padding:8px"></textarea><div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn primary sm" id="oSend">Send text</button></div></div>` : ''}
    </div><div>
      <div class="card card-pad"><dl class="kv">
        <dt>Customer</dt><dd>${esc(fullName(o))}</dd><dt>Phone</dt><dd>${o.phone ? `<a href="tel:${esc(tel(o.phone))}">${esc(o.phone)}</a>` : '—'}</dd>
        <dt>Address</dt><dd>${esc(addr) || '—'}</dd><dt>Building</dt><dd>${esc(o.title || '')}</dd>
        <dt>Sale</dt><dd>${o.sale_type === 'rto' ? 'Rent to own' : o.sale_type === 'cash' ? 'Cash' : '—'}${o.contract_number ? ' · ' + esc(o.contract_number) : ''}</dd>
        ${o.value != null ? `<dt>Value</dt><dd>${fmt(o.value)}</dd>` : ''}</dl></div>
      <div class="card card-pad" style="margin-top:14px"><form class="inline-edit" id="of">
        <label>Stage<select name="stage">${pipe.stages.map(s => `<option value="${esc(s.id)}" ${s.id === o.stage ? 'selected' : ''}>${esc((s.group === 'delivery' ? 'Delivery · ' : 'Production · ') + s.name)}</option>`).join('')}</select></label>
        <label>Serial number<input name="serial_number" value="${esc(o.serial_number || '')}" ${editProd ? '' : 'disabled'}></label>
        <label>Production notes<textarea name="production_notes" class="in" style="min-height:60px;border:1px solid #d6dcda;border-radius:8px;padding:7px" ${editProd ? '' : 'disabled'}>${esc(o.production_notes || '')}</textarea></label>
        <div class="row" style="flex-wrap:nowrap"><label style="flex:1">Delivery date<input type="date" name="delivery_date" value="${esc(o.delivery_date || '')}" ${editDelivery ? '' : 'disabled'}></label>
          <label style="flex:1">Time window<input name="delivery_window" value="${esc(o.delivery_window || '')}" placeholder="8–10 AM" ${editDelivery ? '' : 'disabled'}></label></div>
        <label>Driver<select name="delivery_driver" ${editDelivery ? '' : 'disabled'}><option value="">—</option>${drivers.map(u => `<option value="${u.id}" ${u.id === o.delivery_driver ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join('')}</select></label>
        <label>Delivery notes<textarea name="delivery_notes" class="in" style="min-height:60px;border:1px solid #d6dcda;border-radius:8px;padding:7px" ${editDelivery ? '' : 'disabled'} placeholder="Gate code, site prep, where to set it…">${esc(o.delivery_notes || '')}</textarea></label>
        <button class="btn primary" type="submit">Save</button></form></div></div></div>`,
    onMount: root => {
      $$('[data-close]', root).forEach(a => a.addEventListener('click', () => closeModal()));
      if ($('#oDraw', root)) $('#oDraw', root).onclick = () => downloadDrawings(o.quote_id, $('#oDraw', root));
      $$('[data-quick]', root).forEach(b => (b.onclick = () => { $('#oMsg', root).value = b.dataset.quick; $('#oMsg', root).focus(); }));
      if ($('#oSend', root)) $('#oSend', root).onclick = guard(async () => { const t = $('#oMsg', root).value.trim(); if (!t) return; await api('POST', `/api/crm/contacts/${o.contact_id}/messages`, { channel: 'sms', body: t }); $('#oMsg', root).value = ''; toast('Text sent'); });
      $('#of', root).onsubmit = guard(async e => {
        e.preventDefault();
        const f = e.target, d = {};
        if (f.stage.value !== o.stage) d.stage = f.stage.value;
        if (editProd) { d.serial_number = f.serial_number.value; d.production_notes = f.production_notes.value; }
        if (editDelivery) { d.delivery_date = f.delivery_date.value; d.delivery_window = f.delivery_window.value; d.delivery_driver = f.delivery_driver.value || null; d.delivery_notes = f.delivery_notes.value; }
        await api('PATCH', `/api/crm/opportunities/${o.id}`, d); toast('Saved'); closeModal(); done();
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Messaging & alerts (admin): guided setup for texting + email, connection checks, recent message log
// ---------------------------------------------------------------------------
const EMAIL_PRESETS = {
  gmail: { label: 'Gmail or Google Workspace', host: 'smtp.gmail.com', port: 587, user: 'Your Gmail / Workspace address', pass: 'Google App Password (16 letters)', help: 'Google requires an <b>App Password</b>: Google Account → Security → 2-Step Verification (turn on) → App passwords → create one named "Shed Builder" and paste the 16 letters here.' },
  m365: { label: 'Microsoft 365 / Outlook.com', host: 'smtp.office365.com', port: 587, user: 'Your Microsoft 365 email', pass: 'Password (or app password)', help: 'Your Microsoft 365 admin may need to turn on <b>Authenticated SMTP</b> for this mailbox (Microsoft 365 admin center → Users → Mail → Manage email apps). If you use 2-step sign-in, create an app password.' },
  yahoo: { label: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 587, user: 'Your Yahoo address', pass: 'Yahoo app password', help: 'Yahoo needs an <b>app password</b>: Account security → Generate app password.' },
  sendgrid: { label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, user: 'apikey', fixedUser: 'apikey', pass: 'Your SendGrid API key (SG.…)', help: 'Username is literally <code>apikey</code>; the password is an API key with Mail Send permission. The From address must be a verified sender in SendGrid.' },
  mailgun: { label: 'Mailgun', host: 'smtp.mailgun.org', port: 587, user: 'SMTP login (postmaster@mg.yourdomain.com)', pass: 'SMTP password', help: 'Find the SMTP login under Sending → Domain settings → SMTP credentials.' },
  ses: { label: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, user: 'SMTP username (from SES)', pass: 'SMTP password', help: 'Create SMTP credentials in the SES console and change the host to your region. Your From address or domain must be verified in SES.' },
  other: { label: 'Other email server (SMTP)', host: '', port: 587, user: 'Username', pass: 'Password', help: 'Ask your email or web host for the SMTP server name, port (usually 587) and login.' },
};
const presetFor = s => (s.email_provider === 'ghl' ? 'ghl' : !s.email_provider ? '' : Object.entries(EMAIL_PRESETS).find(([, p]) => p.host && p.host === s.smtp_host)?.[0] || (s.smtp_host ? 'other' : 'gmail'));
const splitFrom = f => { const m = String(f || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/); return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: String(f || '').trim() }; };
const checkList = r => `<div class="checks">${r.checks.map(c => `<div class="ck ${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'warn'}"><span>${c.ok === true ? '✓' : c.ok === false ? '✕' : '!'}</span><div><b>${esc(c.label)}</b>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</div></div>`).join('')}</div>`;

export async function messagingPage() {
  const [s, st, sn] = await Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/admin/messaging/status'), api('GET', '/api/crm/snippets')]);
  const H = st.hooks;
  const preset0 = presetFor(s);
  const from0 = splitFrom(s.email_from);
  const ago2 = x => (x ? ago(x.created_at || x.at) : '');
  const lastLine = (m, empty) => (m ? `${m.status === 'failed' ? '<span class="pill lost">Failed</span>' : m.status === 'test' ? '<span class="pill">Test mode</span>' : '<span class="pill won">' + esc(m.status === 'received' ? 'Received' : m.status) + '</span>'} ${ago2(m)}${m.to_addr ? ' to ' + esc(m.to_addr) : m.from_addr ? ' from ' + esc(m.from_addr) : ''}${m.error ? `<div class="err" style="margin-top:4px">${esc(m.error)}</div>` : ''}` : `<span class="muted">${empty}</span>`);
  const smsState = st.test_mode ? ['warn', 'Test mode — texts are logged, not sent'] : st.sms ? ['ok', `Ready — ${s.sms_provider === 'ghl' ? 'GoHighLevel' : 'Twilio'}${s.sms_provider === 'twilio' && s.twilio_from ? ', from ' + s.twilio_from : ''}`] : ['bad', 'Not set up'];
  const emailState = st.test_mode ? ['warn', 'Test mode — emails are logged, not sent'] : st.email ? ['ok', `Ready — from ${st.from || 'GoHighLevel'}`] : ['bad', 'Not set up'];
  const card = (id, title, state, lastOut, lastIn, inEmpty) => `<div class="card card-pad ms-card" id="${id}"><div class="ms-top"><h2>${title}</h2><span class="ms-state ${state[0]}">${state[0] === 'ok' ? '✓' : state[0] === 'bad' ? '✕' : '!'} ${esc(state[1])}</span></div>
    <dl class="kv" style="margin-top:10px"><dt>Last sent</dt><dd>${lastLine(lastOut, 'Nothing sent yet')}</dd><dt>Last reply</dt><dd>${lastLine(lastIn, inEmpty)}</dd></dl>
    <div class="row" style="margin-top:12px"><button type="button" class="btn ghost sm" data-verify="${id === 'smsCard' ? 'sms' : 'email'}">Check connection</button>
      <input class="in" data-testto="${id}" placeholder="${id === 'smsCard' ? 'Your mobile number' : 'Your email address'}" style="max-width:220px"><button type="button" class="btn ghost sm" data-test="${id === 'smsCard' ? 'sms' : 'email'}">Send a test</button></div>
    <div data-result="${id === 'smsCard' ? 'sms' : 'email'}"></div></div>`;
  const F = (k, label, o = {}) => `<label class="fld ${o.full ? 'full' : ''}" ${o.show ? `data-show="${o.show}"` : ''}><span>${label}</span><input name="${k}" type="${o.type || 'text'}" value="${esc(o.value ?? s[k] ?? '')}" placeholder="${esc(o.ph || '')}" autocomplete="off" ${o.attrs || ''}>${o.help ? `<small>${o.help}</small>` : ''}</label>`;
  const C = (k, label, help = '') => `<label class="fld full"><label class="chk"><input type="checkbox" name="${k}" ${s[k] === true ? 'checked' : ''}>${label}</label>${help ? `<small>${help}</small>` : ''}</label>`;
  const copyRow = (label, url, help = '') => `<div class="fld full"><span>${label}</span><div class="row" style="flex-wrap:nowrap"><input class="in mono" readonly value="${esc(url)}"><button type="button" class="btn ghost sm" data-copy="${esc(url)}">Copy</button></div>${help ? `<small>${help}</small>` : ''}</div>`;
  const provChoice = (name, val, label, sub, cur) => `<label><input type="radio" name="${name}" value="${val}" ${cur === val ? 'checked' : ''}><b>${label}</b><small>${sub}</small></label>`;
  $('#main').innerHTML = head('Messaging & alerts', 'Set up texting and email once. Then everyone can text and email customers from the CRM, and contracts go out by text and email.', '<button class="btn primary" id="msave">Save</button>') + `
  ${st.inbound_last_error ? `<div class="callout warn" style="margin-bottom:16px;display:flex;gap:12px;align-items:flex-start"><div style="flex:1"><b>A customer reply didn't come through</b> (${ago2(st.inbound_last_error)}). ${esc(st.inbound_last_error.reason)}</div><button type="button" class="btn ghost sm" id="clrIn">Dismiss</button></div>` : ''}
  ${!H.https ? `<div class="callout warn" style="margin-bottom:16px">Replies and delivery updates need this app on a public <b>https://</b> address. Set <a href="#/settings">Settings → Public URL</a> once it's deployed.</div>` : ''}
  <div class="grid g2" style="margin-bottom:16px">${card('smsCard', 'Texting', smsState, st.last_sms, st.last_sms_in, s.sms_provider === 'twilio' ? 'No replies yet — text your Twilio number from your phone to test' : 'No replies yet')}${card('emailCard', 'Email', emailState, st.last_email, st.last_email_in, 'Optional: replies go to your inbox')}</div>
  <form id="mf" class="grid" style="gap:16px" autocomplete="off">
    <div class="card card-pad"><h2>1 · Texting</h2><p class="muted" style="margin:2px 0 12px">Pick how texts go out. Already texting customers from GoHighLevel? Use it — your registered number and history stay in GHL.</p>
      <div class="choice">${provChoice('sms_provider', 'twilio', 'Twilio', 'Your own Twilio number. Replies show up here.', s.sms_provider || '')}${provChoice('sms_provider', 'ghl', 'GoHighLevel', 'Your GHL (LC Phone) number', s.sms_provider || '')}${provChoice('sms_provider', '', 'Off', 'No texts', s.sms_provider || '')}</div>
      <div class="form steps" data-show="sms_provider=twilio" style="margin-top:14px">
        <div class="step full"><b>Step 1</b> In <a href="https://console.twilio.com" target="_blank" rel="noopener">console.twilio.com</a>, copy the <b>Account SID</b> and <b>Auth Token</b> from the Account Info box on the home page.</div>
        ${F('twilio_sid', 'Account SID', { ph: 'AC… (34 characters)' })}${F('twilio_token', 'Auth Token', { type: 'password', ph: s.twilio_token_set ? 'Saved — leave as is to keep' : '32 characters', value: s.twilio_token_set ? s.twilio_token : '' })}
        <div class="step full"><b>Step 2</b> Your Twilio phone number (Phone Numbers → Manage → Active numbers). For business texting in the US it must be <b>A2P 10DLC registered</b> (or a verified toll-free number), or carriers block your texts.</div>
        ${F('twilio_from', 'Twilio phone number', { ph: '(615) 555-0123' })}${F('twilio_messaging_service_sid', 'Messaging Service SID (optional)', { ph: 'MG… — only if you use one', help: 'Leave blank unless Twilio set you up with a Messaging Service.' })}
        <div class="step full"><b>Step 3</b> Click <b>Save</b>, then <b>Check connection</b> at the top. Then connect replies so customers' texts come back into Conversations:</div>
        <div class="full row"><button type="button" class="btn ghost" id="twConnect">Connect replies for me</button><span class="muted">or paste this into your number's <i>A message comes in</i> webhook (HTTP POST):</span></div>
        ${copyRow('Reply webhook', H.twilio)}
      </div>
      <div class="form steps" data-show="sms_provider=ghl" style="margin-top:14px">
        <div class="step full"><b>Step 1</b> In <a href="#/integrations">Integrations → GoHighLevel</a>, enter the Private Integration token and Location ID. Give the token the <b>contacts.write</b>, <b>conversations/message.write</b> and <b>locations.readonly</b> scopes.</div>
        <div class="step full"><b>Step 2</b> Click <b>Save</b>, then <b>Check connection</b>. Texts go out from your GHL number and also appear in GHL.</div>
        <div class="step full"><b>Step 3 (to see replies here)</b> In GHL, create a workflow: trigger <b>Customer Replied</b> (channel SMS) → action <b>Webhook</b>, method POST, URL below.</div>
        ${copyRow('GHL webhook', H.ghl)}
      </div>
    </div>
    <div class="card card-pad"><h2>2 · Email</h2><p class="muted" style="margin:2px 0 12px">Pick who hosts your company email. We fill in the technical settings.</p>
      <div class="form">
        <label class="fld full"><span>Email provider</span><select id="ePreset"><option value="">Off — no email</option>${Object.entries(EMAIL_PRESETS).map(([k, p]) => `<option value="${k}" ${preset0 === k ? 'selected' : ''}>${p.label}</option>`).join('')}<option value="ghl" ${preset0 === 'ghl' ? 'selected' : ''}>GoHighLevel (LC Email / your connected mailbox)</option></select></label>
        <div class="callout full" id="eHelp" hidden></div>
        <span data-show="ePreset=smtp" style="display:contents">
          ${F('smtp_user', 'Email login', { ph: 'sales@yourcompany.com' })}${F('smtp_pass', 'Password', { type: 'password', ph: s.smtp_pass_set ? 'Saved — leave as is to keep' : '', value: s.smtp_pass_set ? s.smtp_pass : '' })}
        </span>
        <span data-show="ePreset=any" style="display:contents">
          <label class="fld"><span>From name</span><input id="fromName" value="${esc(from0.name || s.company_name || '')}" placeholder="Trimline Barns"></label>
          <label class="fld"><span>From email</span><input id="fromEmail" value="${esc(from0.email || '')}" placeholder="Same as the email login"><small>Leave blank to send from the login address.</small></label>
          ${F('email_reply_to', 'Replies go to (optional)', { ph: "Blank = the rep who sent it", full: true, help: 'When a rep emails a customer, replies go back to that rep\'s own email unless you set one address here.' })}
        </span>
        <details class="full" data-show="ePreset=smtp"><summary class="muted" style="cursor:pointer">Advanced server settings</summary><div class="form" style="margin-top:10px">
          ${F('smtp_host', 'SMTP server', { ph: 'smtp.yourprovider.com' })}${F('smtp_port', 'Port', { type: 'number', ph: '587' })}
          <label class="fld"><span>&nbsp;</span><label class="chk"><input type="checkbox" name="smtp_secure" ${s.smtp_secure === true ? 'checked' : ''}>Use SSL (port 465)</label></label></div></details>
        <details class="full"><summary class="muted" style="cursor:pointer">Optional: see customers' email replies in Conversations</summary><div style="margin-top:8px">${copyRow('Inbound email webhook', H.email, 'Point Mailgun Routes, SendGrid Inbound Parse or Postmark inbound at this address. Without it, replies simply go to your inbox.')}</div></details>
      </div></div>
    <div class="card card-pad"><h2>3 · Alerts to your team</h2><div class="form" style="margin-top:12px">
      ${F('notify_phones', 'Text alerts to', { ph: '(615) 555-0100, (615) 555-0111', help: 'Comma separated. Each team member can also turn on their own alerts in Account.' })}
      ${F('notify_emails', 'Email alerts to', { ph: 'owner@yourcompany.com, office@yourcompany.com' })}
      ${C('notify_on_signed', 'When a contract is fully signed')}${C('notify_each_signer', 'Also each time one signer finishes (e.g. customer signed, waiting on co-buyer)')}
      ${C('notify_attach_pdf', 'Attach the signed PDF to the email alert')}${C('notify_on_new_lead', 'When a new 3D lead comes in')}${C('notify_on_inbound', 'When a customer texts or emails back')}
    </div></div>
    <div class="card card-pad"><h2>4 · Instant reply to new 3D leads <span class="muted" style="font-weight:600;font-size:13px">optional</span></h2><p class="muted" style="margin:2px 0 0">Texts only go to customers who ticked the text-consent box. Merge tags: {{contact.first_name}}, {{quote.number}}, {{quote.style}}, {{quote.size}}, {{quote.view_3d}}, {{company.name}}, {{company.phone}}</p><div class="form" style="margin-top:12px">
      <label class="fld full"><span>Text</span><textarea name="auto_reply_sms" placeholder="Hi {{contact.first_name}}, thanks for designing your {{quote.style}} with {{company.name}}! A team member will reach out shortly.">${esc(s.auto_reply_sms || '')}</textarea></label>
      ${F('auto_reply_email_subject', 'Email subject', { full: true, ph: 'Your {{quote.style}} design from {{company.name}}' })}
      <label class="fld full"><span>Email</span><textarea name="auto_reply_email_body" placeholder="Leave blank for no auto-reply email">${esc(s.auto_reply_email_body || '')}</textarea></label>
    </div></div>
    <div class="card card-pad"><h2>Saved replies</h2><p class="muted" style="margin:2px 0 10px">Quick messages your team can drop into any conversation.</p>
      <div id="snips">${sn.map(x => `<div class="mini-item" style="margin-bottom:8px"><div class="row"><b>${esc(x.name)} <span class="pill">${x.channel === 'email' ? 'Email' : 'Text'}</span></b><span><button type="button" class="btn link sm" data-sedit="${x.id}">Edit</button><button type="button" class="btn link sm" data-sdel="${x.id}">Delete</button></span></div><div class="muted" style="white-space:pre-wrap">${esc(x.body)}</div></div>`).join('')}</div>
      <button type="button" class="btn ghost sm" id="sadd">+ Add saved reply</button></div>
    <div class="card card-pad"><h2>Test mode</h2>${C('messaging_test_mode', 'Log texts and emails in the CRM but don\'t actually send them', 'Use this while training staff. Turn it off to go live.')}</div>
  </form>
  <div class="card" style="margin-top:16px"><div class="card-pad" style="padding-bottom:6px"><h2>Recent messages</h2><p class="muted" style="margin:2px 0 0">The last 25 texts and emails, sent and received, with the reason when something failed.</p></div>
    <div class="tbl-wrap">${st.recent.length ? `<table class="tbl"><tr><th>When</th><th>Type</th><th>To / from</th><th>Message</th><th>Status</th></tr>${st.recent.map(m => `<tr><td class="muted" style="white-space:nowrap">${fmtDate(m.created_at)}</td><td>${m.direction === 'in' ? '↘ ' : '↗ '}${m.channel === 'email' ? 'Email' : 'Text'}</td>
      <td>${esc([m.first_name, m.last_name].filter(Boolean).join(' '))}<div class="muted" style="font-size:12px">${esc(m.direction === 'in' ? m.from_addr : m.to_addr)}</div></td><td><span class="trunc" style="max-width:340px">${esc(m.subject ? m.subject + ' — ' : '')}${esc(m.body)}</span></td>
      <td>${m.status === 'failed' ? `<span class="pill lost">Failed</span><div class="err" style="font-size:12px;max-width:320px">${esc(m.error || '')}</div>` : m.status === 'test' ? '<span class="pill">Test mode</span>' : `<span class="pill won">${esc(m.status)}</span>`}</td></tr>`).join('')}</table>` : '<div class="empty">No messages yet.</div>'}</div></div>`;

  const form = $('#mf');
  const preset = () => $('#ePreset').value;
  const syncShow = () => {
    $$('[data-show]', $('#main')).forEach(el => {
      const [k, v] = el.dataset.show.split('=');
      if (k === 'ePreset') { const p = preset(); el.hidden = v === 'smtp' ? !(p && p !== 'ghl') : v === 'any' ? !p : p !== v; return; }
      el.hidden = (form.querySelector(`[name="${k}"]:checked`)?.value ?? form.elements[k]?.value ?? '') !== v;
    });
    const p = EMAIL_PRESETS[preset()];
    $('#eHelp').hidden = !p && preset() !== 'ghl';
    $('#eHelp').innerHTML = preset() === 'ghl' ? 'Emails go out through your GoHighLevel sub-account using the token in <a href="#/integrations">Integrations → GoHighLevel</a>. The From address must be allowed in GHL.' : p ? p.help : '';
    if (p) { form.smtp_user.placeholder = p.user; form.smtp_pass.placeholder = s.smtp_pass_set ? 'Saved — leave as is to keep' : p.pass; }
  };
  $('#ePreset').onchange = () => {
    const p = EMAIL_PRESETS[preset()];
    if (p && p.host) { form.smtp_host.value = p.host; form.smtp_port.value = p.port; form.smtp_secure.checked = false; }
    if (p?.fixedUser) form.smtp_user.value = p.fixedUser;
    syncShow();
  };
  form.addEventListener('change', syncShow); syncShow();
  $('#main').addEventListener('click', e => { const c = e.target.closest('[data-copy]'); if (c) { navigator.clipboard?.writeText(c.dataset.copy).then(() => toast('Copied'), () => toast('Select the address and copy it', true)); } });
  const collect = (strict = true) => {
    const d = {};
    for (const el of form.elements) { if (!el.name || el.type === 'radio' && !el.checked) continue; d[el.name] = el.type === 'checkbox' ? el.checked : el.value; }
    d.sms_provider = form.querySelector('[name=sms_provider]:checked')?.value || '';
    const p = preset(); d.email_provider = p === 'ghl' ? 'ghl' : p ? 'smtp' : '';
    const name = $('#fromName').value.trim().replace(/"/g, ''), email = $('#fromEmail').value.trim() || (/@/.test(d.smtp_user || '') ? d.smtp_user.trim() : '');
    d.email_from = email ? (name ? `"${name}" <${email}>` : email) : '';
    if (strict && d.email_provider === 'smtp' && !d.smtp_host) throw new Error('Pick your email provider, or open Advanced server settings and enter the SMTP server.');
    return d;
  };
  const save = async (strict = false) => { await api('PUT', '/api/admin/settings', collect(strict)); msgStatus = null; };
  $('#msave').onclick = guard(async () => { await save(true); toast('Saved'); messagingPage(); });
  $$('[data-verify]').forEach(b => (b.onclick = guard(async () => {
    const ch = b.dataset.verify, out = $(`[data-result="${ch}"]`);
    b.disabled = true; out.innerHTML = '<div class="busy" style="margin-top:10px"><span class="spin"></span>Checking…</div>';
    try { await save(); const r = await api('POST', '/api/admin/messaging/verify', { channel: ch }); out.innerHTML = checkList(r) + (r.ok ? '' : '<p class="muted" style="font-size:12.5px;margin:6px 0 0">Fix the item marked ✕, click Save, then check again.</p>'); }
    catch (e) { out.innerHTML = `<div class="err" style="margin-top:10px">${esc(e.message)}</div>`; }
    finally { b.disabled = false; }
  })));
  $$('[data-test]').forEach(b => (b.onclick = guard(async () => {
    const ch = b.dataset.test, to = $(`[data-testto="${ch === 'sms' ? 'smsCard' : 'emailCard'}"]`).value.trim(), out = $(`[data-result="${ch}"]`);
    if (!to) { toast(ch === 'sms' ? 'Enter your mobile number' : 'Enter your email address', true); return; }
    b.disabled = true; out.innerHTML = '<div class="busy" style="margin-top:10px"><span class="spin"></span>Sending…</div>';
    try {
      await save(); const r = await api('POST', '/api/admin/messaging/test', { channel: ch, to });
      out.innerHTML = r.status === 'test' ? checkList({ checks: [{ ok: null, label: 'Logged in test mode', detail: 'Test mode is on, so nothing was actually sent. Turn it off at the bottom of this page to go live.' }] })
        : checkList({ checks: [{ ok: true, label: ch === 'sms' ? 'Text sent' : 'Email sent', detail: ch === 'sms' ? `Check ${to}. Then reply to it — the reply should show up under Last reply within a few seconds.` : `Check ${to} (and the spam folder).` }] });
    } catch (e) { out.innerHTML = checkList({ checks: [{ ok: false, label: ch === 'sms' ? 'Text not sent' : 'Email not sent', detail: e.message }] }); }
    finally { b.disabled = false; }
  })));
  $('#twConnect').onclick = guard(async () => {
    await save(); const r = await api('POST', '/api/admin/messaging/twilio-connect');
    toast(`Replies to ${r.number} now come into Conversations`); $('[data-result="sms"]').innerHTML = checkList({ checks: [{ ok: true, label: 'Customer replies connected', detail: `${r.number} → ${r.sms_url}` }] });
  });
  if ($('#clrIn')) $('#clrIn').onclick = guard(async () => { await api('POST', '/api/admin/messaging/clear-inbound-error'); messagingPage(); });
  const snipModal = x => openModal({
    title: x ? 'Edit saved reply' : 'New saved reply', narrow: true,
    body: `<form class="form" id="sf"><label class="fld"><span>Name</span><input name="name" value="${esc(x?.name || '')}"></label><label class="fld"><span>Type</span><select name="channel"><option value="sms">Text</option><option value="email" ${x?.channel === 'email' ? 'selected' : ''}>Email</option></select></label>
      <label class="fld full"><span>Email subject</span><input name="subject" value="${esc(x?.subject || '')}"></label><label class="fld full"><span>Message</span><textarea name="body" style="min-height:140px">${esc(x?.body || '')}</textarea><small>Merge tags: {{contact.first_name}}, {{company.name}}, {{company.phone}}, {{user.name}}</small></label></form>`,
    foot: '<span></span><button class="btn primary" id="ssave">Save</button>',
    onMount: root => { $('#ssave', root).onclick = guard(async () => { const d = Object.fromEntries(new FormData($('#sf', root))); await api(x ? 'PUT' : 'POST', `/api/crm/snippets${x ? '/' + x.id : ''}`, d); snippetsCache = null; closeModal(); messagingPage(); }); },
  });
  $('#sadd').onclick = () => snipModal(null);
  $('#snips').onclick = guard(async e => {
    const ed = e.target.closest('[data-sedit]'), del = e.target.closest('[data-sdel]');
    if (ed) snipModal(sn.find(x => x.id === Number(ed.dataset.sedit)));
    if (del && confirmBox('Delete this saved reply?')) { await api('DELETE', `/api/crm/snippets/${del.dataset.sdel}`); snippetsCache = null; messagingPage(); }
  });
}
export const _internal = { threadHTML, fullName };
