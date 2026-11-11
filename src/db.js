// SQLite storage using Node's built-in node:sqlite (no native build step needed).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { APP_VERSION } from './version.js';
import { applyPendingRestore } from './restore-apply.js';

const DB_PATH = process.env.DB_PATH || './data/shedbuilder.db';
mkdirSync(dirname(DB_PATH), { recursive: true });
// a backup uploaded on System & backups is swapped in here, before the database opens (then migrations bring it up to date)
export const RESTORED = applyPendingRestore(DB_PATH);
const existed = existsSync(DB_PATH);
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
export const BACKUP_DIR = process.env.BACKUP_DIR || join(dirname(DB_PATH), 'backups');

// ---- Backup before an update: when this install starts on a different version than last time, copy the
// database BEFORE any table changes run, so an update can always be undone with the data as it was.
export const PRE_UPDATE = { file: null, from: null };
if (existed && process.env.BACKUP_DISABLED !== '1') {
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key = '_app_version'").get()?.value;
    const prev = raw ? JSON.parse(raw) : null;
    if (prev !== APP_VERSION.id) {
      mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const f = join(BACKUP_DIR, `pre-update-${stamp}-from-${String(prev || 'unknown').replace(/[^\w.+-]/g, '_')}.db`);
      db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
      Object.assign(PRE_UPDATE, { file: f, from: prev || 'unknown' });
      console.log(`  Backed up the database before updating (${prev || 'unknown'} → ${APP_VERSION.id}): ${f}`);
    }
  } catch (e) { if (!/no such table/.test(e.message)) console.warn('  ⚠  Pre-update backup failed:', e.message); }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS styles (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, image_url TEXT,
  roof_type TEXT DEFAULT 'gable',            -- gable | barn | lean_to | saltbox
  ridge_axis TEXT DEFAULT 'depth',           -- depth: gable end faces front; width: eave faces front
  wall_height REAL DEFAULT 7, roof_pitch REAL DEFAULT 6, overhang REAL DEFAULT 0.75,
  siding_type TEXT DEFAULT 'lp_smartside',   -- lp_smartside | lap | board_batten | t111 | metal
  roof_material TEXT DEFAULT 'shingle',      -- default/included roofing: shingle | metal
  roof_choices TEXT DEFAULT '["shingle","metal"]', -- roofing materials customers may pick
  gable_overhang REAL,                       -- rake overhang at gable ends (null = same as eave)
  standard_options TEXT DEFAULT '[]',        -- JSON [{option_id, wall, offset}]
  default_colors TEXT DEFAULT '{}',          -- JSON {siding, trim, roof, door}
  active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS sizes (
  id INTEGER PRIMARY KEY, style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  width REAL NOT NULL, depth REAL NOT NULL, price REAL NOT NULL DEFAULT 0,
  active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS colors (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, hex TEXT NOT NULL,
  category TEXT NOT NULL,                    -- siding | trim | roof | door | window
  material TEXT,                             -- roof colors only: shingle | metal | null (both)
  price REAL DEFAULT 0, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS options (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  category TEXT NOT NULL,                    -- doors | windows | interior | electrical | exterior | upgrades
  kind TEXT,                                 -- built-in 3D model type (see README)
  placement TEXT DEFAULT 'opening',          -- opening | wall_interior | wall_exterior | floor | ceiling | loft | ground | roof | none
  swap_group TEXT,                           -- options in the same group can be swapped for each other
  width REAL DEFAULT 3, height REAL DEFAULT 6.5, depth REAL DEFAULT 0.3, elevation REAL DEFAULT 0,
  price REAL DEFAULT 0,
  price_unit TEXT DEFAULT 'each',            -- each | per_ft_width | per_ft_depth | per_sqft | per_ft_perimeter
  model_url TEXT, image_url TEXT, plan_label TEXT,
  max_qty INTEGER DEFAULT 10,
  active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY, number TEXT UNIQUE, token TEXT UNIQUE, status TEXT DEFAULT 'new',
  first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT, notes TEXT, sms_consent INTEGER DEFAULT 0,
  source TEXT, utm TEXT,
  config TEXT NOT NULL, pricing TEXT NOT NULL, total REAL,
  style_name TEXT, size_label TEXT,
  ghl_contact_id TEXT, ghl_opportunity_id TEXT, ghl_status TEXT,
  internal_notes TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY, name TEXT, url TEXT NOT NULL,
  events TEXT DEFAULT '["quote.created"]', secret TEXT, headers TEXT DEFAULT '{}',
  active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY, webhook_id INTEGER, target TEXT, event TEXT, status INTEGER,
  ok INTEGER, attempt INTEGER, response TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY, name TEXT, prefix TEXT, key_hash TEXT UNIQUE,
  scopes TEXT DEFAULT 'full', last_used TEXT, created_at TEXT DEFAULT (datetime('now')));

-- ===== CRM =====
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, phone TEXT, phone_e164 TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT, company TEXT,
  source TEXT, tags TEXT DEFAULT '[]', assigned_to INTEGER, dealer_id TEXT,
  sms_consent INTEGER DEFAULT 0, dnd_sms INTEGER DEFAULT 0, dnd_email INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0, last_message_at TEXT, last_activity_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS ix_contacts_phone ON contacts(phone_e164);

CREATE TABLE IF NOT EXISTS pipelines (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT 'sales',   -- sales | orders
  stages TEXT NOT NULL DEFAULT '[]', sort INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  quote_id INTEGER, pipeline_id INTEGER, stage TEXT, title TEXT, value REAL DEFAULT 0,
  status TEXT DEFAULT 'open',                 -- open | won | lost
  sale_type TEXT, assigned_to INTEGER, dealer_id TEXT,
  delivery_date TEXT, delivery_window TEXT, delivery_driver INTEGER, delivery_notes TEXT, production_notes TEXT,
  serial_number TEXT, contract_id INTEGER, order_number TEXT,
  stage_changed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_opps_contact ON opportunities(contact_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,                      -- sms | email
  direction TEXT NOT NULL,                    -- out | in
  to_addr TEXT, from_addr TEXT, subject TEXT, body TEXT,
  status TEXT,                                -- sent | delivered | failed | received | test
  error TEXT, provider TEXT, provider_id TEXT, user_id INTEGER, contract_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_msgs_contact ON messages(contact_id);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE, opportunity_id INTEGER,
  type TEXT NOT NULL,                         -- note | call | stage | quote | contract | task | system
  body TEXT, user_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_act_contact ON activities(contact_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE, opportunity_id INTEGER,
  title TEXT NOT NULL, due_at TEXT, assigned_to INTEGER, done_at TEXT, created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, channel TEXT DEFAULT 'sms', subject TEXT, body TEXT,
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER, roles TEXT, type TEXT, title TEXT, body TEXT, link TEXT,
  read_by TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')));

-- ===== Point of sale =====
CREATE TABLE IF NOT EXISTS contract_templates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sale_type TEXT DEFAULT 'cash',  -- cash | rto | any
  file TEXT, file_name TEXT, pages TEXT DEFAULT '[]', fields TEXT DEFAULT '[]',
  append_drawings INTEGER DEFAULT 1, initial_drawings INTEGER DEFAULT 1, active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY, number TEXT UNIQUE, quote_id INTEGER, contact_id INTEGER, opportunity_id INTEGER,
  template_id INTEGER, template_name TEXT, sale_type TEXT, status TEXT DEFAULT 'draft',  -- draft | sent | viewed | partial | completed | void
  data TEXT DEFAULT '{}', fields TEXT DEFAULT '[]', pages TEXT DEFAULT '[]',
  prepared_file TEXT, prepared_hash TEXT, signed_file TEXT, signed_hash TEXT,
  total REAL, dealer_id TEXT, created_by INTEGER,
  sent_at TEXT, completed_at TEXT, voided_at TEXT, void_reason TEXT, expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS contract_signers (
  id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                         -- customer | cobuyer | company
  name TEXT, email TEXT, phone TEXT, token TEXT UNIQUE, status TEXT DEFAULT 'pending',  -- pending | viewed | signed
  user_id INTEGER, values_json TEXT DEFAULT '{}', viewed_at TEXT, signed_at TEXT, consent_at TEXT, ip TEXT, user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS contract_events (
  id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE, signer_id INTEGER,
  event TEXT, detail TEXT, ip TEXT, user_agent TEXT, user_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
`);

// ---- Migrations for databases created by earlier versions (safe to re-run)
for (const sql of [
  'ALTER TABLE styles ADD COLUMN gable_overhang REAL',
  `ALTER TABLE styles ADD COLUMN roof_choices TEXT DEFAULT '["shingle","metal"]'`,
  'ALTER TABLE colors ADD COLUMN material TEXT',
  'ALTER TABLE styles ADD COLUMN fascia_size REAL',
  'ALTER TABLE styles ADD COLUMN rake_size REAL',
  'ALTER TABLE styles ADD COLUMN corner_trim REAL',
  'ALTER TABLE styles ADD COLUMN casing_trim REAL',
  'ALTER TABLE styles ADD COLUMN roof_pitch_lower REAL',
  'ALTER TABLE styles ADD COLUMN gambrel_break REAL',
  'ALTER TABLE styles ADD COLUMN metal_rake_size REAL',
  'ALTER TABLE styles ADD COLUMN metal_rake_leg REAL',
  `ALTER TABLE styles ADD COLUMN trim_type TEXT DEFAULT 'lp'`,
  'ALTER TABLE styles ADD COLUMN gambrel_lower_len REAL',
  'ALTER TABLE styles ADD COLUMN roof_pitch_back REAL',
  `ALTER TABLE styles ADD COLUMN roof_edge TEXT DEFAULT 'metal_rake'`,
  'ALTER TABLE styles ADD COLUMN rake_cap_size REAL',
  'ALTER TABLE styles ADD COLUMN drip_edge_size REAL',
  `ALTER TABLE styles ADD COLUMN drip_edge_color TEXT DEFAULT 'roof'`,
  `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'`,
  'ALTER TABLE users ADD COLUMN dealer_id TEXT',
  'ALTER TABLE quotes ADD COLUMN dealer_id TEXT',
  'ALTER TABLE quotes ADD COLUMN dealer_name TEXT',
  'ALTER TABLE quotes ADD COLUMN price_tier TEXT',
  'ALTER TABLE quotes ADD COLUMN pricing_zip TEXT',
  'ALTER TABLE styles ADD COLUMN available_options TEXT',
  `ALTER TABLE options ADD COLUMN gable_mode TEXT DEFAULT ''`,
  'ALTER TABLE styles ADD COLUMN gambrel_upper_len REAL',
  'ALTER TABLE styles ADD COLUMN rake_tail TEXT',
  'ALTER TABLE sizes ADD COLUMN hip_len REAL',
  'ALTER TABLE sizes ADD COLUMN upper_len REAL',
  'ALTER TABLE styles ADD COLUMN skid_count INTEGER',                // skids under the floor; null = automatic (about one per 4 ft of width)
  'ALTER TABLE styles ADD COLUMN skid_spacing REAL',                 // centre-to-centre, inches; null = spread edge to edge
  'ALTER TABLE sizes ADD COLUMN skid_count INTEGER',                 // per-size overrides of the two above
  'ALTER TABLE sizes ADD COLUMN skid_spacing REAL',
  'ALTER TABLE options ADD COLUMN package_items TEXT',
  'ALTER TABLE options ADD COLUMN package_only INTEGER DEFAULT 0',
  'ALTER TABLE quotes ADD COLUMN contact_id INTEGER',
  'ALTER TABLE users ADD COLUMN phone TEXT',
  'ALTER TABLE users ADD COLUMN notify_sms INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN notify_email INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1',
  'ALTER TABLE users ADD COLUMN is_devops INTEGER DEFAULT 0',
  'ALTER TABLE quotes ADD COLUMN pdf_file TEXT',
  'ALTER TABLE quotes ADD COLUMN pdf_token TEXT',
  'ALTER TABLE quotes ADD COLUMN ghl_pdf_url TEXT',
  'ALTER TABLE users ADD COLUMN session_ver INTEGER DEFAULT 0',
  'ALTER TABLE contracts ADD COLUMN group_id INTEGER',
  'ALTER TABLE contracts ADD COLUMN revision INTEGER DEFAULT 1',
  'ALTER TABLE contracts ADD COLUMN superseded_by INTEGER',
  'ALTER TABLE contracts ADD COLUMN superseded_at TEXT',
  'ALTER TABLE contracts ADD COLUMN prev_status TEXT',
  'ALTER TABLE contracts ADD COLUMN change_note TEXT',
  "ALTER TABLE contracts ADD COLUMN payload TEXT DEFAULT '{}'",
  'ALTER TABLE options ADD COLUMN grid_top TEXT',
  'ALTER TABLE options ADD COLUMN grid_bottom TEXT',
  'ALTER TABLE options ADD COLUMN length_choices TEXT',
  'ALTER TABLE options ADD COLUMN only_styles TEXT',                 // JSON list of style ids; null = every style
  'ALTER TABLE styles ADD COLUMN overhang_right REAL',               // deeper eave on the second (right) side; null = same as overhang
]) { try { db.exec(sql); } catch { /* column already exists */ } }

// One-time data fixes for existing databases
try {
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migr_flat_window_trim'").get()) {
    // windows now have a flat bottom casing (no sill) - drop the default flower box so it sits under the trim
    db.prepare("UPDATE options SET elevation = 2.4 WHERE kind = 'flowerbox' AND elevation = 2.7").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('migr_flat_window_trim', 'true')").run();
  }
} catch { /* settings table not ready */ }
// (catalog upgrades for older databases - new doors / shelves - live in seed.js upgradeCatalog())

// ---- Numbered migrations (tracked with PRAGMA user_version). The list above is for simple "add a column"
// changes and is re-checked on every start; anything else (moving data, new indexes, backfills) goes here,
// runs exactly once, in order, inside a transaction.
// RULES so an update can be undone by redeploying the previous version:
//   · only ADD tables/columns/indexes — never rename or drop a column, never change what an existing one means;
//   · new columns need a default (or allow NULL) so older code that doesn't know them keeps working.
const MIGRATIONS = [
  /* 1 */ () => db.exec('CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at)'),
  /* 2 */ () => db.exec('CREATE INDEX IF NOT EXISTS idx_quotes_contact ON quotes(contact_id)'),
];
export const SCHEMA_VERSION = MIGRATIONS.length;
const dbVersion = () => db.prepare('PRAGMA user_version').get().user_version;
for (let v = dbVersion(); v < MIGRATIONS.length; v++) {
  db.exec('BEGIN');
  try { MIGRATIONS[v](); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); console.error(`  ✖  Database migration ${v + 1} failed:`, e.message); throw e; }
}
export const DB_SCHEMA = dbVersion();
// Running older code on a newer database (after an undo) is fine as long as the rules above were followed.
if (DB_SCHEMA > SCHEMA_VERSION) console.warn(`  ⚠  This database (schema ${DB_SCHEMA}) is newer than this version of the app (schema ${SCHEMA_VERSION}). That's expected right after undoing an update.`);

// ---- JSON column helpers -----------------------------------------------------
export const JSON_COLS = new Set(['standard_options', 'default_colors', 'roof_choices', 'available_options', 'only_styles', 'package_items', 'roofing', 'price_tiers', 'dealers', 'zip_tiers', 'events', 'headers', 'config', 'pricing', 'utm',
  'tags', 'stages', 'pages', 'fields', 'data', 'values_json', 'roles', 'read_by', 'payload']);

export function parseRow(row) {
  if (!row) return row;
  const r = { ...row };
  for (const k of Object.keys(r)) if (JSON_COLS.has(k) && typeof r[k] === 'string') {
    try { r[k] = JSON.parse(r[k]); } catch { /* leave as string */ }
  }
  return r;
}
export const all = (sql, ...p) => db.prepare(sql).all(...p).map(parseRow);
export const get = (sql, ...p) => parseRow(db.prepare(sql).get(...p));
export const run = (sql, ...p) => db.prepare(sql).run(...p);

// ---- Settings ---------------------------------------------------------------
export function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}
export function setSettings(obj) {
  const st = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(obj)) st.run(k, JSON.stringify(v));
}

// Settings that are safe to expose to the public configurator
export const PUBLIC_SETTINGS = ['company_name', 'logo_url', 'brand_color', 'currency_symbol', 'tax_rate', 'tax_delivery',
  'delivery_fee', 'show_prices', 'success_message', 'consent_text', 'phone', 'website', 'privacy_url', 'require_phone',
  'headline', 'thank_you_url', 'roofing', 'downgrade_credit', 'remove_credit', 'color_groups',
  'pricing_mode', 'price_tiers', 'default_tier', 'dealers', 'zip_tiers', 'customer_pdf', 'quote_terms', 'customer_window_height'];

// ---- Catalog (what the configurator needs) ----------------------------------
export function getCatalog({ includeInactive = false } = {}) {
  const act = includeInactive ? '' : 'WHERE active = 1';
  const styles = all(`SELECT * FROM styles ${act} ORDER BY sort, id`);
  const sizes = all(`SELECT * FROM sizes ${act} ORDER BY sort, width, depth`);
  for (const s of styles) s.sizes = sizes.filter(z => z.style_id === s.id);
  const colors = all(`SELECT * FROM colors ${act} ORDER BY category, sort, id`);
  const options = all(`SELECT * FROM options ${act} ORDER BY category, sort, id`);
  const all_settings = getSettings();
  const settings = Object.fromEntries(PUBLIC_SETTINGS.map(k => [k, all_settings[k]]));
  return { styles: styles.filter(s => includeInactive || s.sizes.length), colors, options, settings };
}
