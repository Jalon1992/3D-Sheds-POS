// Restore from a backup, first half: check an uploaded backup and unpack it next to the database, ready for the
// restart (src/restore-apply.js swaps it in before the database opens). Used to move a company's setup to a new
// install, or to roll one back. Takes a full backup (.tar.gz from System & backups) or a database file (.db).
import { openSync, readSync, closeSync, rmSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as tar from 'tar';
import { SCHEMA_VERSION } from './db.js';
import { restoreDir } from './restore-apply.js';

const DB_PATH = process.env.DB_PATH || './data/shedbuilder.db';
const TOP = new Set(['shedbuilder.db', 'uploads', 'files']);
const OK_TYPES = new Set(['File', 'OldFile', 'ContiguousFile', 'Directory']);

function head(file, n) { const fd = openSync(file, 'r'); try { const b = Buffer.alloc(n); readSync(fd, b, 0, n, 0); return b; } finally { closeSync(fd); } }
/** Path inside the backup, or null when it could land outside the restore folder. */
function safePath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s) || s.split('/').some(x => x === '..')) return null;
  return TOP.has(s.split('/')[0].replace(/\/$/, '')) ? s : null;
}

/** Checks the database in a backup. Throws a plain-words error when it isn't one we can restore. */
function checkDb(file) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { throw new Error("That file isn't a database this app can read."); }
  try {
    const ok = db.prepare('PRAGMA quick_check').get();
    if (Object.values(ok || {})[0] !== 'ok') throw new Error('The database in that backup is damaged.');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
    for (const t of ['settings', 'users', 'styles', 'options']) if (!tables.has(t)) throw new Error("That isn't a backup of this app (it has no " + t + ' table).');
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    if (schema > SCHEMA_VERSION) throw new Error(`That backup comes from a newer version of the app (database ${schema}, this one is ${SCHEMA_VERSION}). Update this install first, then restore.`);
    const n = t => (tables.has(t) ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0);
    let company = '';
    try { company = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get()?.value || '""'); } catch { /* */ }
    return { schema, company, counts: { styles: n('styles'), options: n('options'), quotes: n('quotes'), contacts: n('contacts'), contracts: n('contracts'), users: n('users') } };
  } finally { db.close(); }
}

/**
 * Unpacks and checks an uploaded backup. On success the restore waits in <data>/.restore-pending until the restart.
 * @returns {{ parts: string[], schema: number, company: string, counts: object }}
 */
export async function stageRestore(file, originalName = '', by = '') {
  const dir = restoreDir(DB_PATH);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  try {
    const h = head(file, 16);
    let parts;
    if (h.subarray(0, 15).toString('latin1') === 'SQLite format 3') {
      renameSync(file, join(dir, 'shedbuilder.db')); parts = ['shedbuilder.db'];
    } else if (h[0] === 0x1f && h[1] === 0x8b) {
      // list first: every entry must be a plain file or folder under shedbuilder.db / uploads / files
      const limit = (Number(process.env.RESTORE_MAX_MB) || 2048) * 1024 * 1024 * 4;
      let total = 0, problem = null; const tops = new Set();
      await tar.t({ file, onReadEntry: e => {
        const p = safePath(e.path);
        if (!p) problem ||= `it contains a file outside the backup folders (${String(e.path).slice(0, 80)})`;
        else if (!OK_TYPES.has(e.type)) problem ||= `it contains a link or special file (${String(e.path).slice(0, 80)})`;
        else { tops.add(p.split('/')[0]); total += Number(e.size) || 0; }
        if (total > limit) problem ||= 'it unpacks to more than this install allows';
      } });
      if (problem) throw new Error(`That backup can't be restored: ${problem}.`);
      if (!tops.has('shedbuilder.db')) throw new Error("That file has no database in it. Use a full backup (.tar.gz) from System & backups.");
      await tar.x({ file, cwd: dir, strict: true, preservePaths: false, filter: (p, e) => !!safePath(p) && OK_TYPES.has(e.type) });
      parts = [...tops].filter(t => TOP.has(t));
    } else throw new Error('That isn\'t a backup file. Upload a full backup (.tar.gz) or a database backup (.db) from System & backups.');
    const info = checkDb(join(dir, 'shedbuilder.db'));
    writeFileSync(join(dir, 'RESTORE.json'), JSON.stringify({ from: String(originalName).slice(0, 200), by, at: new Date().toISOString(), parts, ...info }));
    return { parts, ...info };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
/** Drop a restore that is waiting for the restart. */
export function cancelRestore() { rmSync(restoreDir(DB_PATH), { recursive: true, force: true }); }
