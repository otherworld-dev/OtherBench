import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Copies the database to `<db>.before-schema-<version>` before
 * `runMigrations` moves it to a newer schema, so an update that brings a
 * migration always leaves the old database behind (auto-update spec,
 * docs/superpowers/specs/2026-10-29-auto-update-design.md). `VACUUM INTO`
 * writes a consistent snapshot with the WAL folded in. Only the newest `keep`
 * copies are kept.
 *
 * Nothing is copied for `:memory:`, for a new database (version 0: there is
 * nothing to lose) or for one already at `targetVersion`. Returns the copy's
 * path, or `null` when nothing was copied. A copy that can't be made throws,
 * and the caller must not migrate: going on would leave the newer build
 * holding the only copy of the data.
 */
export function backupBeforeMigration(db: DatabaseSync, dbPath: string, targetVersion: number, keep = 3): string | null {
  if (dbPath === ':memory:') return null;
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current === 0 || current >= targetVersion) return null;

  const copy = `${dbPath}.before-schema-${current}`;
  try {
    // VACUUM INTO refuses an existing file; a copy left by an earlier attempt at the same upgrade is replaced.
    if (lstatSync(copy, { throwIfNoEntry: false })?.isFile()) rmSync(copy);
    db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  } catch (err) {
    throw new Error(
      `Could not copy the database before upgrading it (${err instanceof Error ? err.message : String(err)}). ` +
        `Nothing was changed. Make room or remove "${copy}", then start OtherBench again.`
    );
  }
  prune(dbPath, keep);
  return copy;
}

/** The copies beside `dbPath`, oldest schema first. */
function copiesOf(dbPath: string): { f: string; version: number }[] {
  const name = basename(dbPath);
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.before-schema-(\\d+)$`);
  return readdirSync(dirname(dbPath))
    .map((f) => ({ f, m: pattern.exec(f) }))
    .filter((c): c is { f: string; m: RegExpExecArray } => c.m !== null)
    .map((c) => ({ f: c.f, version: Number(c.m[1]) }))
    .sort((a, b) => a.version - b.version);
}

/**
 * The newest copy beside `dbPath` that a build at `maxVersion` can open (its
 * schema is no newer), or `null`: what a build that can't open the database
 * itself points the user at.
 */
export function newestBackup(dbPath: string, maxVersion: number): string | null {
  if (dbPath === ':memory:' || dbPath === '') return null;
  try {
    const usable = copiesOf(dbPath).filter((c) => c.version <= maxVersion);
    const newest = usable[usable.length - 1];
    return newest ? join(dirname(dbPath), newest.f) : null;
  } catch {
    return null;
  }
}

function prune(dbPath: string, keep: number): void {
  const copies = copiesOf(dbPath);
  for (const { f } of copies.slice(0, Math.max(0, copies.length - keep))) {
    try {
      rmSync(join(dirname(dbPath), f));
    } catch {
      // An old copy that can't be removed now is tried again on the next upgrade.
    }
  }
}
