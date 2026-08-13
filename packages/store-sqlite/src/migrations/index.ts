import type { DatabaseSync } from 'node:sqlite';
import { MIGRATION_001_INITIAL } from './001-initial.js';
import { MIGRATION_002_GRANT_SOURCE } from './002-grant-source.js';
import { MIGRATION_003_MCP_ENV_REFS } from './003-mcp-env-refs.js';
import type { Migration } from './types.js';

export type { Migration } from './types.js';

export const MIGRATIONS: Migration[] = [
  { version: 1, name: '001-initial', sql: MIGRATION_001_INITIAL },
  { version: 2, name: '002-grant-source', sql: MIGRATION_002_GRANT_SOURCE },
  MIGRATION_003_MCP_ENV_REFS,
];

/**
 * Applies every migration in `migrations` (defaults to {@link MIGRATIONS})
 * whose version is greater than the database's current `PRAGMA user_version`,
 * in ascending version order. Each migration's `sql`/`run` (see
 * {@link Migration}) execute inside their own transaction: a failure rolls
 * back that migration's statements entirely and the error propagates,
 * leaving `user_version` at whatever it was before that migration started.
 * A migration's `postCommit`, if any, then runs immediately after --
 * outside that transaction, since SQLite refuses some statements
 * (`VACUUM`, `PRAGMA wal_checkpoint`) inside one. Re-running with nothing
 * pending is a no-op.
 */
export function runMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const currentVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;

  for (const migration of sorted) {
    if (migration.version <= currentVersion) continue;

    db.exec('BEGIN');
    try {
      if (migration.sql) db.exec(migration.sql);
      migration.run?.(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    migration.postCommit?.(db);
  }
}
