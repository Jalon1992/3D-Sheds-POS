// Outbound texts & emails. Providers: Twilio (SMS/MMS), any SMTP server (email), or your
// GoHighLevel sub-account (sends through GHL's LC Phone / email, so it uses your A2P-registered number).
// Every message is logged in the `messages` table so it shows in the CRM conversation.
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { get, run, getSettings } from './db.js';

const testMode = () => process.env.MESSAGING_TEST_MODE === '1' || getSettings().messaging_test_mode === true;
// overridable only so the test suite can point at stand-in servers
const TWILIO = () => (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
const GHL_BASE = () => (process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/$/, '');
// Email services that send over HTTPS (port 443). Use one of these on hosts that block SMTP ports (Railway Free/Hobby, Render free, DigitalOcean…).
export const EMAIL_APIS = {
  resend: { label: 'Resend', base: 'https://api.resend.com' },
  postmark: { label: 'Postmark', base: 'https://api.postmarkapp.com' },
  sendgrid_api: { label: 'SendGrid', base: 'https://api.sendgrid.com' },
};
const emailApiBase = p => (process.env.EMAIL_API_BASE || EMAIL_APIS[p].base).replace(/\/$/, '');

/** Provider error → what it means and what to do, in plain words. */
const TWILIO_CODES = {
  20003: 'Twilio rejected the Account SID or Auth Token. Copy both again from console.twilio.com (Account info).',
  20404: 'Twilio could not find that account or number. Check the Account SID and the phone number.',
  20429: 'Twilio is rate-limiting this account. Wait a minute and try again.',
  21211: "That isn't a valid mobile number.",
  21408: "Your Twilio account isn't allowed to text that country. Turn it on under Messaging → Settings → Geo permissions.",
  21606: "The 'From' number isn't a text-capable number in this Twilio account. Use a number you bought in Twilio (Phone Numbers → Active numbers).",
  21608: 'This is a Twilio trial account, which can only text numbers you have verified in Twilio. Verify the number or upgrade the account.',
  21610: 'This person replied STOP to your number, so carriers block texts to them until they reply START.',
  21612: "Twilio can't reach that number by text from your number.",
  21614: "That number can't receive texts (it may be a landline).",
  21659: "The 'From' number isn't a Twilio number in this account.",
  30003: "The phone was unreachable (off or out of coverage).",
  30005: "That number doesn't exist anymore.",
  30006: "That number can't receive texts (landline or unreachable carrier).",
  30007: 'The carrier filtered the text as possible spam. Make sure your A2P registration is approved and avoid link shorteners.',
  30032: "Your toll-free number hasn't been verified yet. Finish toll-free verification in Twilio.",
  30034: "Your number isn't registered for business texting (A2P 10DLC) yet, so carriers block it. Finish A2P registration in Twilio → Messaging → Regulatory compliance.",
};
export function friendlyTwilio(code, fallback) { return TWILIO_CODES[Number(code)] ? `${TWILIO_CODES[Number(code)]} (Twilio ${code})` : fallback || `Twilio error ${code}`; }
export function friendlySmtp(e) {
  const m = String(e?.message || e || ''); const code = e?.code || '';
  if (code === 'EAUTH' || /535|534|auth/i.test(m)) return /gmail|google/i.test(m) || /5\.7\.8|5\.7\.9/.test(m)
    ? 'Gmail rejected the login. Use a Google App Password (Google Account → Security → 2-Step Verification → App passwords), not your normal password.'
    : 'The email server rejected the username or password. Check both; many providers (Gmail, Outlook, Yahoo) need an app password.';
  if (code === 'ESOCKET' && /wrong version number|ssl3_get_record|SSL routines/i.test(m)) return 'Security setting mismatch: use port 587 with "Use SSL" off, or port 465 with it on.';
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|getaddrinfo|ENOTFOUND/i.test(m)) return "Couldn't reach the email server. Check the host name and port (usually 587, or 465 with SSL). If this app runs on Railway's Free or Hobby plan (or another host that blocks email ports), SMTP can't connect at all: pick Resend, Postmark or SendGrid (sent over the web) as the email provider instead.";
  if (/certificate|self.signed/i.test(m)) return "The email server's security certificate isn't trusted. Check the host name matches your provider's SMTP host.";
  if (/sender|from address|not owned|553|550 5\.7\.1|5\.7\.60/i.test(m)) return 'The email server refused the From address. Send from an address your account owns (or verify it with your provider).';
  return 'Email server said: ' + m.slice(0, 200);
}

/** US-friendly phone normaliser → E.164 (+15551234567). Returns null when it can't be a phone number. */
export function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+') && d.length >= 8 && d.length <= 15) return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}
export const prettyPhone = e => { const d = String(e || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : e; };

/** {{contact.first_name}} style merge tags. Unknown or empty tags become '', and the words that only made sense
 * with them go too ("…or call {{company.phone}}." with no phone → "…."; "Hi {{first_name}}," → "Hi,"). */
export function fill(tpl, ctx) {
  const E = '\u0000';
  return String(tpl ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), ctx);
    return v == null || v === '' ? E : String(v);
  })
    .replace(/[ \t]+(?:or|and)[ \t]+(?:call|text|phone|email|reach)(?:[ \t]+(?:us|me))?(?:[ \t]+(?:at|on))?[ \t]*\u0000/gi, '')
    .replace(/[ \t]+(?:call|text|phone|email|reach)(?:[ \t]+(?:us|me))?(?:[ \t]+(?:at|on))?[ \t]*\u0000(?=[ \t]*[.,!?;:)]|[ \t]*$)/gim, '')
    .replace(/[ \t]*\u0000/g, '').replace(/\u0000/g, '');
}

export function smsReady(s = getSettings()) {
  if (testMode()) return true;
  if (s.sms_provider === 'twilio') return !!(s.twilio_sid && s.twilio_token && (s.twilio_from || s.twilio_messaging_service_sid));
  if (s.sms_provider === 'ghl') return !!(s.ghl_token && s.ghl_location_id);
  return false;
}
/** From address: the one entered, else "Company <smtp username>" when the username is an email. */
export function fromAddress(s = getSettings()) {
  if (s.email_from) return s.email_from;
  if (s.email_provider === 'smtp' && /^\S+@\S+\.\S+$/.test(s.smtp_user || '')) return s.company_name ? `"${String(s.company_name).replace(/"/g, '')}" <${s.smtp_user}>` : s.smtp_user;
  return '';
}
export function emailReady(s = getSettings()) {
  if (testMode()) return true;
  if (s.email_provider === 'smtp') return !!(s.smtp_host && fromAddress(s));
  if (s.email_provider === 'ghl') return !!(s.ghl_token && s.ghl_location_id);
  if (EMAIL_APIS[s.email_provider]) return !!(s.email_api_key && fromAddress(s));
  return false;
}
export function messagingStatus() {
  const s = getSettings();
  return { sms: smsReady(s), email: emailReady(s), test_mode: testMode(), sms_provider: s.sms_provider || '', email_provider: s.email_provider || '' };
}

function logMessage(m) {
  const r = run(`INSERT INTO messages (contact_id, channel, direction, to_addr, from_addr, subject, body, status, error, provider, provider_id, user_id, contract_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, m.contact_id ?? null, m.channel, m.direction || 'out', m.to ?? null, m.from ?? null, m.subject ?? null,
    String(m.body ?? '').slice(0, 20000), m.status, m.error ?? null, m.provider ?? null, m.provider_id ?? null, m.user_id ?? null, m.contract_id ?? null);
  return Number(r.lastInsertRowid);
}

async function http(url, opt, timeoutMs = 15000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { ...opt, signal: ctrl.signal }); const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = null; } return { ok: r.ok, status: r.status, text, json, headers: r.headers }; }
  finally { clearTimeout(t); }
}

// ---- GoHighLevel transport -------------------------------------------------
async function ghlContactId(s, contact) {
  const r = await http(GHL_BASE() + '/contacts/upsert', {
    method: 'POST', headers: { Authorization: `Bearer ${s.ghl_token}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ locationId: s.ghl_location_id, firstName: contact.first_name || undefined, lastName: contact.last_name || undefined, email: contact.email || undefined, phone: contact.phone_e164 || contact.phone || undefined, source: s.ghl_source || '3D Shed Builder' }),
  });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'GoHighLevel rejected the token. Check the Private Integration token and that it has the contacts.write scope.' : `GoHighLevel contact lookup failed (${r.status}): ${r.text.slice(0, 200)}`);
  return r.json?.contact?.id || r.json?.id;
}
async function ghlSend(s, payload) {
  const r = await http(GHL_BASE() + '/conversations/messages', {
    method: 'POST', headers: { Authorization: `Bearer ${s.ghl_token}`, Version: '2021-04-15', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'GoHighLevel refused to send. Give the Private Integration token the conversations/message.write scope.' : `GoHighLevel couldn't send (${r.status}): ${(r.json?.message || r.text).toString().slice(0, 300)}`);
  return r.json?.messageId || r.json?.id || r.json?.conversationId || null;
}

// ---- SMS --------------------------------------------------------------------
/**
 * @param {object} o { to, body, mediaUrls?, contact_id?, contact?, user_id?, contract_id?, baseUrl? }
 * @returns {Promise<{ok:boolean, status:string, error?:string, id:number}>}
 */
export async function sendSMS(o) {
  const s = getSettings();
  const to = toE164(o.to);
  const base = { channel: 'sms', to: to || o.to, body: o.body, contact_id: o.contact_id, user_id: o.user_id, contract_id: o.contract_id };
  if (!to) return { ok: false, status: 'failed', error: 'Not a valid mobile number', id: logMessage({ ...base, status: 'failed', error: 'Not a valid mobile number' }) };
  if (testMode()) return { ok: true, status: 'test', id: logMessage({ ...base, status: 'test', provider: 'test', from: s.twilio_from || 'test' }) };
  if (!smsReady(s)) {
    const error = 'Texting is not set up yet. Admin → Settings → Messaging.';
    return { ok: false, status: 'failed', error, id: logMessage({ ...base, status: 'failed', error }) };
  }
  try {
    let provider_id = null, from = null;
    if (s.sms_provider === 'twilio') {
      const form = new URLSearchParams({ To: to, Body: String(o.body || '') });
      if (s.twilio_messaging_service_sid) form.set('MessagingServiceSid', s.twilio_messaging_service_sid); else form.set('From', s.twilio_from);
      for (const m of o.mediaUrls || []) form.append('MediaUrl', m);
      const pub = (s.public_url || o.baseUrl || '').replace(/\/$/, '');
      if (/^https:\/\//.test(pub)) form.set('StatusCallback', pub + '/api/hooks/twilio/status');
      const r = await http(`${TWILIO()}/2010-04-01/Accounts/${encodeURIComponent(s.twilio_sid)}/Messages.json`, {
        method: 'POST', body: form,
        headers: { Authorization: 'Basic ' + Buffer.from(`${s.twilio_sid}:${s.twilio_token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!r.ok) throw new Error(r.json?.code ? friendlyTwilio(r.json.code, `Twilio: ${r.json.message}`) : r.status === 401 ? friendlyTwilio(20003) : `Twilio ${r.status}: ${r.text.slice(0, 200)}`);
      provider_id = r.json?.sid; from = s.twilio_from || s.twilio_messaging_service_sid;
    } else if (s.sms_provider === 'ghl') {
      const contactId = await ghlContactId(s, o.contact || { phone: to });
      provider_id = await ghlSend(s, { type: 'SMS', contactId, message: String(o.body || ''), ...(o.mediaUrls?.length ? { attachments: o.mediaUrls } : {}) });
      from = 'GoHighLevel';
    }
    return { ok: true, status: 'sent', id: logMessage({ ...base, status: 'sent', provider: s.sms_provider, provider_id, from }) };
  } catch (e) {
    return { ok: false, status: 'failed', error: e.message, id: logMessage({ ...base, status: 'failed', provider: s.sms_provider, error: e.message }) };
  }
}

// ---- Email ------------------------------------------------------------------
let transport = null, transportKey = '';
function smtp(s) {
  const key = [s.smtp_host, s.smtp_port, s.smtp_user, s.smtp_pass, s.smtp_secure].join('|');
  if (!transport || key !== transportKey) {
    const port = Number(s.smtp_port) || 587;
    transport = nodemailer.createTransport({
      host: s.smtp_host, port, secure: s.smtp_secure === true || port === 465,
      auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    });
    transportKey = key;
  }
  return transport;
}
const htmlEscape = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** Plain text → simple branded HTML email (links become clickable). */
export function textToHtml(text, s = getSettings()) {
  const body = htmlEscape(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:' + (s.brand_color || '#2f6b4f') + '">$1</a>').replace(/\n/g, '<br>');
  return `<!doctype html><html><body style="margin:0;background:#f5f7f6;font-family:Arial,Helvetica,sans-serif;color:#17201d">
<div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #e4e8e6;font-size:15px;line-height:1.55">${body}</div>
<p style="font-size:12px;color:#7d8885;text-align:center;margin-top:14px">${htmlEscape(s.company_name || '')}${s.phone ? ' · ' + htmlEscape(s.phone) : ''}</p></div></body></html>`;
}

// ---- Email over HTTPS (Resend / Postmark / SendGrid) ------------------------
const splitAddr = a => { const m = String(a || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/); return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: String(a || '').trim() }; };
const b64 = c => (Buffer.isBuffer(c) ? c : Buffer.from(c ?? '')).toString('base64');
function apiError(p, r) {
  const msg = String(r.json?.message || r.json?.Message || r.json?.errors?.[0]?.message || r.text || '').slice(0, 300);
  const name = EMAIL_APIS[p].label;
  if (r.status === 401 || r.status === 403 || r.json?.ErrorCode === 10) return `${name} rejected the API key. Copy it again from your ${name} account (it needs permission to send email).${msg ? ' ' + name + ' said: ' + msg : ''}`;
  if (/domain|sender|from|signature|verif/i.test(msg)) return `${name} won't send from that From address yet: ${msg} Verify your domain (or the sender address) in ${name}, or send from an address on a verified domain.`;
  return `${name} couldn't send (${r.status}): ${msg}`;
}
async function apiSend(s, m) {
  const p = s.email_provider, key = s.email_api_key, base = emailApiBase(p), from = splitAddr(m.from), reply = m.replyTo ? splitAddr(m.replyTo) : null;
  let r;
  if (p === 'resend') {
    r = await http(base + '/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text || undefined, html: m.html, reply_to: reply ? reply.email : undefined, headers: m.headers,
        attachments: m.attachments.length ? m.attachments.map(a => ({ filename: a.filename, content: b64(a.content) })) : undefined }) }, 30000);
    if (!r.ok) throw new Error(apiError(p, r));
    return r.json?.id || null;
  }
  if (p === 'postmark') {
    r = await http(base + '/email', { method: 'POST', headers: { 'X-Postmark-Server-Token': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ From: m.from, To: m.to, Subject: m.subject, TextBody: m.text || undefined, HtmlBody: m.html, ReplyTo: reply ? reply.email : undefined, MessageStream: 'outbound',
        Headers: m.headers ? Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })) : undefined,
        Attachments: m.attachments.map(a => ({ Name: a.filename, Content: b64(a.content), ContentType: a.contentType || 'application/octet-stream' })) }) }, 30000);
    if (!r.ok || (r.json?.ErrorCode && r.json.ErrorCode !== 0)) throw new Error(apiError(p, r));
    return r.json?.MessageID || null;
  }
  // SendGrid v3
  r = await http(base + '/v3/mail/send', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ personalizations: [{ to: [{ email: m.to }] }], from: from.name ? from : { email: from.email }, ...(reply ? { reply_to: { email: reply.email } } : {}), subject: m.subject,
      content: [...(m.text ? [{ type: 'text/plain', value: m.text }] : []), { type: 'text/html', value: m.html }], headers: m.headers,
      ...(m.attachments.length ? { attachments: m.attachments.map(a => ({ filename: a.filename, content: b64(a.content), type: a.contentType || 'application/octet-stream', disposition: 'attachment' })) } : {}) }) }, 30000);
  if (!r.ok) throw new Error(apiError(p, r));
  return r.headers?.get?.('x-message-id') || null;
}
/** Check an API key without sending anything. */
async function apiVerify(s) {
  const p = s.email_provider, key = s.email_api_key, base = emailApiBase(p), name = EMAIL_APIS[p].label;
  if (p === 'resend') {
    const r = await http(base + '/domains', { headers: { Authorization: `Bearer ${key}` } });
    if (r.ok) { const doms = r.json?.data || []; const fromDom = (splitAddr(fromAddress(s)).email.split('@')[1] || '').toLowerCase(); const d = doms.find(x => String(x.name).toLowerCase() === fromDom);
      return [[true, `Log in to ${name}`, 'API key accepted'], fromDom && [d && d.status === 'verified' ? true : d ? null : false, 'Your sending domain', d ? (d.status === 'verified' ? `${fromDom} is verified` : `${fromDom} is ${d.status} in Resend. Finish adding its DNS records, then check again.`) : `${fromDom} isn't added in Resend yet. Add it under Domains and add the DNS records (Resend can do Cloudflare for you).`]].filter(Boolean); }
    if (r.json?.name === 'restricted_api_key') return [[true, `Log in to ${name}`, 'Send-only API key accepted. Make sure your From domain is verified in Resend → Domains.']];
    return [[false, `Log in to ${name}`, apiError(p, r)]];
  }
  if (p === 'postmark') {
    const r = await http(base + '/server', { headers: { 'X-Postmark-Server-Token': key, Accept: 'application/json' } });
    return [[r.ok, `Log in to ${name}`, r.ok ? `Server "${r.json?.Name || ''}" — your From address must be a verified Sender Signature or domain in Postmark.` : apiError(p, r)]];
  }
  const r = await http(base + '/v3/scopes', { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) return [[false, `Log in to ${name}`, apiError(p, r)]];
  const sc = r.json?.scopes || [];
  return [[sc.includes('mail.send'), `Log in to ${name}`, sc.includes('mail.send') ? 'API key accepted. Your From address must be a verified sender or domain in SendGrid.' : 'This API key is missing the Mail Send permission. Create one with Mail Send access.']];
}

/**
 * @param {object} o { to, subject, text, html?, attachments?: [{filename, content: Buffer, contentType}], replyTo?, contact_id?, contact?, user_id?, contract_id? }
 */
export async function sendEmail(o) {
  const s = getSettings();
  const to = String(o.to || '').trim();
  const base = { channel: 'email', to, subject: o.subject, body: o.text, contact_id: o.contact_id, user_id: o.user_id, contract_id: o.contract_id };
  if (!/^\S+@\S+\.\S+$/.test(to)) return { ok: false, status: 'failed', error: 'Not a valid email address', id: logMessage({ ...base, status: 'failed', error: 'Not a valid email address' }) };
  if (testMode()) return { ok: true, status: 'test', id: logMessage({ ...base, status: 'test', provider: 'test', from: s.email_from || 'test' }) };
  if (!emailReady(s)) {
    const error = 'Email is not set up yet. Admin → Settings → Messaging.';
    return { ok: false, status: 'failed', error, id: logMessage({ ...base, status: 'failed', error }) };
  }
  try {
    let provider_id = null;
    const html = o.html || textToHtml(o.text, s);
    if (s.email_provider === 'smtp') {
      const info = await smtp(s).sendMail({
        from: fromAddress(s), to, subject: o.subject || '(no subject)', text: o.text, html,
        replyTo: o.replyTo || s.email_reply_to || undefined, attachments: o.attachments || [],
        headers: o.contact_id ? { 'X-ShedBuilder-Contact': String(o.contact_id) } : undefined,
      });
      provider_id = info.messageId;
    } else if (s.email_provider === 'ghl') {
      const contactId = await ghlContactId(s, o.contact || { email: to });
      provider_id = await ghlSend(s, { type: 'Email', contactId, subject: o.subject || '', html, message: o.text, ...(fromAddress(s) ? { emailFrom: fromAddress(s) } : {}) });
    } else if (EMAIL_APIS[s.email_provider]) {
      provider_id = await apiSend(s, { from: fromAddress(s), to, subject: o.subject || '(no subject)', text: o.text, html, replyTo: o.replyTo || s.email_reply_to || '', attachments: o.attachments || [],
        headers: o.contact_id ? { 'X-ShedBuilder-Contact': String(o.contact_id) } : undefined });
    }
    return { ok: true, status: 'sent', id: logMessage({ ...base, status: 'sent', provider: s.email_provider, provider_id, from: fromAddress(s) }) };
  } catch (e) {
    const error = s.email_provider === 'smtp' ? friendlySmtp(e) : e.name === 'AbortError' ? 'The email service did not answer in time. Try again.' : e.message;
    return { ok: false, status: 'failed', error, id: logMessage({ ...base, status: 'failed', provider: s.email_provider, error }) };
  }
}

/** Store an inbound message (from the Twilio / email / GHL webhooks). */
export function logInbound({ contact_id, channel, from, to, subject, body, provider, provider_id }) {
  return logMessage({ contact_id, channel, direction: 'in', from, to, subject, body, status: 'received', provider, provider_id });
}

// ---- Twilio webhook signature check --------------------------------------
export function twilioSignatureOk(url, params, signature, token) {
  if (!token || !signature) return false;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function updateDeliveryStatus(provider_id, status, error, code) {
  if (code) error = friendlyTwilio(code, error);
  const m = get('SELECT id FROM messages WHERE provider_id = ?', provider_id);
  if (m) run('UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE id = ?', status, error || null, m.id);
  return m;
}

// ---------------------------------------------------------------------------
// "Check connection": test the saved credentials without sending anything
// ---------------------------------------------------------------------------
const twAuth = s => ({ Authorization: 'Basic ' + Buffer.from(`${s.twilio_sid}:${s.twilio_token}`).toString('base64') });
async function twilioNumber(s) {
  const r = await http(`${TWILIO()}/2010-04-01/Accounts/${encodeURIComponent(s.twilio_sid)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(toE164(s.twilio_from) || s.twilio_from)}`, { headers: twAuth(s) });
  return r.ok ? (r.json?.incoming_phone_numbers || [])[0] || null : null;
}
/**
 * @returns {{ok:boolean, checks:Array<{ok:boolean|null, label:string, detail?:string}>, account?:string}}
 *   ok:null on a check = a warning (works, but something to fix)
 */
export async function verifyMessaging(channel, { webhookUrl } = {}) {
  const s = getSettings(); const checks = []; const add = (ok, label, detail) => checks.push({ ok, label, detail });
  try {
    if (channel === 'sms') {
      if (s.sms_provider === 'twilio') {
        if (!s.twilio_sid || !s.twilio_token) { add(false, 'Account SID and Auth Token', 'Enter both, then Save.'); return { ok: false, checks }; }
        if (!/^AC[0-9a-f]{32}$/i.test(s.twilio_sid)) add(false, 'Account SID format', 'It should start with AC followed by 32 letters/numbers.');
        const a = await http(`${TWILIO()}/2010-04-01/Accounts/${encodeURIComponent(s.twilio_sid)}.json`, { headers: twAuth(s) });
        if (!a.ok) { add(false, 'Log in to Twilio', a.json?.code ? friendlyTwilio(a.json.code) : friendlyTwilio(20003)); return { ok: false, checks }; }
        add(true, 'Log in to Twilio', `Account "${a.json?.friendly_name || s.twilio_sid}" (${a.json?.status || 'active'})`);
        if (a.json?.type === 'Trial') add(null, 'Trial account', 'Trial accounts only text numbers verified in Twilio and add "Sent from your Twilio trial account". Upgrade before texting customers.');
        if (s.twilio_messaging_service_sid) {
          add(true, 'Messaging Service', `${s.twilio_messaging_service_sid} — texts go out from the numbers in that service. Set its incoming-message webhook to the URL below so replies reach the CRM.`);
        } else if (!s.twilio_from) add(false, 'Your Twilio number', 'Enter the Twilio phone number to text from.');
        else {
          const n = await twilioNumber(s);
          if (!n) add(false, 'Your Twilio number', `${s.twilio_from} isn't in this Twilio account. Copy it from Phone Numbers → Active numbers.`);
          else {
            add(n.capabilities?.sms === false ? false : true, 'Your Twilio number', n.capabilities?.sms === false ? `${n.phone_number} can't send texts.` : `${n.friendly_name || n.phone_number} can send texts`);
            if (webhookUrl) {
              if (n.sms_url === webhookUrl) add(true, 'Customer replies', 'Replies come back into Conversations.');
              else add(null, 'Customer replies', n.sms_url ? `Replies currently go to ${n.sms_url}, not to this app. Click "Connect replies for me".` : 'Replies are not connected yet. Click "Connect replies for me".');
            }
          }
        }
      } else if (s.sms_provider === 'ghl') {
        if (!s.ghl_token || !s.ghl_location_id) { add(false, 'GoHighLevel token and Location ID', 'Enter them in Integrations → GoHighLevel first.'); return { ok: false, checks }; }
        const r = await http(`${GHL_BASE()}/locations/${encodeURIComponent(s.ghl_location_id)}`, { headers: { Authorization: `Bearer ${s.ghl_token}`, Version: '2021-07-28', Accept: 'application/json' } });
        add(r.ok, 'Log in to GoHighLevel', r.ok ? `Sub-account "${r.json?.location?.name || r.json?.name || s.ghl_location_id}"` : r.status === 401 || r.status === 403 ? 'The token was rejected or lacks the locations.readonly scope.' : `GoHighLevel answered ${r.status}.`);
        add(null, 'Customer replies', 'To see replies here, add a GHL workflow: Customer Replied → Webhook (POST) to the GHL URL below.');
      } else { add(false, 'Texting provider', 'Choose Twilio or GoHighLevel.'); }
    } else {
      if (s.email_provider === 'smtp') {
        if (!s.smtp_host) { add(false, 'SMTP server', 'Pick your email provider (or enter the SMTP host), then Save.'); return { ok: false, checks }; }
        if (!fromAddress(s)) add(false, 'From address', 'Enter the address emails come from.');
        try { await smtp(s).verify(); add(true, 'Log in to the email server', `${s.smtp_host}:${Number(s.smtp_port) || 587} accepted ${s.smtp_user || 'the connection'}`); }
        catch (e) { add(false, 'Log in to the email server', friendlySmtp(e)); }
        if (fromAddress(s) && s.smtp_user && /@/.test(s.smtp_user)) {
          const fromDomain = (fromAddress(s).match(/@([^>\s]+)/) || [])[1], userDomain = s.smtp_user.split('@')[1];
          if (fromDomain && userDomain && fromDomain.toLowerCase() !== userDomain.toLowerCase() && /gmail|office365|outlook|yahoo/i.test(s.smtp_host)) add(null, 'From address', `You log in as ${s.smtp_user} but send from @${fromDomain}. ${/gmail/i.test(s.smtp_host) ? 'Gmail' : 'Your provider'} may replace or block that From address unless it is set up as an alias.`);
        }
      } else if (s.email_provider === 'ghl') {
        add(!!(s.ghl_token && s.ghl_location_id), 'GoHighLevel', s.ghl_token && s.ghl_location_id ? 'Emails go out through your GHL sub-account (LC Email or your connected mailbox).' : 'Enter the token and Location ID in Integrations → GoHighLevel.');
      } else if (EMAIL_APIS[s.email_provider]) {
        if (!s.email_api_key) { add(false, `${EMAIL_APIS[s.email_provider].label} API key`, 'Paste your API key, then Save.'); return { ok: false, checks }; }
        if (!fromAddress(s)) add(false, 'From address', 'Enter the From email (an address on a domain you verified with the email service).');
        for (const [ok, label, detail] of await apiVerify(s)) add(ok, label, detail);
      } else add(false, 'Email provider', 'Choose your email provider.');
    }
  } catch (e) { add(false, 'Connection', e.name === 'AbortError' ? 'The provider did not answer in time. Try again.' : e.message); }
  return { ok: checks.every(c => c.ok !== false), checks };
}
/** Point the Twilio number's "A message comes in" webhook at this app. */
export async function connectTwilioReplies(webhookUrl) {
  const s = getSettings();
  if (!/^https:\/\//.test(webhookUrl)) throw new Error('Set Settings → Public URL to your https:// address first. Twilio can only send replies to a public https address.');
  const n = await twilioNumber(s); if (!n) throw new Error(`${s.twilio_from} isn't in this Twilio account.`);
  const r = await http(`${TWILIO()}/2010-04-01/Accounts/${encodeURIComponent(s.twilio_sid)}/IncomingPhoneNumbers/${n.sid}.json`, { method: 'POST', headers: { ...twAuth(s), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SmsUrl: webhookUrl, SmsMethod: 'POST' }) });
  if (!r.ok) throw new Error(r.json?.code ? friendlyTwilio(r.json.code, r.json.message) : `Twilio answered ${r.status}`);
  return { number: n.phone_number, sms_url: webhookUrl };
}
