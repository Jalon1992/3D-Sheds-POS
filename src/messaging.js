// Outbound texts & emails. Providers: Twilio (SMS/MMS), any SMTP server (email), or your
// GoHighLevel sub-account (sends through GHL's LC Phone / email, so it uses your A2P-registered number).
// Every message is logged in the `messages` table so it shows in the CRM conversation.
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { get, run, getSettings } from './db.js';

const testMode = () => process.env.MESSAGING_TEST_MODE === '1' || getSettings().messaging_test_mode === true;

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

/** {{contact.first_name}} style merge tags. Unknown tags become ''. */
export function fill(tpl, ctx) {
  return String(tpl ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), ctx);
    return v == null ? '' : String(v);
  });
}

export function smsReady(s = getSettings()) {
  if (testMode()) return true;
  if (s.sms_provider === 'twilio') return !!(s.twilio_sid && s.twilio_token && (s.twilio_from || s.twilio_messaging_service_sid));
  if (s.sms_provider === 'ghl') return !!(s.ghl_token && s.ghl_location_id);
  return false;
}
export function emailReady(s = getSettings()) {
  if (testMode()) return true;
  if (s.email_provider === 'smtp') return !!(s.smtp_host && s.email_from);
  if (s.email_provider === 'ghl') return !!(s.ghl_token && s.ghl_location_id);
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
  try { const r = await fetch(url, { ...opt, signal: ctrl.signal }); const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = null; } return { ok: r.ok, status: r.status, text, json }; }
  finally { clearTimeout(t); }
}

// ---- GoHighLevel transport -------------------------------------------------
const GHL = 'https://services.leadconnectorhq.com';
async function ghlContactId(s, contact) {
  const r = await http(GHL + '/contacts/upsert', {
    method: 'POST', headers: { Authorization: `Bearer ${s.ghl_token}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ locationId: s.ghl_location_id, firstName: contact.first_name || undefined, lastName: contact.last_name || undefined, email: contact.email || undefined, phone: contact.phone_e164 || contact.phone || undefined, source: s.ghl_source || '3D Shed Builder' }),
  });
  if (!r.ok) throw new Error(`GHL contact upsert ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json?.contact?.id || r.json?.id;
}
async function ghlSend(s, payload) {
  const r = await http(GHL + '/conversations/messages', {
    method: 'POST', headers: { Authorization: `Bearer ${s.ghl_token}`, Version: '2021-04-15', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`GHL send ${r.status}: ${r.text.slice(0, 300)}`);
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
      const r = await http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.twilio_sid)}/Messages.json`, {
        method: 'POST', body: form,
        headers: { Authorization: 'Basic ' + Buffer.from(`${s.twilio_sid}:${s.twilio_token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!r.ok) throw new Error(r.json?.message ? `Twilio: ${r.json.message}` : `Twilio ${r.status}: ${r.text.slice(0, 200)}`);
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
        from: s.email_from, to, subject: o.subject || '(no subject)', text: o.text, html,
        replyTo: o.replyTo || s.email_reply_to || undefined, attachments: o.attachments || [],
        headers: o.contact_id ? { 'X-ShedBuilder-Contact': String(o.contact_id) } : undefined,
      });
      provider_id = info.messageId;
    } else if (s.email_provider === 'ghl') {
      const contactId = await ghlContactId(s, o.contact || { email: to });
      provider_id = await ghlSend(s, { type: 'Email', contactId, subject: o.subject || '', html, message: o.text, ...(s.email_from ? { emailFrom: s.email_from } : {}) });
    }
    return { ok: true, status: 'sent', id: logMessage({ ...base, status: 'sent', provider: s.email_provider, provider_id, from: s.email_from }) };
  } catch (e) {
    return { ok: false, status: 'failed', error: e.message, id: logMessage({ ...base, status: 'failed', provider: s.email_provider, error: e.message }) };
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
export function updateDeliveryStatus(provider_id, status, error) {
  const m = get('SELECT id FROM messages WHERE provider_id = ?', provider_id);
  if (m) run('UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE id = ?', status, error || null, m.id);
  return m;
}
