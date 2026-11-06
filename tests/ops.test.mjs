// Operations: health check, version, backups (before updates, full, off-server to S3-compatible storage),
// database version tracking, clean shutdown. Run: node --test tests/ops.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { sigV4 } from '../src/backup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dirs = [];
after(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });

function boot(dir, env = {}) {
  const port = 5500 + Math.floor(Math.random() * 400), B = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: port, DB_PATH: join(dir, 'data', 'shedbuilder.db'), UPLOAD_DIR: join(dir, 'uploads'), MESSAGING_TEST_MODE: '1', ADMIN_EMAIL: 'owner@test.com', ADMIN_PASSWORD: 'owner-pass-1', DEVOPS_EMAIL: 'dev@builder.test', DEVOPS_PASSWORD: 'dev-secret-123', BACKUP_S3_ENDPOINT: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', d => (log += d)); proc.stderr.on('data', d => (log += d));
  const exited = new Promise(r => proc.on('exit', (code, sig) => r({ code, sig })));
  return { B, proc, log: () => log, exited,
    ready: async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(B + '/healthz')).status < 600) return; } catch { /* */ } await sleep(150); } throw new Error('no start\n' + log); },
    stop: async () => { proc.kill('SIGTERM'); return exited; } };
}
async function login(B, email, password) {
  const r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0];
}
const newDir = () => { const d = mkdtempSync(join(tmpdir(), 'shedops-')); dirs.push(d); return d; };

test('request signing for off-server backups matches AWS\'s published Signature V4 example', () => {
  const emptyHash = crypto.createHash('sha256').update('').digest('hex');
  const auth = sigV4({ method: 'GET', path: '/', headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' }, payloadHash: emptyHash, region: 'us-east-1', service: 'service', accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z' });
  assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('health check: database + login checks, version and commit; fails (503) when no admin can log in', async () => {
  const dir = newDir(); const s = boot(dir, { RAILWAY_GIT_COMMIT_SHA: 'abc1234def', BACKUP_DISABLED: '1' }); await s.ready();
  try {
    const h = await (await fetch(s.B + '/healthz')).json();
    assert.equal(h.ok, true); assert.equal(h.version, PKG.version); assert.equal(h.commit, 'abc1234'); assert.ok(h.schema >= 2);
    assert.deepEqual(h.checks, { database: true, login: true });
    const me = await (await fetch(s.B + '/api/auth/me', { headers: { cookie: await login(s.B, 'owner@test.com', 'owner-pass-1') } })).json();
    assert.equal(me.version, `${PKG.version}+abc1234`, 'admin sidebar shows the version');
    const db = new DatabaseSync(join(dir, 'data', 'shedbuilder.db'));
    db.exec("UPDATE users SET active = 0 WHERE COALESCE(role, 'admin') = 'admin'");
    const bad = await fetch(s.B + '/healthz'); assert.equal(bad.status, 503); assert.equal((await bad.json()).checks.login, false);
    db.exec('UPDATE users SET active = 1'); db.close();
    assert.equal((await fetch(s.B + '/healthz')).status, 200);
  } finally { await s.stop(); }
});

test('updates: the database is copied before an update (before any table changes), not on a plain restart', async () => {
  const dir = newDir();
  let s = boot(dir, { RAILWAY_GIT_COMMIT_SHA: '1111111aaa' }); await s.ready(); await s.stop();
  const bdir = join(dir, 'data', 'backups'); const pre = () => (existsSync(bdir) ? readdirSync(bdir).filter(f => f.startsWith('pre-update')) : []);
  assert.equal(pre().length, 0, 'brand-new install: nothing to back up');
  s = boot(dir, { RAILWAY_GIT_COMMIT_SHA: '1111111aaa' }); await s.ready(); await s.stop();
  assert.equal(pre().length, 0, 'same version restarted: no backup');
  s = boot(dir, { RAILWAY_GIT_COMMIT_SHA: '2222222bbb' }); await s.ready();
  try {
    assert.equal(pre().length, 1, 'new version: one backup first'); assert.match(pre()[0], /from-.*1111111/);
    const copy = new DatabaseSync(join(bdir, pre()[0])); assert.ok(copy.prepare('SELECT COUNT(*) n FROM users').get().n >= 1, 'the copy is a working database'); copy.close();
    assert.match(s.log(), /Backed up the database before updating/);
    // the developer sees it on the System page
    const sys = await (await fetch(s.B + '/api/admin/system', { headers: { cookie: await login(s.B, 'dev@builder.test', 'dev-secret-123') } })).json();
    assert.ok(sys.pre_update && sys.backups.some(b => b.kind === 'before update'));
  } finally { await s.stop(); }
});

test('database versions: migrations run once and are tracked; older code on a newer database still starts (undo an update)', async () => {
  const dir = newDir(); let s = boot(dir, { BACKUP_DISABLED: '1' }); await s.ready(); await s.stop();
  const f = join(dir, 'data', 'shedbuilder.db');
  let db = new DatabaseSync(f); const v = db.prepare('PRAGMA user_version').get().user_version;
  assert.ok(v >= 2, 'schema tracked: ' + v);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_quotes_created'").get(), 'migration applied');
  db.exec('PRAGMA user_version = 99'); db.close(); // pretend a newer release already ran
  s = boot(dir, { BACKUP_DISABLED: '1' }); await s.ready();
  try {
    assert.match(s.log(), /newer than this version of the app/);
    const h = await (await fetch(s.B + '/healthz')).json(); assert.equal(h.ok, true); assert.equal(h.schema, 99);
  } finally { await s.stop(); }
  db = new DatabaseSync(f); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99, 'never moved backwards'); db.close();
});

test('full backup: database + models/images + contracts in one file, copied off the server to S3-compatible storage; developer-only download', async () => {
  // a stand-in S3 bucket that checks the signature like the real thing
  const got = [];
  const s3 = http.createServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { got.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(200); res.end(); }); });
  await new Promise(r => s3.listen(0, '127.0.0.1', r)); const S3 = `http://127.0.0.1:${s3.address().port}`;
  const dir = newDir(); mkdirSync(join(dir, 'uploads'), { recursive: true }); writeFileSync(join(dir, 'uploads', 'door.glb'), 'glTF-pretend-model');
  const s = boot(dir, { BACKUP_S3_ENDPOINT: S3, BACKUP_S3_BUCKET: 'shed-backups', BACKUP_S3_ACCESS_KEY: 'AKTEST', BACKUP_S3_SECRET_KEY: 'secret/KEY', BACKUP_S3_REGION: 'auto', BACKUP_S3_PREFIX: 'trimline' });
  await s.ready();
  try {
    const dev = await login(s.B, 'dev@builder.test', 'dev-secret-123'), owner = await login(s.B, 'owner@test.com', 'owner-pass-1');
    assert.equal((await fetch(s.B + '/api/admin/system/backup', { method: 'POST', headers: { cookie: owner } })).status, 403, 'customer admin can\'t (developer login exists)');
    const r = await (await fetch(s.B + '/api/admin/system/backup', { method: 'POST', headers: { cookie: dev } })).json();
    assert.equal(r.error, null, JSON.stringify(r)); assert.ok(r.size > 1000); assert.equal(r.offsite.ok, true);
    // the archive holds everything
    const file = join(dir, 'data', 'backups', r.name), out = join(dir, 'restore'); mkdirSync(out);
    await tar.x({ file, cwd: out });
    assert.ok(existsSync(join(out, 'shedbuilder.db')) && existsSync(join(out, 'uploads', 'door.glb')) && existsSync(join(out, 'files', 'templates')), 'db + uploads + contract files');
    const rdb = new DatabaseSync(join(out, 'shedbuilder.db')); assert.ok(rdb.prepare('SELECT COUNT(*) n FROM styles').get().n > 0, 'restored database opens with the catalog'); rdb.close();
    assert.ok(!readdirSync(join(dir, 'data', 'backups')).some(f => f.startsWith('.staging')), 'temporary files cleaned up');
    // the bucket got exactly that file, signed correctly
    const put = got.find(g => g.method === 'PUT'); assert.ok(put, 'uploaded');
    assert.equal(put.url, `/shed-backups/trimline/${r.name}`);
    assert.ok(put.body.equals(readFileSync(file)), 'same bytes');
    assert.equal(put.headers['x-amz-content-sha256'], crypto.createHash('sha256').update(put.body).digest('hex'));
    const expect = sigV4({ method: 'PUT', path: put.url, headers: { host: put.headers.host, 'x-amz-content-sha256': put.headers['x-amz-content-sha256'], 'x-amz-date': put.headers['x-amz-date'] }, payloadHash: put.headers['x-amz-content-sha256'], region: 'auto', accessKey: 'AKTEST', secretKey: 'secret/KEY', amzDate: put.headers['x-amz-date'] });
    assert.equal(put.headers.authorization, expect);
    // download: developer only, names checked
    const dl = await fetch(s.B + '/api/admin/system/backups/' + encodeURIComponent(r.name), { headers: { cookie: dev } });
    assert.equal(dl.status, 200); assert.ok(Buffer.from(await dl.arrayBuffer()).equals(readFileSync(file)));
    assert.equal((await fetch(s.B + '/api/admin/system/backups/' + encodeURIComponent(r.name), { headers: { cookie: owner } })).status, 403);
    for (const n of ['..%2Fshedbuilder.db', 'shedbuilder.db', 'backup-x.tar.gz%2F..%2F..%2Fx']) assert.equal((await fetch(s.B + '/api/admin/system/backups/' + n, { headers: { cookie: dev } })).status, 404, n);
    const h = await (await fetch(s.B + '/healthz')).json(); assert.equal(h.last_backup.ok, true);
    // a bucket that refuses the upload is reported, and the local backup is still kept
    s3.removeAllListeners('request'); s3.on('request', (req, res) => { req.resume(); req.on('end', () => { res.writeHead(403); res.end('<Error>AccessDenied</Error>'); }); });
    const r2 = await (await fetch(s.B + '/api/admin/system/backup', { method: 'POST', headers: { cookie: dev } })).json();
    assert.equal(r2.offsite.ok, false); assert.match(r2.error, /403/); assert.ok(existsSync(join(dir, 'data', 'backups', r2.name)), 'local copy kept');
    const sys = await (await fetch(s.B + '/api/admin/system', { headers: { cookie: dev } })).json(); assert.match(sys.last.error, /403/, 'System page shows the problem');
  } finally { await s.stop(); s3.close(); }
});

test('redeploys: SIGTERM closes cleanly (exit 0) and the database is intact afterwards', async () => {
  const dir = newDir(); const s = boot(dir, { BACKUP_DISABLED: '1' }); await s.ready();
  const owner = await login(s.B, 'owner@test.com', 'owner-pass-1');
  const es = fetch(s.B + '/api/crm/stream', { headers: { cookie: owner } }).catch(() => null); // an open live-update stream
  await sleep(300);
  const t = Date.now(); const { code } = await s.stop();
  assert.equal(code, 0); assert.ok(Date.now() - t < 9500, 'stops within the deploy window');
  void es;
  const db = new DatabaseSync(join(dir, 'data', 'shedbuilder.db')); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); db.close();
});
