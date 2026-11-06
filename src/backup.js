// Backups: a full copy of this install (database + uploaded models/images + contract PDFs) as one .tar.gz.
// · automatically every day (BACKUP_HOUR, local time of the company's time zone) and before every update;
// · kept on the volume (BACKUP_KEEP newest) and, when a bucket is configured, copied OFF the server to any
//   S3-compatible storage (Cloudflare R2, Backblaze B2, AWS S3, Wasabi, DigitalOcean Spaces …).
import { mkdirSync, readdirSync, statSync, unlinkSync, rmSync, symlinkSync, existsSync, createReadStream } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { db, BACKUP_DIR, PRE_UPDATE, getSettings, setSettings } from './db.js';
import { APP_VERSION } from './version.js';

const DB_PATH = process.env.DB_PATH || './data/shedbuilder.db';
const env = k => String(process.env[k] || '').trim();
export const offsite = () => ({
  endpoint: env('BACKUP_S3_ENDPOINT').replace(/\/+$/, ''), bucket: env('BACKUP_S3_BUCKET'),
  key: env('BACKUP_S3_ACCESS_KEY'), secret: env('BACKUP_S3_SECRET_KEY'),
  region: env('BACKUP_S3_REGION') || 'auto', prefix: env('BACKUP_S3_PREFIX').replace(/^\/+|\/+$/g, ''),
});
export const offsiteOn = () => { const o = offsite(); return !!(o.endpoint && o.bucket && o.key && o.secret); };
const keepN = () => Math.max(2, Number(process.env.BACKUP_KEEP) || (offsiteOn() ? 3 : 7));
export const NAME_RE = /^(backup|pre-update)-[\w.+-]+\.(tar\.gz|db)$/;

const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shed-builder';

export function listBackups() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  return readdirSync(BACKUP_DIR).filter(f => NAME_RE.test(f)).map(f => { const st = statSync(join(BACKUP_DIR, f)); return { name: f, size: st.size, at: st.mtime.toISOString(), kind: f.startsWith('pre-update') ? 'before update' : 'full' }; })
    .sort((a, b) => b.at.localeCompare(a.at));
}
function prune() {
  const list = listBackups();
  for (const kind of ['full', 'before update']) for (const b of list.filter(x => x.kind === kind).slice(keepN())) { try { unlinkSync(join(BACKUP_DIR, b.name)); } catch { /* */ } }
}

// ---- S3-compatible upload (AWS Signature Version 4, no SDK needed) ---------------------------------------
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha256hex = d => crypto.createHash('sha256').update(d).digest('hex');
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** Signs a request; returns the Authorization header. Exported for the test against AWS's published example. */
export function sigV4({ method, path, query = '', headers, payloadHash, region, service = 's3', accessKey, secretKey, amzDate }) {
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonHeaders = names.map(n => `${n}:${String(headers[Object.keys(headers).find(h => h.toLowerCase() === n)]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signed = names.join(';');
  const canon = [method, path, query, canonHeaders, signed, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canon)].join('\n');
  const kSig = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), service), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${crypto.createHmac('sha256', kSig).update(toSign).digest('hex')}`;
}
async function fileSha256(file) { const h = crypto.createHash('sha256'); for await (const c of createReadStream(file)) h.update(c); return h.digest('hex'); }
export async function uploadOffsite(file) {
  const o = offsite(); if (!offsiteOn()) return { ok: false, skipped: true };
  const company = o.prefix || slug(getSettings().company_name);
  const objectKey = `${company}/${basename(file)}`;
  const url = new URL(`${o.endpoint}/${o.bucket}/${objectKey.split('/').map(enc).join('/')}`);
  const size = statSync(file).size, payloadHash = await fileSha256(file);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const auth = sigV4({ method: 'PUT', path: url.pathname, headers, payloadHash, region: o.region, accessKey: o.key, secretKey: o.secret, amzDate });
  const r = await fetch(url, { method: 'PUT', headers: { ...headers, Authorization: auth, 'Content-Length': String(size), 'Content-Type': 'application/gzip' }, body: Readable.toWeb(createReadStream(file)), duplex: 'half' });
  if (!r.ok) throw new Error(`Off-server copy failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return { ok: true, key: objectKey };
}

// ---- Make a backup -------------------------------------------------------------------------------------
let running = null;
/** Full backup. reason: 'daily' | 'manual' | 'before update'. Never throws; the result says what happened. */
export function backupNow(reason = 'manual') {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `backup-${stampNow()}-${APP_VERSION.id.replace(/[^\w.+-]/g, '_')}.tar.gz`, out = join(BACKUP_DIR, name);
    const stage = join(BACKUP_DIR, `.staging-${process.pid}-${Date.now()}`);
    const result = { name, reason, at: new Date().toISOString(), version: APP_VERSION.id, size: 0, offsite: null, error: null };
    try {
      mkdirSync(stage, { recursive: true });
      db.exec(`VACUUM INTO '${join(stage, 'shedbuilder.db').replace(/'/g, "''")}'`); // consistent copy while the app keeps running
      const parts = ['shedbuilder.db'];
      const uploads = resolve(process.env.UPLOAD_DIR || './uploads'), files = resolve(process.env.FILES_DIR || join(dirname(DB_PATH), 'files'));
      if (existsSync(uploads)) { symlinkSync(uploads, join(stage, 'uploads')); parts.push('uploads'); }
      if (existsSync(files)) { symlinkSync(files, join(stage, 'files')); parts.push('files'); }
      await tar.c({ gzip: true, file: out, cwd: stage, follow: true, portable: true, filter: p => !/(^|\/)(\.staging-|backups\/)/.test(p) }, parts);
      result.size = statSync(out).size;
      if (offsiteOn()) { try { result.offsite = await uploadOffsite(out); } catch (e) { result.offsite = { ok: false, error: e.message }; result.error = e.message; } }
      prune();
    } catch (e) {
      result.error = e.message; try { unlinkSync(out); } catch { /* */ }
      console.error('  ✖  Backup failed:', e.message);
    } finally { try { rmSync(stage, { recursive: true, force: true }); } catch { /* */ } }
    result.ms = Date.now() - started;
    setSettings({ _backup_last: result });
    return result;
  })().finally(() => { running = null; });
  return running;
}

// ---- Schedule ------------------------------------------------------------------------------------------
function localHour(tz) { try { return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz || 'America/Chicago' }).format(new Date())); } catch { return new Date().getHours(); } }
export function startBackups() {
  if (process.env.BACKUP_DISABLED === '1') return;
  const hour = Number.isFinite(Number(process.env.BACKUP_HOUR)) && process.env.BACKUP_HOUR !== '' ? Number(process.env.BACKUP_HOUR) : 3;
  const tick = () => {
    const s = getSettings(), last = s._backup_last?.at ? Date.parse(s._backup_last.at) : 0, age = Date.now() - last;
    // once a day at the chosen hour (company time zone), or straight away if a day was missed
    if ((age > 20 * 3600e3 && localHour(s.timezone) === hour) || age > 26 * 3600e3) backupNow('daily');
  };
  // the pre-update database copy (made before any table changes) also goes off the server
  if (PRE_UPDATE.file && offsiteOn()) uploadOffsite(PRE_UPDATE.file).catch(e => console.warn('  ⚠  Off-server copy of the pre-update backup failed:', e.message));
  setTimeout(tick, 60e3).unref();
  setInterval(tick, 30 * 60e3).unref();
}
