// Admin sessions (signed cookies) + API keys.
import crypto from 'node:crypto';
import { get, run, getSettings, setSettings } from './db.js';

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = getSettings()._session_secret;
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSettings({ _session_secret: s }); }
  return s;
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

const COOKIE = 'sb_session';
const TTL = 1000 * 60 * 60 * 24 * 14; // 14 days

export function issueSession(res, userId) {
  const exp = Date.now() + TTL;
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sig}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${TTL / 1000}${secure}`);
}
export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [uid, exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!uid || !exp || !sig || Number(exp) < Date.now()) return null;
  const expect = crypto.createHmac('sha256', secret()).update(`${uid}.${exp}`).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  return get("SELECT id, email, name, phone, COALESCE(role, 'admin') AS role, dealer_id, notify_sms, notify_email FROM users WHERE id = ? AND COALESCE(active, 1) = 1", Number(uid)) || null;
}

// ---- API keys ----------------------------------------------------------------
export function createApiKey(name) {
  const key = 'sb_live_' + crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const r = run('INSERT INTO api_keys (name, prefix, key_hash) VALUES (?, ?, ?)', name || 'API key', key.slice(0, 12), hash);
  return { id: Number(r.lastInsertRowid), key, prefix: key.slice(0, 12) };
}
function readApiKey(req) {
  let key = req.headers['x-api-key'];
  const auth = req.headers.authorization || '';
  if (!key && auth.startsWith('Bearer ')) key = auth.slice(7).trim();
  if (!key) return null;
  const hash = crypto.createHash('sha256').update(String(key)).digest('hex');
  const row = get('SELECT * FROM api_keys WHERE key_hash = ?', hash);
  if (row) run("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?", row.id);
  return row || null;
}

/** Roles: admin (everything), sales (CRM, quotes, contracts), production (orders board + drawings),
 *  delivery (delivery schedule + drawings). Non-admin roles can be limited to one dealer lot.
 *  Fine-grained checks for the CRM / point of sale live in permissions.js. */
export const ROLES = ['admin', 'sales', 'production', 'delivery'];
const QUOTE_READ = /^\/quotes(\/\d+(\/floorplan\.svg)?)?$/;
function roleAllows(user, method, path) {
  if (user.role === 'admin') return true;
  if (method === 'GET' && QUOTE_READ.test(path)) return true;
  if (user.role === 'sales' && method === 'PATCH' && /^\/quotes\/\d+$/.test(path)) return true;
  return false;
}

/** Admin UI session OR a valid API key. */
export function requireAuth(req, res, next) {
  const user = readSession(req);
  if (user) {
    req.user = user;
    if (!roleAllows(user, req.method, req.path)) return res.status(403).json({ error: 'Your account does not have access to this.' });
    return next();
  }
  const key = readApiKey(req);
  if (key) { req.apiKey = key; return next(); }
  res.status(401).json({ error: 'Unauthorized. Log in or send an API key in the X-API-Key header.' });
}
export function requireSession(req, res, next) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user; next();
}
export { readSession, readApiKey };
