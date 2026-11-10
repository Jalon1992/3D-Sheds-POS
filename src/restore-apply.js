// Restoring a backup happens in two halves. The upload (src/restore.js) checks the file and unpacks it into
// <data>/.restore-pending, then the app restarts. On the next start this runs BEFORE the database is opened:
// the waiting database (and uploads / files folders, when the backup has them) replace the current ones.
// Nothing here imports the database, so it can run first.
import { existsSync, readFileSync, rmSync, renameSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const restoreDir = dbPath => join(dirname(dbPath), '.restore-pending');
export const uploadsDir = () => resolve(process.env.UPLOAD_DIR || './uploads');
export const filesDir = dbPath => resolve(process.env.FILES_DIR || join(dirname(dbPath), 'files'));

function move(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  try { renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e; // different disks: copy, then remove
    cpSync(from, to, { recursive: true }); rmSync(from, { recursive: true, force: true });
  }
}

/** @returns the restore's details when one was applied, else null */
export function applyPendingRestore(dbPath) {
  const dir = restoreDir(dbPath), marker = join(dir, 'RESTORE.json');
  if (!existsSync(marker) || !existsSync(join(dir, 'shedbuilder.db'))) return null;
  let info = {};
  try { info = JSON.parse(readFileSync(marker, 'utf8')); } catch { /* still restore the database */ }
  const parts = Array.isArray(info.parts) ? info.parts : ['shedbuilder.db'];
  for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  move(join(dir, 'shedbuilder.db'), dbPath);
  if (parts.includes('uploads') && existsSync(join(dir, 'uploads'))) move(join(dir, 'uploads'), uploadsDir());
  if (parts.includes('files') && existsSync(join(dir, 'files'))) move(join(dir, 'files'), filesDir(dbPath));
  rmSync(dir, { recursive: true, force: true });
  console.log(`  Restored the backup ${info.from || ''} (${parts.join(', ')}).`);
  return { ...info, parts, applied_at: new Date().toISOString() };
}
