// Real provider paths (test mode OFF): Twilio + GoHighLevel against a stand-in API that records every request,
// and email through a real local SMTP server. Checks exactly what goes over the wire and how failures read.
// Run: npm run test:messaging
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4300 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
const SID = 'AC' + 'a'.repeat(32), TOKEN = 'b'.repeat(32), PUBLIC = 'https://shed.example.com';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let srv, dir, mock, mockPort, smtp, smtpPort;
const calls = []; const mail = [];
const state = { smsUrl: '', trial: false };

// ---- stand-in Twilio + GoHighLevel API ------------------------------------------------
function startMock() {
  return new Promise(res => {
    mock = http.createServer((req, rsp) => {
      let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
        const u = new URL(req.url, 'http://x'); const call = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body };
        try { call.form = Object.fromEntries(new URLSearchParams(body)); } catch { /* */ }
        try { call.json = JSON.parse(body); } catch { /* */ }
        calls.push(call);
        const send = (code, obj) => { rsp.writeHead(code, { 'Content-Type': 'application/json' }); rsp.end(JSON.stringify(obj)); };
        const authOk = req.headers.authorization === 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
        if (u.pathname.startsWith('/2010-04-01')) {
          if (!authOk) return send(401, { code: 20003, message: 'Authenticate', status: 401 });
          if (u.pathname === `/2010-04-01/Accounts/${SID}.json`) return send(200, { sid: SID, friendly_name: 'Trimline Test', status: 'active', type: state.trial ? 'Trial' : 'Full' });
          if (u.pathname.endsWith('/IncomingPhoneNumbers.json')) return send(200, { incoming_phone_numbers: u.searchParams.get('PhoneNumber') === '+16155550000' ? [{ sid: 'PN1', phone_number: '+16155550000', friendly_name: '(615) 555-0000', capabilities: { sms: true }, sms_url: state.smsUrl }] : [] });
          if (u.pathname.endsWith('/IncomingPhoneNumbers/PN1.json')) { state.smsUrl = call.form.SmsUrl; return send(200, { sid: 'PN1', sms_url: state.smsUrl }); }
          if (u.pathname.endsWith('/Messages.json')) {
            if (call.form.To === '+16155559301') return send(400, { code: 30034, message: 'Message from an Unregistered Number', status: 400 });
            if (call.form.To === '+16155559302') return send(400, { code: 21608, message: 'The number is unverified', status: 400 });
            return send(201, { sid: 'SM' + crypto.randomBytes(8).toString('hex'), status: 'queued' });
          }
        }
        if (u.pathname.startsWith('/ghl')) {
          if (req.headers.authorization !== 'Bearer ghl-good') return send(401, { message: 'Invalid JWT' });
          if (u.pathname === '/ghl/contacts/upsert') return send(200, { contact: { id: 'ghlc_' + (call.json.phone || call.json.email) } });
          if (u.pathname === '/ghl/conversations/messages') return send(200, { conversationId: 'cv1', messageId: 'ghlm_' + calls.length });
          if (u.pathname === '/ghl/locations/loc1') return send(200, { location: { id: 'loc1', name: 'Trimline Barns' } });
        }
        if (u.pathname.startsWith('/mail')) { // stand-in Resend / Postmark / SendGrid
          const k = req.headers.authorization || req.headers['x-postmark-server-token'] || '';
          if (!/(Bearer )?(re_good|pm-good|SG\.good)$/.test(k)) return send(401, { name: 'validation_error', message: 'API key is invalid', ErrorCode: 10, Message: 'Bad token' });
          if (u.pathname === '/mail/domains') return send(200, { data: [{ name: 'trimline.test', status: 'verified' }] });
          if (u.pathname === '/mail/server') return send(200, { Name: 'Trimline' });
          if (u.pathname === '/mail/v3/scopes') return send(200, { scopes: ['mail.send'] });
          if (u.pathname === '/mail/emails') return send(200, { id: 'rs_1' });
          if (u.pathname === '/mail/email') return send(200, { ErrorCode: 0, MessageID: 'pm_1' });
          if (u.pathname === '/mail/v3/mail/send') { rsp.writeHead(202, { 'X-Message-Id': 'sg_1' }); return rsp.end(); }
        }
        send(404, { message: 'not found' });
      });
    }).listen(0, '127.0.0.1', () => { mockPort = mock.address().port; res(); });
  });
}
function startSmtp() {
  return new Promise(res => {
    smtp = new SMTPServer({
      secure: false, authOptional: false, disabledCommands: ['STARTTLS'], logger: false,
      onAuth(auth, session, cb) { return auth.username === 'sales@trimline.test' && auth.password === 'abcdefghijklmnop' ? cb(null, { user: 1 }) : cb(Object.assign(new Error('535 5.7.8 Username and Password not accepted'), { responseCode: 535 })); },
      onData(stream, session, cb) { simpleParser(stream).then(m => { mail.push({ ...m, envelope: session.envelope }); cb(); }, cb); },
    });
    smtp.listen(0, '127.0.0.1', () => { smtpPort = smtp.server.address().port; res(); });
  });
}
class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const isForm = body instanceof FormData;
    const r = await fetch(B + url, { method, headers: { ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) }, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; } return { status: r.status, data };
  }
}
const admin = new Client();
const put = b => admin.req('PUT', '/api/admin/settings', b);
const twilioPost = async (path, params, url = PUBLIC + path, host) => {
  const sig = crypto.createHmac('sha1', TOKEN).update(url + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
  return fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig, ...(host ? { 'X-Forwarded-Host': host } : {}) }, body: new URLSearchParams(params) });
};
const lastCall = pathEnd => [...calls].reverse().find(c => c.path.endsWith(pathEnd));

before(async () => {
  await startMock(); await startSmtp();
  dir = mkdtempSync(join(tmpdir(), 'shedmsg-'));
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT, DB_PATH: join(dir, 'db.sqlite'), UPLOAD_DIR: join(dir, 'up'), ADMIN_EMAIL: 'owner@test.com', ADMIN_PASSWORD: 'owner-pass-1', MESSAGING_TEST_MODE: '', TWILIO_API_BASE: `http://127.0.0.1:${mockPort}`, GHL_API_BASE: `http://127.0.0.1:${mockPort}/ghl`, EMAIL_API_BASE: `http://127.0.0.1:${mockPort}/mail` } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* */ } await new Promise(r => setTimeout(r, 200)); }
  await admin.req('POST', '/api/auth/login', { email: 'owner@test.com', password: 'owner-pass-1' });
  await put({ public_url: PUBLIC, company_name: 'Trimline Barns' });
});
after(() => { srv?.kill(); mock?.close(); smtp?.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

test('not set up yet: clear message, nothing sent', async () => {
  const st = (await admin.req('GET', '/api/admin/messaging/status')).data;
  assert.equal(st.sms, false); assert.equal(st.email, false); assert.equal(st.test_mode, false);
  const r = await admin.req('POST', '/api/admin/messaging/test', { channel: 'sms', to: '6155551234' });
  assert.equal(r.status, 502); assert.match(r.data.error, /Texting is not set up yet/);
});

test('Twilio: settings are cleaned up, bad credentials explained, check connection + connect replies', async () => {
  assert.equal((await put({ sms_provider: 'twilio', twilio_sid: '  ' + SID + ' ', twilio_token: 'wrong', twilio_from: '(615) 555-0000' })).status, 200);
  const s = (await admin.req('GET', '/api/admin/settings')).data;
  assert.equal(s.twilio_sid, SID, 'spaces trimmed'); assert.equal(s.twilio_from, '+16155550000', 'number stored as +1');
  assert.equal((await put({ twilio_from: '555-12' })).status, 400, 'bad number refused');
  let v = (await admin.req('POST', '/api/admin/messaging/verify', { channel: 'sms' })).data;
  assert.equal(v.ok, false); assert.match(v.checks.at(-1).detail, /Account SID or Auth Token/);
  await put({ twilio_token: TOKEN });
  state.trial = true;
  v = (await admin.req('POST', '/api/admin/messaging/verify', { channel: 'sms' })).data;
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(v.checks.some(c => c.label === 'Trial account' && c.ok === null));
  assert.ok(v.checks.some(c => c.label === 'Customer replies' && c.ok === null && /Connect replies/.test(c.detail)));
  const con = await admin.req('POST', '/api/admin/messaging/twilio-connect');
  assert.equal(con.status, 200); assert.equal(state.smsUrl, PUBLIC + '/api/hooks/twilio/sms');
  assert.equal(lastCall('/IncomingPhoneNumbers/PN1.json').form.SmsMethod, 'POST');
  v = (await admin.req('POST', '/api/admin/messaging/verify', { channel: 'sms' })).data;
  assert.ok(v.checks.some(c => c.label === 'Customer replies' && c.ok === true));
  state.trial = false;
  await put({ twilio_from: '6155550001' });
  v = (await admin.req('POST', '/api/admin/messaging/verify', { channel: 'sms' })).data;
  assert.equal(v.ok, false); assert.match(v.checks.find(c => c.label === 'Your Twilio number').detail, /isn't in this Twilio account/);
  await put({ twilio_from: '+16155550000' });
});

test('Twilio: texting a customer sends the right request; carrier errors read in plain English', async () => {
  const c = (await admin.req('POST', '/api/crm/contacts', { first_name: 'Tina', phone: '(615) 555-0142', email: 'tina@example.com' })).data;
  const r = await admin.req('POST', `/api/crm/contacts/${c.id}/messages`, { channel: 'sms', body: 'Hi {{contact.first_name}}!' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.status, 'sent');
  const call = lastCall('/Messages.json');
  assert.equal(call.form.To, '+16155550142'); assert.equal(call.form.From, '+16155550000'); assert.equal(call.form.Body, 'Hi Tina!');
  assert.equal(call.form.StatusCallback, PUBLIC + '/api/hooks/twilio/status');
  // delivery report from the carrier: undelivered, A2P block
  const sid = (await admin.req('GET', '/api/admin/messaging/status')).data.recent[0];
  const msgs = (await admin.req('GET', `/api/crm/contacts/${c.id}`)).data.timeline.filter(t => t.kind === 'message');
  const providerSid = msgs.at(-1).provider_id; assert.match(providerSid, /^SM/); void sid;
  const st = await twilioPost('/api/hooks/twilio/status', { MessageSid: providerSid, MessageStatus: 'undelivered', ErrorCode: '30034' });
  assert.equal(st.status, 204);
  const after = (await admin.req('GET', `/api/crm/contacts/${c.id}`)).data.timeline.filter(t => t.kind === 'message').at(-1);
  assert.equal(after.status, 'failed'); assert.match(after.error, /A2P 10DLC/);
  // send-time errors
  const a2p = (await admin.req('POST', '/api/crm/contacts', { first_name: 'Blocked', phone: '6155559301' })).data;
  const e1 = await admin.req('POST', `/api/crm/contacts/${a2p.id}/messages`, { channel: 'sms', body: 'hi' });
  assert.equal(e1.status, 502); assert.match(e1.data.error, /isn't registered for business texting/);
  const tr = await admin.req('POST', '/api/admin/messaging/test', { channel: 'sms', to: '615-555-9302' });
  assert.equal(tr.status, 502); assert.match(tr.data.error, /trial account/);
});

test('Twilio: replies come in (signature checked), photos included, wrong URL is explained', async () => {
  const params = { From: '+16155550142', To: '+16155550000', Body: 'Is delivery free?', MessageSid: 'SMin1', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/1.jpg' };
  const ok = await twilioPost('/api/hooks/twilio/sms', params);
  assert.equal(ok.status, 200); assert.match(await ok.text(), /<Response>/);
  const tina = (await admin.req('GET', '/api/crm/contacts?q=Tina')).data.data[0];
  const inMsg = (await admin.req('GET', `/api/crm/contacts/${tina.id}`)).data.timeline.filter(t => t.kind === 'message' && t.direction === 'in').at(-1);
  assert.match(inMsg.body, /Is delivery free\?\nhttps:\/\/api\.twilio\.com\/media\/1\.jpg/);
  assert.equal(tina.unread, 1);
  // Twilio configured with the onrender.com address while Public URL is the custom domain: still accepted
  const viaHost = await twilioPost('/api/hooks/twilio/sms', { ...params, MessageSid: 'SMin2', Body: 'second' }, `https://127.0.0.1:${PORT}/api/hooks/twilio/sms`);
  assert.equal(viaHost.status, 200, 'request-host URL accepted');
  // signed for some other URL: refused, and the Messaging page explains why
  const bad = await twilioPost('/api/hooks/twilio/sms', { ...params, MessageSid: 'SMin3' }, 'https://wrong.example.com/api/hooks/twilio/sms');
  assert.equal(bad.status, 403);
  const st = (await admin.req('GET', '/api/admin/messaging/status')).data;
  assert.match(st.inbound_last_error.reason, /Public URL/); assert.equal(st.last_sms_in.from_addr, '+16155550142');
  // STOP
  await twilioPost('/api/hooks/twilio/sms', { ...params, MessageSid: 'SMin4', Body: 'STOP', NumMedia: '0', MediaUrl0: '' });
  const blocked = await admin.req('POST', `/api/crm/contacts/${tina.id}/messages`, { channel: 'sms', body: 'hello?' });
  assert.equal(blocked.status, 400); assert.match(blocked.data.error, /opted out/);
});

test('Email (SMTP): wrong password explained, then real emails with the right From / Reply-To / attachments', async () => {
  await put({ email_provider: 'smtp', smtp_host: '127.0.0.1', smtp_port: String(smtpPort), smtp_secure: false, smtp_user: 'sales@trimline.test', smtp_pass: 'wrong-pass', email_from: '' });
  let v = (await admin.req('POST', '/api/admin/messaging/verify', { channel: 'email' })).data;
  assert.equal(v.ok, false); assert.match(v.checks.find(c => /Log in/.test(c.label)).detail, /App Password|username or password/i);
  await put({ smtp_pass: 'abcd efgh ijkl mnop' }); // pasted the way Google shows it
  v = (await admin.req('POST', '/api/admin/messaging/verify', { channel: 'email' })).data;
  assert.equal(v.ok, true, JSON.stringify(v));
  const st = (await admin.req('GET', '/api/admin/messaging/status')).data;
  assert.equal(st.email, true); assert.equal(st.from, '"Trimline Barns" <sales@trimline.test>', 'From defaults to company name + login');
  const t = await admin.req('POST', '/api/admin/messaging/test', { channel: 'email', to: 'owner@example.com' });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const m1 = mail.at(-1); assert.equal(m1.to.text, 'owner@example.com'); assert.equal(m1.from.value[0].address, 'sales@trimline.test'); assert.equal(m1.from.value[0].name, 'Trimline Barns');
  // rep emails a customer from the CRM: replies go to the rep
  const tina = (await admin.req('GET', '/api/crm/contacts?q=Tina')).data.data[0];
  const r = await admin.req('POST', `/api/crm/contacts/${tina.id}/messages`, { channel: 'email', subject: 'Your shed, {{contact.first_name}}', body: 'See you at https://shed.example.com/?q=abc' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const m2 = mail.at(-1);
  assert.equal(m2.subject, 'Your shed, Tina'); assert.equal(m2.replyTo.value[0].address, 'owner@test.com');
  assert.match(m2.html, /<a href="https:\/\/shed\.example\.com\/\?q=abc"/); assert.match(m2.text, /See you at/);
  // a From the server rejects is explained
  await put({ email_from: 'not-an-email' }).then(x => assert.equal(x.status, 400));
});

test('Email over the web (Resend, Postmark, SendGrid): works where SMTP ports are blocked; key checked; bad key explained', async () => {
  for (const [prov, key, path] of [['resend', 're_good', '/mail/emails'], ['postmark', 'pm-good', '/mail/email'], ['sendgrid_api', 'SG.good', '/mail/v3/mail/send']]) {
    await put({ email_provider: prov, email_api_key: 'bad', email_from: '"Trimline Barns" <sales@trimline.test>', email_reply_to: '' });
    let v = (await admin.req('POST', '/api/admin/messaging/verify', { channel: 'email' })).data;
    assert.equal(v.ok, false, prov); assert.match(v.checks.at(-1).detail, /rejected the API key/, prov);
    await put({ email_api_key: key });
    const shown = (await admin.req('GET', '/api/admin/settings')).data; assert.ok(shown.email_api_key_set && !shown.email_api_key.includes(key.slice(0, 4)) || key.length <= 4, 'key is masked');
    v = (await admin.req('POST', '/api/admin/messaging/verify', { channel: 'email' })).data;
    assert.equal(v.ok, true, prov + ' ' + JSON.stringify(v));
    assert.equal((await admin.req('GET', '/api/admin/messaging/status')).data.email, true);
    const t = await admin.req('POST', '/api/admin/messaging/test', { channel: 'email', to: 'owner@example.com' });
    assert.equal(t.status, 200, prov + ' ' + JSON.stringify(t.data));
    const c = lastCall(path), j = c.json;
    if (prov === 'resend') { assert.deepEqual(j.to, ['owner@example.com']); assert.equal(j.from, '"Trimline Barns" <sales@trimline.test>'); assert.match(j.html, /test email/); assert.equal(c.headers.authorization, 'Bearer re_good'); }
    if (prov === 'postmark') { assert.equal(j.To, 'owner@example.com'); assert.equal(j.MessageStream, 'outbound'); assert.equal(c.headers['x-postmark-server-token'], 'pm-good'); }
    if (prov === 'sendgrid_api') { assert.deepEqual(j.personalizations, [{ to: [{ email: 'owner@example.com' }] }]); assert.deepEqual(j.from, { name: 'Trimline Barns', email: 'sales@trimline.test' }); assert.equal(j.content.at(-1).type, 'text/html'); }
  }
  // a rep emails a customer through Resend: Reply-To is the rep
  await put({ email_provider: 'resend', email_api_key: 're_good' });
  const tina = (await admin.req('GET', '/api/crm/contacts?q=Tina')).data.data[0];
  assert.equal((await admin.req('POST', `/api/crm/contacts/${tina.id}/messages`, { channel: 'email', subject: 'Hi {{contact.first_name}}', body: 'Hello' })).status, 200);
  const r = lastCall('/mail/emails').json; assert.equal(r.subject, 'Hi Tina'); assert.equal(r.reply_to, 'owner@test.com');
  // a From is required for the web services (there's no login address to fall back on)
  await put({ email_from: '' });
  assert.equal((await admin.req('GET', '/api/admin/messaging/status')).data.email, false);
  await put({ email_provider: 'smtp', email_from: '' });
});

test('Contract by text + email over the real providers, signed copy emailed as a PDF attachment, owner alerted', async () => {
  await put({ notify_phones: '(615) 555-0100', notify_emails: 'boss@trimline.test', notify_on_signed: true });
  const cat = (await fetch(B + '/api/v1/catalog').then(r => r.json())); const st = cat.styles[0];
  const q = (await admin.req('POST', '/api/v1/quotes', { config: { style_id: st.id, size_id: st.sizes[0].id }, customer: { first_name: 'Carl', last_name: 'Contract', email: 'carl@example.com', phone: '6155550170' } })).data;
  const meta = (await admin.req('GET', '/api/pos/meta')).data; const tpl = meta.templates.find(t => t.sale_type === 'cash');
  const fd = new FormData(); fd.append('payload', JSON.stringify({ quote_id: q.id, template_id: tpl.id, sale_type: 'cash', signers: { customer: { name: 'Carl Contract', email: 'carl@example.com', phone: '6155550170' } } }));
  const k = (await admin.req('POST', '/api/pos/contracts', fd)).data;
  const before = mail.length;
  const sent = await admin.req('POST', `/api/pos/contracts/${k.id}/send`, { sms: true, email: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.data)); assert.ok(sent.data.results.every(x => x.ok));
  const sms = lastCall('/Messages.json'); assert.equal(sms.form.To, '+16155550170'); assert.match(sms.form.Body, /ready to sign: https:\/\/shed\.example\.com\/sign\/[\w-]+/);
  const toCarl = mail.slice(before).filter(m => m.to.text === 'carl@example.com'); assert.equal(toCarl.length, 1, 'one signing email to the customer');
  const em = toCarl[0]; assert.match(em.subject, /Please sign/);
  assert.ok(mail.some(m => m.to.text === 'boss@trimline.test' && /New 3D lead/.test(m.subject)), 'owner got the new-lead alert'); assert.match(em.text, /https:\/\/shed\.example\.com\/sign\//);
  for (const s of k.signers) {
    const tok = s.link.split('/sign/')[1]; const info = (await fetch(`${B}/api/sign/${tok}`).then(r => r.json()));
    const values = {}; for (const f of info.fields.filter(f => f.mine)) values[f.id] = f.type === 'checkbox' ? true : f.type === 'text' ? 'x' : ['signature', 'initials'].includes(f.type) ? PNG : undefined;
    const r = await fetch(`${B}/api/sign/${tok}/sign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true, values }) });
    assert.equal(r.status, 200);
  }
  await new Promise(r => setTimeout(r, 400));
  const copy = mail.find(m => m.to.text === 'carl@example.com' && /Signed/.test(m.subject));
  assert.ok(copy, 'customer got the signed copy'); assert.equal(copy.attachments[0].contentType, 'application/pdf'); assert.ok(copy.attachments[0].content.subarray(0, 5).toString() === '%PDF-');
  assert.ok(mail.some(m => m.to.text === 'boss@trimline.test' && /Contract signed/.test(m.subject)), 'owner emailed');
  assert.ok(calls.some(c => c.path.endsWith('/Messages.json') && c.form.To === '+16155550100' && /Contract signed/.test(c.form.Body)), 'owner texted');
});

test('GoHighLevel as the provider: upsert + conversations/messages with the right headers; bad token explained', async () => {
  await put({ sms_provider: 'ghl', email_provider: 'ghl', ghl_token: 'ghl-good', ghl_location_id: 'loc1' });
  const v = (await admin.req('POST', '/api/admin/messaging/verify', { channel: 'sms' })).data;
  assert.ok(v.checks.some(c => c.ok === true && /Trimline Barns/.test(c.detail)), JSON.stringify(v));
  const c = (await admin.req('POST', '/api/crm/contacts', { first_name: 'Gina', phone: '6155550180', email: 'gina@example.com' })).data;
  assert.equal((await admin.req('POST', `/api/crm/contacts/${c.id}/messages`, { channel: 'sms', body: 'Hi Gina' })).status, 200);
  const up = lastCall('/ghl/contacts/upsert'), send = lastCall('/ghl/conversations/messages');
  assert.equal(up.json.locationId, 'loc1'); assert.equal(up.json.phone, '+16155550180'); assert.equal(up.headers.version, '2021-07-28');
  assert.deepEqual({ type: send.json.type, contactId: send.json.contactId, message: send.json.message }, { type: 'SMS', contactId: 'ghlc_+16155550180', message: 'Hi Gina' });
  assert.equal(send.headers.version, '2021-04-15'); assert.equal(send.headers.authorization, 'Bearer ghl-good');
  assert.equal((await admin.req('POST', `/api/crm/contacts/${c.id}/messages`, { channel: 'email', subject: 'Hello', body: 'Body' })).status, 200);
  const em = lastCall('/ghl/conversations/messages'); assert.equal(em.json.type, 'Email'); assert.equal(em.json.subject, 'Hello'); assert.match(em.json.html, /Body/);
  await put({ ghl_token: 'ghl-bad' });
  const bad = await admin.req('POST', `/api/crm/contacts/${c.id}/messages`, { channel: 'sms', body: 'x' });
  assert.equal(bad.status, 502); assert.match(bad.data.error, /GoHighLevel rejected the token/);
});
