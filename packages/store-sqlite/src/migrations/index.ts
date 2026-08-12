import type { DatabaseSync } from 'node:sqlite';
import { MIGRATION_001_INITIAL } from './001-initial.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [{ version: 1, name: '001-initial', sql: MIGRATION_001_INITIAL }];

/**
 * Applies every migration in `migrations` (defaults to {@link MIGRATIONS})
 * whose version is greater than the database's current `PRAGMA user_version`,
 * in ascending version order. Each migration runs inside its own transaction:
 * a failure rolls back that migration's statements entirely and the error
 * propagates, leaving `user_version` at whatever it was before that
 * migration started. Re-running with nothing pending is a no-op.
 */
export function runMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const currentVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;

  for (const migration of sorted) {
    if (migration.version <= currentVersion) continue;

    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
