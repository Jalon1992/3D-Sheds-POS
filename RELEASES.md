# Releasing updates to every company

One repo, one Railway service per company, three branches:

| Branch | What it is | Who deploys from it |
|---|---|---|
| `main` | Where finished, tested work lands (pull requests merge here) | Nobody |
| `pilot` | The next release, trying it out | Your own test install + one friendly company |
| `stable` | The release everyone runs | Every other company |

Every push and pull request runs all the test suites on GitHub (`.github/workflows/test.yml`): API, security, operations, the multi-role walkthrough, every page as every role, and the 3D configurator in a real browser. A failing test stops it there.

## Sending out an update

1. **Test.** Open a pull request into `main`. Wait for the green **tests** check, then merge.
2. **Pilot.** Merge `main` into `pilot`:
   - GitHub: **Pull requests → New** → base `pilot`, compare `main` → **Merge**.
   - The pilot installs update themselves within a few minutes.
   - Open each one and check that it works.
   - Its `/healthz` shows the new `version` and `commit`. **System & backups** shows the same, plus the backup taken just before the update.
3. **Release.** After a day or two with no problems, merge `pilot` into `stable` the same way. Every other company updates.
   - **Do this after hours.** Each company has one running copy (its database is a single file), so each update means a minute or so of downtime while it restarts.
   - Railway waits for `/healthz` to pass before it switches traffic over. A release that can't start, or whose database or login check fails, never replaces the running one.
4. **Undo if needed.** In Railway, open the company's service → **Deployments**, then click **Redeploy** on the previous one.
   - Older code keeps working on the newer database (see the rules below).
   - If data itself went wrong, restore the *pre-update* backup from **System & backups**. GO_LIVE.md, step 9, has the steps.
   - Then fix the problem on `main` and start again at step 1.

**Version numbers:** bump `"version"` in `package.json` for each release (2.1.0 → 2.1.1 for fixes, → 2.2.0 for new features). Each install shows its version and commit in the admin sidebar, on **System & backups** and on `/healthz`.

## Rules for database changes (so an undo always works)

The database is upgraded automatically when a new version starts, right after the pre-update backup.
- **Only add.** New tables, new columns, new indexes. Never rename or remove a column, and never change what an existing column means.
- **New columns need a default**, or must allow empty, so older code that doesn't know them keeps working.
- **Simple "add a column" changes** go in the `ALTER TABLE … ADD COLUMN` list in `src/db.js`. It's re-checked on every start and stays easy to merge.
- **Anything else** goes in the numbered `MIGRATIONS` list in `src/db.js`: moving data, backfills, new indexes. Each step runs once, in order, inside a transaction, and the database records how far it got. If older code later starts on a newer database, it logs that and carries on.

## Turn on branch protection (once)

GitHub → **Settings → Branches → Add rule** for `pilot` and for `stable`:
- **Require a pull request before merging**
- **Require status checks to pass:** pick **tests**

Then nothing untested can reach a company.

## The 3D builder

This repo is the one codebase. A company that only wants the 3D configurator runs it with `MODULES=none`. **Stop adding to 3D-Sheds.** Its latest 3D work (carriage-house doors, panel doors, window heights and grids, double shelves, flat window trim) has been merged in here. Module switches decide what a company sees, not what code it gets, so every update ships the whole app. That's why the pilot step matters: the point of sale uses the 3D side's drawings, pricing and quotes.

## When this stops being enough

Past roughly 10–20 companies, build one tested Docker image in GitHub Actions and push it to every company with a script, instead of each service building on its own.
