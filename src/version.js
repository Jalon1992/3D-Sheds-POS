// Which version of the app this install is running (shown on /healthz, the System page and in backups).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
// Railway / Render / most hosts tell the app which git commit it was built from
const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || process.env.SOURCE_COMMIT || process.env.GIT_COMMIT || '').slice(0, 7);
const branch = process.env.RAILWAY_GIT_BRANCH || process.env.RENDER_GIT_BRANCH || process.env.GIT_BRANCH || '';

export const APP_VERSION = {
  version: pkg.version,
  commit: commit || null,
  branch: branch || null,
  /** changes on every deploy (new version or new commit) — used to take a backup before an update */
  id: `${pkg.version}${commit ? '+' + commit : ''}`,
  started_at: new Date().toISOString(),
};
